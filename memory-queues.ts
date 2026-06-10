import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildReflectionArchivePlaceholder, isReflectionArchivePlaceholderText } from "./reflection-archive-placeholder";
import { estimateMessagesTokens, estimateStringTokens } from "./token-estimator";
import type {
	ObservationState,
	OmExperienceItem,
	OmObservationItem,
	OmReflectionItem,
} from "./types";

function nowIso(): string {
	return new Date().toISOString();
}

function nextId(prefix: string, items: Array<{ id: string }>): string {
	const max = items.reduce((highest, item) => {
		const match = String(item.id || "").match(/(\d+)$/);
		if (!match) return highest;
		return Math.max(highest, Number(match[1] || 0));
	}, 0);
	return `${prefix}${String(max + 1).padStart(6, "0")}`;
}

function normalizeText(text: unknown): string {
	return String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function normalizeNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: fallback;
}

export function isArchivedReflectionPlaceholder(item: Pick<OmReflectionItem, "text" | "placeholder">): boolean {
	return Boolean(item.placeholder || isReflectionArchivePlaceholderText(item.text));
}

function takeRecentReflectionItemsWithinTokenBudget(items: OmReflectionItem[], tokenBudget: number): OmReflectionItem[] {
	const budget = Math.max(0, Math.floor(tokenBudget));
	if (items.length === 0 || budget <= 0) return [];
	const kept: OmReflectionItem[] = [];
	let total = 0;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]!;
		const itemTokens = Math.max(1, item.tokenCount || estimateStringTokens(normalizeText(item.text)));
		if (kept.length > 0 && total + itemTokens > budget) {
			break;
		}
		kept.unshift(item);
		total += itemTokens;
	}
	return kept;
}

function normalizeObservationItem(raw: any, fallbackId: string): OmObservationItem | null {
	const text = normalizeText(raw?.text);
	if (!text) return null;
	return {
		id: typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId,
		text,
		tokenCount: normalizeNumber(raw?.tokenCount, estimateStringTokens(text)),
		createdAt: typeof raw?.createdAt === "string" && raw.createdAt ? raw.createdAt : nowIso(),
		source: {
			messageStartIndex: normalizeNumber(raw?.source?.messageStartIndex),
			messageEndIndex: normalizeNumber(raw?.source?.messageEndIndex),
			entryIds: Array.isArray(raw?.source?.entryIds)
				? raw.source.entryIds.map((value: unknown) => String(value)).filter(Boolean)
				: undefined,
		},
	};
}

function normalizeReflectionItem(raw: any, fallbackId: string): OmReflectionItem | null {
	const text = normalizeText(raw?.text);
	if (!text) return null;
	return {
		id: typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId,
		text,
		tokenCount: normalizeNumber(raw?.tokenCount, estimateStringTokens(text)),
		createdAt: typeof raw?.createdAt === "string" && raw.createdAt ? raw.createdAt : nowIso(),
		generation: normalizeNumber(raw?.generation, 1),
		sourceObservationIds: Array.isArray(raw?.sourceObservationIds)
			? raw.sourceObservationIds.map((value: unknown) => String(value)).filter(Boolean)
			: undefined,
		refreshedFromReflectionIds: Array.isArray(raw?.refreshedFromReflectionIds)
			? raw.refreshedFromReflectionIds.map((value: unknown) => String(value)).filter(Boolean)
			: undefined,
		archivedToMemoryMdHash:
			typeof raw?.archivedToMemoryMdHash === "string" && raw.archivedToMemoryMdHash
				? raw.archivedToMemoryMdHash
				: undefined,
		archivedToMemoryMdPath:
			typeof raw?.archivedToMemoryMdPath === "string" && raw.archivedToMemoryMdPath
				? raw.archivedToMemoryMdPath
				: undefined,
		placeholder: typeof raw?.placeholder === "boolean" ? raw.placeholder : isReflectionArchivePlaceholderText(text),
	};
}

function normalizeExperienceItem(raw: any, fallbackId: string): OmExperienceItem | null {
	const text = normalizeText(raw?.text);
	if (!text) return null;
	return {
		id: typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId,
		text,
		createdAt: typeof raw?.createdAt === "string" && raw.createdAt ? raw.createdAt : nowIso(),
		updatedAt: typeof raw?.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : nowIso(),
		sourceObservationIds: Array.isArray(raw?.sourceObservationIds)
			? raw.sourceObservationIds.map((value: unknown) => String(value)).filter(Boolean)
			: [],
		sourceRawMessageRange: raw?.sourceRawMessageRange
			? {
				messageStartIndex: normalizeNumber(raw.sourceRawMessageRange.messageStartIndex),
				messageEndIndex: normalizeNumber(raw.sourceRawMessageRange.messageEndIndex),
			}
			: undefined,
		mergedFrom: Array.isArray(raw?.mergedFrom)
			? raw.mergedFrom.map((value: unknown) => String(value)).filter(Boolean)
			: undefined,
		modifiedFrom: typeof raw?.modifiedFrom === "string" && raw.modifiedFrom ? raw.modifiedFrom : undefined,
		score: typeof raw?.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined,
		retrievedCount: normalizeNumber(raw?.retrievedCount),
		appliedCount: normalizeNumber(raw?.appliedCount),
		helpedCount: normalizeNumber(raw?.helpedCount),
		hurtCount: normalizeNumber(raw?.hurtCount),
		ignoredCount: normalizeNumber(raw?.ignoredCount),
	};
}

export function formatObservationItems(items: OmObservationItem[]): string {
	return items.map((item) => normalizeText(item.text)).filter(Boolean).join("\n\n").trim();
}

export function formatReflectionItems(items: OmReflectionItem[]): string {
	return items.map((item) => normalizeText(item.text)).filter(Boolean).join("\n\n").trim();
}

export function getActiveReflectionItems(state: ObservationState): OmReflectionItem[] {
	return state.reflections.filter((item) => !isArchivedReflectionPlaceholder(item));
}

export function getArchivedReflectionPlaceholders(state: ObservationState): OmReflectionItem[] {
	return state.reflections.filter((item) => isArchivedReflectionPlaceholder(item));
}

export function formatActiveReflectionItems(items: OmReflectionItem[]): string {
	return formatReflectionItems(items.filter((item) => !isArchivedReflectionPlaceholder(item)));
}

export function formatArchivedReflectionPlaceholderItems(items: OmReflectionItem[], tokenBudget: number): string {
	return formatReflectionItems(takeRecentReflectionItemsWithinTokenBudget(
		items.filter((item) => isArchivedReflectionPlaceholder(item)),
		tokenBudget,
	));
}

export function getObservationCursor(state: ObservationState): number {
	return Math.max(0, Math.floor(state.rawMessageCursor || state.lastObservedMessageIndex || 0));
}

export function getObservationText(state: ObservationState): string {
	return formatObservationItems(state.observations) || normalizeText(state.activeObservations);
}

export function getReflectionText(state: ObservationState): string {
	return formatActiveReflectionItems(state.reflections) || normalizeText(state.compactedObservations);
}

export function getReflectionTokenTotal(state: ObservationState): number {
	return Math.max(0, state.totalReflectionTokens || state.totalCompactedTokens || 0);
}

export function hasObservationItems(state: ObservationState): boolean {
	return state.observations.length > 0 || getObservationText(state).length > 0;
}

export function hasReflectionItems(state: ObservationState): boolean {
	return getActiveReflectionItems(state).length > 0 || getReflectionText(state).length > 0;
}

export function computeQueueTokenTotals(state: ObservationState): ObservationState {
	state.observations = state.observations.filter((item) => normalizeText(item.text).length > 0);
	state.reflections = state.reflections.filter((item) => normalizeText(item.text).length > 0);
	state.experiences = state.experiences.filter((item) => normalizeText(item.text).length > 0);
	for (const item of state.observations) {
		item.text = normalizeText(item.text);
		item.tokenCount = estimateStringTokens(item.text);
	}
	for (const item of state.reflections) {
		item.text = normalizeText(item.text);
		item.tokenCount = estimateStringTokens(item.text);
		item.placeholder = isArchivedReflectionPlaceholder(item);
	}
	for (const item of state.experiences) {
		item.text = normalizeText(item.text);
	}
	state.totalObservationTokens = state.observations.reduce((sum, item) => sum + item.tokenCount, 0);
	state.totalReflectionTokens = getActiveReflectionItems(state).reduce((sum, item) => sum + item.tokenCount, 0);
	state.totalExperienceTokens = state.experiences.reduce((sum, item) => sum + estimateStringTokens(item.text), 0);
	state.activeObservations = getObservationText(state);
	state.compactedObservations = getReflectionText(state);
	state.totalCompactedTokens = state.totalReflectionTokens;
	state.rawMessageCursor = getObservationCursor(state);
	state.lastObservedMessageIndex = state.rawMessageCursor;
	state.schemaVersion = 2;
	return state;
}

export function serializeOmState(state: ObservationState): Record<string, unknown> {
	computeQueueTokenTotals(state);
	return {
		schemaVersion: 2,
		rawMessageCursor: state.rawMessageCursor,
		observations: state.observations.map((item) => ({
			id: item.id,
			text: item.text,
			tokenCount: item.tokenCount,
			createdAt: item.createdAt,
			source: {
				messageStartIndex: item.source.messageStartIndex,
				messageEndIndex: item.source.messageEndIndex,
				...(item.source.entryIds?.length ? { entryIds: [...item.source.entryIds] } : {}),
			},
		})),
		reflections: state.reflections.map((item) => ({
			id: item.id,
			text: item.text,
			tokenCount: item.tokenCount,
			createdAt: item.createdAt,
			generation: item.generation,
			...(item.sourceObservationIds?.length ? { sourceObservationIds: [...item.sourceObservationIds] } : {}),
			...(item.refreshedFromReflectionIds?.length ? { refreshedFromReflectionIds: [...item.refreshedFromReflectionIds] } : {}),
			...(item.archivedToMemoryMdHash ? { archivedToMemoryMdHash: item.archivedToMemoryMdHash } : {}),
			...(item.archivedToMemoryMdPath ? { archivedToMemoryMdPath: item.archivedToMemoryMdPath } : {}),
			...(item.placeholder ? { placeholder: true } : {}),
		})),
		experiences: state.experiences.map((item) => ({
			id: item.id,
			text: item.text,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			sourceObservationIds: [...item.sourceObservationIds],
			...(item.sourceRawMessageRange ? { sourceRawMessageRange: { ...item.sourceRawMessageRange } } : {}),
			...(item.mergedFrom?.length ? { mergedFrom: [...item.mergedFrom] } : {}),
			...(item.modifiedFrom ? { modifiedFrom: item.modifiedFrom } : {}),
			...(typeof item.score === "number" ? { score: item.score } : {}),
			...(typeof item.retrievedCount === "number" ? { retrievedCount: item.retrievedCount } : {}),
			...(typeof item.appliedCount === "number" ? { appliedCount: item.appliedCount } : {}),
			...(typeof item.helpedCount === "number" ? { helpedCount: item.helpedCount } : {}),
			...(typeof item.hurtCount === "number" ? { hurtCount: item.hurtCount } : {}),
			...(typeof item.ignoredCount === "number" ? { ignoredCount: item.ignoredCount } : {}),
		})),
		generationCount: state.generationCount,
		lastObservedTimestamp: state.lastObservedTimestamp,
		...(state.lastReflectionTimestamp ? { lastReflectionTimestamp: state.lastReflectionTimestamp } : {}),
		...(state.lastReflectionRefreshTimestamp ? { lastReflectionRefreshTimestamp: state.lastReflectionRefreshTimestamp } : {}),
		totalObservationTokens: state.totalObservationTokens,
		totalReflectionTokens: state.totalReflectionTokens,
		totalExperienceTokens: state.totalExperienceTokens,
		...(state.meta ? { meta: state.meta } : {}),
	};
}

export function createInitialOmState(): ObservationState {
	return computeQueueTokenTotals({
		schemaVersion: 2,
		rawMessageCursor: 0,
		observations: [],
		reflections: [],
		experiences: [],
		generationCount: 0,
		lastObservedTimestamp: "",
		lastReflectionTimestamp: "",
		lastReflectionRefreshTimestamp: "",
		totalObservationTokens: 0,
		totalReflectionTokens: 0,
		totalExperienceTokens: 0,
		activeObservations: "",
		compactedObservations: "",
		lastObservedMessageIndex: 0,
		totalCompactedTokens: 0,
	});
}

export function normalizeOmState(raw: any): ObservationState | null {
	if (!raw || typeof raw !== "object") return null;
	if (typeof raw.generationCount !== "number") return null;

	const observationItems = Array.isArray(raw.observations)
		? raw.observations
			.map((item: any, index: number) => normalizeObservationItem(item, `O${String(index + 1).padStart(6, "0")}`))
			.filter((item: OmObservationItem | null): item is OmObservationItem => Boolean(item))
		: [];
	const reflectionItems = Array.isArray(raw.reflections)
		? raw.reflections
			.map((item: any, index: number) => normalizeReflectionItem(item, `R${String(index + 1).padStart(6, "0")}`))
			.filter((item: OmReflectionItem | null): item is OmReflectionItem => Boolean(item))
		: [];
	const experienceItems = Array.isArray(raw.experiences)
		? raw.experiences
			.map((item: any, index: number) => normalizeExperienceItem(item, `E${String(index + 1).padStart(6, "0")}`))
			.filter((item: OmExperienceItem | null): item is OmExperienceItem => Boolean(item))
		: [];

	if (observationItems.length === 0) {
		const legacyObservations = normalizeText(raw.activeObservations);
		if (legacyObservations) {
			observationItems.push({
				id: "O000001",
				text: legacyObservations,
				tokenCount: estimateStringTokens(legacyObservations),
				createdAt: typeof raw.lastObservedTimestamp === "string" && raw.lastObservedTimestamp ? raw.lastObservedTimestamp : nowIso(),
				source: {
					messageStartIndex: 0,
					messageEndIndex: normalizeNumber(raw.lastObservedMessageIndex),
				},
			});
		}
	}

	if (reflectionItems.length === 0) {
		const legacyReflections = normalizeText(raw.compactedObservations);
		if (legacyReflections) {
			reflectionItems.push({
				id: "R000001",
				text: legacyReflections,
				tokenCount: estimateStringTokens(legacyReflections),
				createdAt: typeof raw.lastReflectionTimestamp === "string" && raw.lastReflectionTimestamp ? raw.lastReflectionTimestamp : nowIso(),
				generation: Math.max(1, normalizeNumber(raw.generationCount, 1)),
			});
		}
	}

	const state: ObservationState = {
		schemaVersion: 2,
		rawMessageCursor: normalizeNumber(raw.rawMessageCursor, normalizeNumber(raw.lastObservedMessageIndex)),
		observations: observationItems,
		reflections: reflectionItems,
		experiences: experienceItems,
		generationCount: normalizeNumber(raw.generationCount),
		lastObservedTimestamp: typeof raw.lastObservedTimestamp === "string" ? raw.lastObservedTimestamp : "",
		lastReflectionTimestamp: typeof raw.lastReflectionTimestamp === "string" ? raw.lastReflectionTimestamp : "",
		lastReflectionRefreshTimestamp:
			typeof raw.lastReflectionRefreshTimestamp === "string" ? raw.lastReflectionRefreshTimestamp : "",
		totalObservationTokens: normalizeNumber(raw.totalObservationTokens),
		totalReflectionTokens: normalizeNumber(raw.totalReflectionTokens, normalizeNumber(raw.totalCompactedTokens)),
		totalExperienceTokens: normalizeNumber(raw.totalExperienceTokens),
		meta: raw.meta && typeof raw.meta === "object" ? raw.meta : undefined,
		activeObservations: normalizeText(raw.activeObservations),
		compactedObservations: normalizeText(raw.compactedObservations),
		lastObservedMessageIndex: normalizeNumber(raw.lastObservedMessageIndex),
		totalCompactedTokens: normalizeNumber(raw.totalCompactedTokens),
	};
	return computeQueueTokenTotals(state);
}

export function createObservationItem(text: string, source: OmObservationItem["source"], createdAt = nowIso(), id?: string): OmObservationItem {
	const normalized = normalizeText(text);
	return {
		id: id || "",
		text: normalized,
		tokenCount: estimateStringTokens(normalized),
		createdAt,
		source,
	};
}

export function createReflectionItem(
	text: string,
	params: {
		generation: number;
		sourceObservationIds?: string[];
		refreshedFromReflectionIds?: string[];
		createdAt?: string;
		archivedToMemoryMdHash?: string;
		archivedToMemoryMdPath?: string;
		placeholder?: boolean;
		id?: string;
	},
): OmReflectionItem {
	const normalized = normalizeText(text);
	return {
		id: params.id || "",
		text: normalized,
		tokenCount: estimateStringTokens(normalized),
		createdAt: params.createdAt || nowIso(),
		generation: Math.max(1, params.generation),
		sourceObservationIds: params.sourceObservationIds,
		refreshedFromReflectionIds: params.refreshedFromReflectionIds,
		archivedToMemoryMdHash: params.archivedToMemoryMdHash,
		archivedToMemoryMdPath: params.archivedToMemoryMdPath,
		placeholder: params.placeholder ?? isReflectionArchivePlaceholderText(normalized),
	};
}

export function appendObservationResult(args: {
	state: ObservationState;
	observationText: string;
	messageStartIndex: number;
	messageEndIndex: number;
	createdAt?: string;
}): ObservationState {
	const text = normalizeText(args.observationText);
	args.state.rawMessageCursor = Math.max(args.state.rawMessageCursor, args.messageEndIndex);
	args.state.lastObservedTimestamp = args.createdAt || nowIso();
	if (!text) {
		return computeQueueTokenTotals(args.state);
	}
	const item = createObservationItem(text, {
		messageStartIndex: Math.max(0, Math.floor(args.messageStartIndex)),
		messageEndIndex: Math.max(0, Math.floor(args.messageEndIndex)),
	}, args.createdAt, nextId("O", args.state.observations));
	args.state.observations.push(item);
	return computeQueueTokenTotals(args.state);
}

export function appendReflectionFromObservations(args: {
	state: ObservationState;
	reflectionText: string;
	consumedObservationIds: string[];
	createdAt?: string;
}): ObservationState {
	const text = normalizeText(args.reflectionText);
	if (!text) return computeQueueTokenTotals(args.state);
	const consumed = new Set(args.consumedObservationIds);
	args.state.observations = args.state.observations.filter((item) => !consumed.has(item.id));
	args.state.generationCount += 1;
	args.state.lastReflectionTimestamp = args.createdAt || nowIso();
	args.state.reflections.push(
		createReflectionItem(text, {
			id: nextId("R", args.state.reflections),
			generation: Math.max(1, args.state.generationCount),
			sourceObservationIds: [...consumed],
			createdAt: args.createdAt,
		}),
	);
	return computeQueueTokenTotals(args.state);
}

export function replaceReflectionsAfterArchive(args: {
	state: ObservationState;
	reflectionText: string;
	archivedHash?: string;
	archivedPath?: string;
	placeholderTokenBudget?: number;
	createdAt?: string;
}): ObservationState {
	const text = normalizeText(args.reflectionText);
	if (!text) return computeQueueTokenTotals(args.state);
	const previousIds = getActiveReflectionItems(args.state).map((item) => item.id);
	const idLedger = [...args.state.reflections];
	const placeholderItems = [...getArchivedReflectionPlaceholders(args.state)];
	if (args.archivedHash && args.archivedPath) {
		const placeholderItem = createReflectionItem(
			buildReflectionArchivePlaceholder({ hash: args.archivedHash, memoryMdPath: args.archivedPath }),
			{
				id: nextId("R", idLedger),
				generation: Math.max(1, args.state.generationCount || 1),
				archivedToMemoryMdHash: args.archivedHash,
				archivedToMemoryMdPath: args.archivedPath,
				placeholder: true,
				createdAt: args.createdAt,
			},
		);
		idLedger.push(placeholderItem);
		placeholderItems.push(placeholderItem);
	}
	const preservedPlaceholders = takeRecentReflectionItemsWithinTokenBudget(
		placeholderItems,
		args.placeholderTokenBudget ?? 0,
	);
	args.state.generationCount += 1;
	args.state.lastReflectionRefreshTimestamp = args.createdAt || nowIso();
	args.state.reflections = [
		...preservedPlaceholders,
		createReflectionItem(text, {
			id: nextId("R", idLedger),
			generation: Math.max(1, args.state.generationCount),
			refreshedFromReflectionIds: previousIds,
			createdAt: args.createdAt,
		}),
	];
	return computeQueueTokenTotals(args.state);
}

export function selectOldestObservationBatch(args: {
	state: ObservationState;
	contextWindow: number;
	oldestScopePercent: number;
}): { items: OmObservationItem[]; text: string; tokens: number } | null {
	const items = [...args.state.observations];
	if (items.length === 0) return null;
	const targetTokens = Math.max(1, Math.floor(args.contextWindow * (Math.max(1, Math.min(100, args.oldestScopePercent)) / 100)));
	const selected: OmObservationItem[] = [];
	let tokens = 0;
	for (const item of items) {
		selected.push(item);
		tokens += item.tokenCount || estimateStringTokens(item.text);
		if (tokens >= targetTokens) break;
	}
	if (selected.length === 0) return null;
	return { items: selected, text: formatObservationItems(selected), tokens };
}

export function selectOldestRawMessageBatch(args: {
	messages: AgentMessage[];
	cursor: number;
	contextWindow: number;
	oldestScopePercent: number;
	preserveRecentMessages: number;
	minMessages: number;
	alignIndex?: (index: number) => number;
}): { messages: AgentMessage[]; startIndex: number; endIndex: number; tokens: number } | null {
	const startIndex = Math.max(0, Math.min(args.cursor, args.messages.length));
	const protectedTail = Math.max(0, Math.floor(args.preserveRecentMessages));
	const protectedBoundary = Math.max(startIndex, args.messages.length - protectedTail);
	if (protectedBoundary <= startIndex) return null;
	const tokenBudget = Math.max(1, Math.floor(args.contextWindow * (Math.max(1, Math.min(100, args.oldestScopePercent)) / 100)));
	const minMessages = Math.max(1, Math.floor(args.minMessages));
	let endIndex = startIndex;
	let tokens = 0;
	while (endIndex < protectedBoundary) {
		const candidate = args.messages[endIndex]!;
		const candidateTokens = estimateMessagesTokens([candidate]);
		const nextCount = endIndex - startIndex + 1;
		if (nextCount > minMessages && tokens + candidateTokens > tokenBudget) {
			break;
		}
		tokens += candidateTokens;
		endIndex += 1;
		if (tokens >= tokenBudget && nextCount >= minMessages) {
			break;
		}
	}
	if (endIndex <= startIndex) return null;
	const alignedEnd = typeof args.alignIndex === "function"
		? Math.max(endIndex, Math.min(args.messages.length, args.alignIndex(endIndex)))
		: endIndex;
	const boundedEnd = Math.max(startIndex + 1, Math.min(protectedBoundary, alignedEnd));
	const batch = args.messages.slice(startIndex, boundedEnd);
	if (batch.length === 0) return null;
	return {
		messages: batch,
		startIndex,
		endIndex: boundedEnd,
		tokens: estimateMessagesTokens(batch),
	};
}
