import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "./token-estimator";
import { getObservationCursor, getReflectionTokenTotal, selectOldestRawMessageBatch } from "./memory-queues";
import type { ObservationState, ObservationalMemoryConfig } from "./types";

export interface OmContextThresholds {
	contextWindow: number;
	observationTriggerPercent: number;
	observationTargetPercent: number;
	observationTriggerTokens: number;
	observationTargetTokens: number;
	reflectionTriggerPercent: number;
	reflectionTargetPercent: number;
	reflectionTriggerTokens: number;
	reflectionTargetTokens: number;
	reflectionRefreshTriggerPercent: number;
	reflectionRefreshTriggerTokens: number;
}

export interface PendingObservationBatch {
	messages: AgentMessage[];
	startIndex: number;
	endIndex: number;
	tokens: number;
}

export interface PendingObservationSlice {
	rawCursorIndex: number;
	cursorIndex: number;
	cursorWasClamped: boolean;
	cursorWasRealigned: boolean;
	unobservedMessages: AgentMessage[];
	unobservedTokens: number;
	batch: PendingObservationBatch | null;
}

export interface OmContextPressureSnapshot {
	runtimePercent: number | null;
	estimatedPercent: number | null;
	effectivePercent: number | null;
	contextTokens: number | null;
}

function normalizeToolCallIdVariants(rawId: string): string[] {
	const trimmed = rawId.trim();
	if (!trimmed) return [];
	const base = trimmed.split("|")[0];
	return base === trimmed ? [trimmed] : [trimmed, base];
}

function extractAssistantToolCallIds(message: AgentMessage): string[] {
	const msg = message as any;
	if (msg?.role !== "assistant" || !Array.isArray(msg?.content)) {
		return [];
	}
	const ids: string[] = [];
	for (const item of msg.content) {
		if (item?.type === "toolCall" && typeof item.id === "string" && item.id.trim()) {
			ids.push(item.id.trim());
		}
	}
	return ids;
}

function extractToolResultCallId(message: AgentMessage): string | null {
	const msg = message as any;
	if (msg?.role !== "toolResult") {
		return null;
	}
	if (typeof msg.toolCallId === "string" && msg.toolCallId.trim()) {
		return msg.toolCallId.trim();
	}
	return null;
}

function buildToolCallPositionMap(messages: AgentMessage[]): Map<string, number> {
	const callPositions = new Map<string, number>();
	for (let index = 0; index < messages.length; index++) {
		for (const rawId of extractAssistantToolCallIds(messages[index]!)) {
			for (const key of normalizeToolCallIdVariants(rawId)) {
				if (!callPositions.has(key)) {
					callPositions.set(key, index);
				}
			}
		}
	}
	return callPositions;
}

function resolveToolCallPosition(callPositions: Map<string, number>, rawId: string): number | null {
	for (const key of normalizeToolCallIdVariants(rawId)) {
		const index = callPositions.get(key);
		if (typeof index === "number") {
			return index;
		}
	}
	return null;
}

export function computeOmContextThresholds(args: {
	config: ObservationalMemoryConfig;
	contextWindow: number;
}): OmContextThresholds {
	const contextWindow = Math.max(1, Math.floor(args.contextWindow || args.config.contextWindowSize || 1));
	const contextCapPercent = args.config.cacheOptimization.enabled
		? Math.max(20, Math.min(95, args.config.cacheOptimization.maxPromptContextPercent || 50))
		: 95;
	const observationTriggerPercent = Math.min(
		args.config.rawMessages.observeThresholdPercent,
		Math.max(2, contextCapPercent - 1),
	);
	const observationTargetPercent = Math.max(
		1,
		Math.min(
			observationTriggerPercent - 1,
			args.config.observationTargetContextPercent,
			Math.max(1, contextCapPercent - 5),
		),
	);
	const reflectionTriggerPercent = Math.min(args.config.observations.reobserveThresholdPercent, observationTriggerPercent);
	const reflectionTargetPercent = Math.max(1, Math.min(reflectionTriggerPercent - 1, args.config.reflectionTargetContextPercent));
	const reflectionRefreshTriggerPercent = Math.min(args.config.reflections.reobserveThresholdPercent, observationTriggerPercent);
	return {
		contextWindow,
		observationTriggerPercent,
		observationTargetPercent,
		observationTriggerTokens: Math.round(contextWindow * (observationTriggerPercent / 100)),
		observationTargetTokens: Math.round(contextWindow * (observationTargetPercent / 100)),
		reflectionTriggerPercent,
		reflectionTargetPercent,
		reflectionTriggerTokens: Math.round(contextWindow * (reflectionTriggerPercent / 100)),
		reflectionTargetTokens: Math.round(contextWindow * (reflectionTargetPercent / 100)),
		reflectionRefreshTriggerPercent,
		reflectionRefreshTriggerTokens: Math.round(contextWindow * (reflectionRefreshTriggerPercent / 100)),
	};
}

export function alignCursorToToolCallPairs(messages: AgentMessage[], candidateIndex: number): number {
	if (messages.length === 0) return 0;
	const bounded = Math.max(0, Math.min(candidateIndex, messages.length));
	if (bounded === 0) return 0;

	const callPositions = buildToolCallPositionMap(messages);
	let safeIndex = bounded;

	while (safeIndex > 0) {
		let nextSafeIndex = safeIndex;
		for (let index = safeIndex; index < messages.length; index++) {
			const toolCallId = extractToolResultCallId(messages[index]!);
			if (!toolCallId) continue;
			const callIndex = resolveToolCallPosition(callPositions, toolCallId);
			if (callIndex !== null && callIndex < nextSafeIndex) {
				nextSafeIndex = callIndex;
			}
		}
		if (nextSafeIndex === safeIndex) {
			break;
		}
		safeIndex = nextSafeIndex;
	}

	return safeIndex;
}

export function planPendingObservationSlice(args: {
	state: ObservationState;
	messages: AgentMessage[];
	contextWindow: number;
	config: Pick<ObservationalMemoryConfig, "rawMessages" | "preserveRecentMessages" | "minObservationMessages">;
}): PendingObservationSlice {
	const previousCursorIndex = getObservationCursor(args.state);
	const rawCursorIndex = Math.max(0, Math.min(previousCursorIndex, args.messages.length));
	const cursorIndex = alignCursorToToolCallPairs(args.messages, rawCursorIndex);
	const batch = selectOldestRawMessageBatch({
		messages: args.messages,
		cursor: cursorIndex,
		contextWindow: args.contextWindow,
		oldestScopePercent: args.config.rawMessages.oldestScopePercent,
		preserveRecentMessages: args.config.preserveRecentMessages,
		minMessages: args.config.minObservationMessages,
		alignIndex: (nextIndex) => alignCursorToToolCallPairs(args.messages, nextIndex),
	});
	const unobservedMessages = args.messages.slice(cursorIndex);
	return {
		rawCursorIndex,
		cursorIndex,
		cursorWasClamped: rawCursorIndex !== previousCursorIndex,
		cursorWasRealigned: cursorIndex !== rawCursorIndex,
		unobservedMessages,
		unobservedTokens: estimateMessagesTokens(unobservedMessages),
		batch,
	};
}

export function computeContextPercent(tokens: number, contextWindow: number): number | null {
	if (!Number.isFinite(tokens) || tokens < 0) return null;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	return (tokens / contextWindow) * 100;
}

export function computeOmContextPressure(args: {
	runtimeContextPercent?: number | null;
	runtimeContextTokens?: number | null;
	unobservedTokens: number;
	contextWindow: number;
}): OmContextPressureSnapshot {
	const runtimePercent =
		typeof args.runtimeContextPercent === "number" && Number.isFinite(args.runtimeContextPercent)
			? args.runtimeContextPercent
			: null;
	const runtimeTokens =
		typeof args.runtimeContextTokens === "number" && Number.isFinite(args.runtimeContextTokens)
			? args.runtimeContextTokens
			: null;
	const estimatedPercent = computeContextPercent(args.unobservedTokens, args.contextWindow);
	let effectivePercent = runtimePercent;
	if (estimatedPercent !== null && (effectivePercent === null || estimatedPercent > effectivePercent)) {
		effectivePercent = estimatedPercent;
	}
	return {
		runtimePercent,
		estimatedPercent,
		effectivePercent,
		contextTokens: runtimeTokens !== null ? runtimeTokens : args.unobservedTokens > 0 ? args.unobservedTokens : null,
	};
}

export interface ForwardedContextSlicePlan {
	messages: AgentMessage[];
	messageTokens: number;
	trimmed: boolean;
	forceObservationOnNextTurn: boolean;
}

export function planForwardedContextSlice(args: {
	unobservedMessages: AgentMessage[];
	unobservedTokens: number;
	shouldTrim: boolean;
	observationTargetTokens: number;
}): ForwardedContextSlicePlan {
	const output = {
		messages: args.unobservedMessages,
		messageTokens: Math.max(0, Math.floor(args.unobservedTokens)),
		trimmed: false,
		forceObservationOnNextTurn: false,
	};
	if (!args.shouldTrim || args.unobservedMessages.length === 0) return output;

	const trimmed = trimMessagesToTokenBudgetKeepingPairs(args.unobservedMessages, args.observationTargetTokens);
	if (trimmed && trimmed.messages.length > 0 && trimmed.messages.length < args.unobservedMessages.length) {
		return {
			messages: trimmed.messages,
			messageTokens: trimmed.tokens,
			trimmed: true,
			forceObservationOnNextTurn: true,
		};
	}

	return output;
}

export function trimMessagesToTokenBudgetKeepingPairs(
	messages: AgentMessage[],
	targetTokens: number,
): { messages: AgentMessage[]; tokens: number } | null {
	if (messages.length === 0) return null;
	const safeTargetTokens = Math.max(1, Math.floor(targetTokens));
	const totalTokens = estimateMessagesTokens(messages);
	if (totalTokens <= safeTargetTokens) {
		return { messages, tokens: totalTokens };
	}

	let startIndex = messages.length - 1;
	let runningTokens = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const messageTokens = estimateMessagesTokens([messages[index]!]);
		if (runningTokens + messageTokens > safeTargetTokens && index < messages.length - 1) {
			break;
		}
		startIndex = index;
		runningTokens += messageTokens;
		if (runningTokens >= safeTargetTokens) {
			break;
		}
	}

	const safeStartIndex = alignCursorToToolCallPairs(messages, startIndex);
	const trimmedMessages = messages.slice(safeStartIndex);
	if (trimmedMessages.length === 0) return null;
	return {
		messages: trimmedMessages,
		tokens: estimateMessagesTokens(trimmedMessages),
	};
}

export function shouldArmObservation(args: {
	currentArmed: boolean;
	effectiveContextPercent: number | null;
	thresholds: OmContextThresholds;
}): boolean {
	if (args.effectiveContextPercent === null) {
		return args.currentArmed;
	}
	if (args.effectiveContextPercent >= args.thresholds.observationTriggerPercent) {
		return true;
	}
	if (args.effectiveContextPercent <= args.thresholds.observationTargetPercent) {
		return false;
	}
	return args.currentArmed;
}

export function shouldArmReflection(args: {
	currentArmed: boolean;
	state: ObservationState;
	thresholds: OmContextThresholds;
}): boolean {
	const observationTokens = args.state.totalObservationTokens;
	const reflectionTokens = getReflectionTokenTotal(args.state);
	if (
		observationTokens >= args.thresholds.reflectionTriggerTokens ||
		reflectionTokens >= args.thresholds.reflectionRefreshTriggerTokens
	) {
		return true;
	}
	if (
		observationTokens <= args.thresholds.reflectionTargetTokens &&
		reflectionTokens < args.thresholds.reflectionRefreshTriggerTokens
	) {
		return false;
	}
	return args.currentArmed;
}

export function chooseReflectionMode(args: {
	state: ObservationState;
	thresholds: OmContextThresholds;
	force?: boolean;
}): "observations" | "reflections" | null {
	const observationTokens = args.state.totalObservationTokens;
	const reflectionTokens = getReflectionTokenTotal(args.state);
	const shouldReflectObservations = Boolean(args.force && observationTokens > 0) || observationTokens >= args.thresholds.reflectionTriggerTokens;
	const shouldRefreshReflections = Boolean(args.force && reflectionTokens > 0) || reflectionTokens >= args.thresholds.reflectionRefreshTriggerTokens;
	if (shouldReflectObservations) return "observations";
	if (shouldRefreshReflections) return "reflections";
	return null;
}
