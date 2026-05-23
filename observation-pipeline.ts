import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { RequestAuth } from "./auth";
import { deriveExperiencesAfterObservation } from "./experience-miner";
import {
	appendObservationResult,
	computeQueueTokenTotals,
	getObservationCursor,
	getObservationText,
} from "./memory-queues";
import {
	alignCursorToToolCallPairs,
	computeContextPercent,
	planPendingObservationSlice,
	type OmContextThresholds,
} from "./pipeline-planner";
import { estimateMessagesTokens } from "./token-estimator";
import type { ObservationState, ObservationalMemoryConfig } from "./types";
import { upsertExperienceCandidate } from "./lib/experience-bank";

export interface ObservationBatchSnapshot {
	messages: AgentMessage[];
	startIndex: number;
	endIndex: number;
	tokens: number;
}

export interface ObservationRunPlan {
	force: boolean;
	cursorIndex: number;
	batch: ObservationBatchSnapshot;
	observationBatchTokens: number;
	previousObservations: string;
	previousObservationTokens: number;
	maxAttempts: number;
}

export interface ObservationPipelineDeps {
	runObserver?: (params: {
		unobservedMessages: AgentMessage[];
		previousObservations: string;
		config: ObservationalMemoryConfig;
		getAuth: () => Promise<RequestAuth>;
		timezone: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		promptTokenLimit?: number;
	}) => Promise<{
		observations: string;
		chunkCount: number;
	}>;
	deriveExperiencesAfterObservation?: typeof deriveExperiencesAfterObservation;
	upsertExperienceCandidate?: typeof upsertExperienceCandidate;
}

export interface ObservationExecutionResult {
	observationText: string;
	chunkCount: number;
	observationDeltaTokens: number;
	derivedExperienceCount: number;
}

export function planObservationRun(args: {
	config: ObservationalMemoryConfig;
	state: ObservationState;
	fullMessages: AgentMessage[];
	lastFullMessageCount: number;
	lastUnobservedMessages: AgentMessage[];
	force: boolean;
	forceObservationOnNextTurn: boolean;
	hasObservationBatch: boolean;
	observationBatch: ObservationBatchSnapshot | null;
	contextWindow: number;
}): ObservationRunPlan | null {
	if (args.lastFullMessageCount === 0) return null;
	if (args.lastUnobservedMessages.length === 0) return null;
	if (!args.force && !args.forceObservationOnNextTurn) return null;
	if (!args.force && !args.hasObservationBatch) return null;

	const rawCursorIndex = Math.min(getObservationCursor(args.state), args.lastFullMessageCount);
	const cursorIndex = alignCursorToToolCallPairs(args.fullMessages, rawCursorIndex);
	let batch = args.hasObservationBatch && args.observationBatch
		? { ...args.observationBatch, messages: [...args.observationBatch.messages] }
		: null;

	if (!batch && args.force) {
		const slice = planPendingObservationSlice({
			state: args.state,
			messages: args.fullMessages,
			contextWindow: args.contextWindow,
			config: {
				rawMessages: args.config.rawMessages,
				preserveRecentMessages: args.config.preserveRecentMessages,
				minObservationMessages: args.config.minObservationMessages,
			},
		});
		if (slice.batch) {
			batch = slice.batch;
		}
	}

	if (!batch || batch.messages.length === 0) {
		return null;
	}

	return {
		force: args.force,
		cursorIndex,
		batch,
		observationBatchTokens: batch.tokens || estimateMessagesTokens(batch.messages),
		previousObservations: getObservationText(args.state),
		previousObservationTokens: args.state.totalObservationTokens,
		maxAttempts: Math.max(1, args.config.observerMaxAttempts),
	};
}

export async function executeObservationPlan(args: {
	config: ObservationalMemoryConfig;
	state: ObservationState;
	plan: ObservationRunPlan;
	getAuth: () => Promise<RequestAuth>;
	timezone: string;
	cwd: string;
	sessionName: string;
	sessionPath?: string;
	signal?: AbortSignal;
	deps?: ObservationPipelineDeps;
}): Promise<ObservationExecutionResult> {
	const runObserver = args.deps?.runObserver ?? (await import("./observer")).runObserver;
	const deriveExperiences = args.deps?.deriveExperiencesAfterObservation ?? deriveExperiencesAfterObservation;
	const upsertCandidate = args.deps?.upsertExperienceCandidate ?? upsertExperienceCandidate;
	const result = await runObserver({
		unobservedMessages: args.plan.batch.messages,
		previousObservations: args.plan.previousObservations,
		config: args.config,
		getAuth: args.getAuth,
		timezone: args.timezone,
		signal: args.signal,
		timeoutMs: args.config.observerTimeoutMs,
		promptTokenLimit: args.config.observerPromptTokenLimit,
	});

	const observations = result.observations.trim();
	appendObservationResult({
		state: args.state,
		observationText: observations,
		messageStartIndex: args.plan.batch.startIndex,
		messageEndIndex: args.plan.batch.endIndex,
	});

	let derivedExperienceCount = 0;
	const newObservationItems = observations ? args.state.observations.slice(-1) : [];
	if (args.config.experiences.enabled && args.config.experienceBank.enabled && newObservationItems.length > 0) {
		const derived = await deriveExperiences({
			rawMessages: args.plan.batch.messages,
			observationItems: newObservationItems,
			existingExperiences: args.state.experiences,
			config: args.config,
			rawMessageRange: {
				messageStartIndex: args.plan.batch.startIndex,
				messageEndIndex: args.plan.batch.endIndex,
			},
		});
		args.state.experiences = derived.nextExperiences;
		const newObservationIds = new Set(newObservationItems.map((item) => item.id));
		for (const experience of derived.nextExperiences.filter((item) => item.sourceObservationIds.some((id) => newObservationIds.has(id)))) {
			upsertCandidate({
				kind: "decision_rule",
				text: experience.text,
				toolNames: derived.evidence.toolNames,
				triggerPatterns: ["observations", "tool-use"],
				status: "candidate",
				source: {
					sourceSessionName: args.sessionName,
					sourceSessionPath: args.sessionPath || undefined,
					entryIdStart: undefined,
					entryIdEnd: undefined,
					coveredEntryIds: [],
				},
				supersedes: [],
			}, args.cwd);
		}
		derivedExperienceCount = derived.ops.length;
	}

	computeQueueTokenTotals(args.state);
	return {
		observationText: observations,
		chunkCount: result.chunkCount,
		observationDeltaTokens: Math.max(0, args.state.totalObservationTokens - args.plan.previousObservationTokens),
		derivedExperienceCount,
	};
}

export function computeObservationRearmDecision(args: {
	contextTokens: number | null;
	contextWindow: number;
	observationBatchTokens: number;
	observationDeltaTokens: number;
	thresholds: OmContextThresholds;
}): boolean {
	if (typeof args.contextTokens !== "number" || args.contextWindow <= 0) {
		return false;
	}
	const projectedContextTokens = Math.max(0, args.contextTokens - args.observationBatchTokens + args.observationDeltaTokens);
	const projectedContextPercent = computeContextPercent(projectedContextTokens, args.contextWindow);
	return projectedContextPercent !== null && projectedContextPercent >= args.thresholds.observationTargetPercent;
}
