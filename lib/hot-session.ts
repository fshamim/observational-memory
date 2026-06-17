import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ArchiveChunkManifest,
	ObservationState,
	PendingSessionSwitchRecord,
	SessionRolloverEntry,
	ObservationalMemoryConfig,
} from "../types";
import { ROLLOVER_ENTRY_TYPE } from "../types";
import { getRawArchiveDir } from "./om-paths";
import { writeArchiveChunks } from "./raw-archive";
import {
	cloneJson,
	findLatestEntry,
	getEntryApproxBytes,
	getMessageEntries,
	getMessageContentText,
	isMessageEntry,
	makeLinearChild,
	setMessageContentText,
	type SessionEntryLike,
	writeSessionEntries,
} from "./session-jsonl";

export interface BuildHotSessionOptions {
	cwd: string;
	sessionName: string;
	token: string;
	reason: string;
	sourceSessionPath: string;
	targetHotSessionPath: string;
	allEntries: SessionEntryLike[];
	branchEntries: SessionEntryLike[];
	branchMessageEntries: SessionEntryLike[];
	safeMessageStartIndex: number;
	state: ObservationState;
	config: ObservationalMemoryConfig;
}

export interface BuildHotSessionResult {
	hotSessionPath: string;
	coveredEntryIds: string[];
	trimmedEntryIds: string[];
	archiveChunks: ArchiveChunkManifest[];
	pendingRecord: PendingSessionSwitchRecord;
	rolloverEntry: SessionRolloverEntry;
	projectedHotBytes: number;
}

function nowIso(): string {
	return new Date().toISOString();
}

function extractLatestSessionInfoEntry(entries: SessionEntryLike[]): SessionEntryLike | null {
	return findLatestEntry(entries, (entry) => entry?.type === "session_info");
}

function extractLatestModelChangeEntry(entries: SessionEntryLike[]): SessionEntryLike | null {
	return findLatestEntry(entries, (entry) => entry?.type === "model_change");
}

function extractLatestThinkingEntry(entries: SessionEntryLike[]): SessionEntryLike | null {
	return findLatestEntry(entries, (entry) => entry?.type === "thinking_level_change");
}

function trimLargeMessageEntry(
	entry: SessionEntryLike,
	config: ObservationalMemoryConfig,
	archiveChunkPath: string | null,
): { entry: SessionEntryLike; trimmed: boolean } {
	const next = cloneJson(entry);
	const approxBytes = getEntryApproxBytes(next);
	if (approxBytes < config.oversizedEntries.entryBytes) {
		return { entry: next, trimmed: false };
	}
	const message = next.message || {};
	const role = String(message.role || "");
	const toolName = String(message.toolName || "");
	const previewChars = config.oversizedEntries.stubPreviewChars;
	const originalText = getMessageContentText(message);
	const previewText = originalText.slice(0, previewChars).trim();
	const referenceNotice = archiveChunkPath
		? `\n...[trimmed in hot session; full payload archived at ${archiveChunkPath}]`
		: "\n...[trimmed in hot session]";
	if (originalText) {
		setMessageContentText(message, `${previewText}${referenceNotice}`.trim());
	}
	if (role === "toolResult" && config.oversizedEntries.trimWorkflowToolResults) {
		const details = message.details;
		if (details && typeof details === "object") {
			const state = (details as any).state;
			if (state && typeof state === "object") {
				(details as any).state = {
					workflowId: (state as any).workflowId,
					activeSprintName: (state as any).activeSprintName,
					phase: (state as any).phase,
					latestMaxSeverity: (state as any).latestMaxSeverity,
					pendingGate: (state as any).pendingGate,
					updatedAt: (state as any).updatedAt,
					trimmedByOm: true,
				};
			}
			(details as any).omArchivedPayload = {
				trimmed: true,
				archiveChunkPath,
				originalApproxBytes: approxBytes,
				toolName,
			};
		}
	}
	return { entry: next, trimmed: true };
}

function getSafeHeader(entries: SessionEntryLike[], sourceSessionPath: string, cwd: string): SessionEntryLike {
	const header = entries.find((entry) => entry?.type === "session") || {};
	return {
		type: "session",
		version: typeof header.version === "number" ? header.version : 3,
		id: `${header.id || "om-hot"}-${Date.now()}`,
		timestamp: nowIso(),
		cwd: header.cwd || cwd,
		parentSession: sourceSessionPath,
	};
}

function estimateEntriesBytes(entries: SessionEntryLike[]): number {
	return entries.reduce((sum, entry) => sum + getEntryApproxBytes(entry), 0);
}

export function buildHotSessionBundle(options: BuildHotSessionOptions): BuildHotSessionResult {
	const {
		cwd,
		sessionName,
		token,
		reason,
		sourceSessionPath,
		targetHotSessionPath,
		allEntries,
		branchEntries,
		branchMessageEntries,
		safeMessageStartIndex,
		state,
		config,
	} = options;

	const coveredMessageEntries = branchMessageEntries.slice(0, Math.max(0, safeMessageStartIndex));
	const retainedMessageEntries = branchMessageEntries.slice(Math.max(0, safeMessageStartIndex));
	const coveredEntryIds = coveredMessageEntries.map((entry) => String(entry.id || "")).filter(Boolean);
	const archiveResult = writeArchiveChunks({
		cwd,
		sessionKey: sessionName,
		entries: coveredMessageEntries,
		targetChunkBytes: config.archive.targetChunkBytes,
		maxChunkBytes: config.archive.maxChunkBytes,
	});
	const archiveReferencePath = archiveResult.chunks[archiveResult.chunks.length - 1]?.path || null;

	const trimmedEntryIds: string[] = [];
	const retainedOriginalOversizedEntries: SessionEntryLike[] = [];
	const rebuiltMessages = retainedMessageEntries.map((entry) => {
		const approxBytes = getEntryApproxBytes(entry);
		if (approxBytes >= config.oversizedEntries.entryBytes) {
			retainedOriginalOversizedEntries.push(cloneJson(entry));
			const trimmed = trimLargeMessageEntry(entry, config, archiveReferencePath);
			if (trimmed.trimmed && entry.id) {
				trimmedEntryIds.push(String(entry.id));
			}
			return trimmed.entry;
		}
		return cloneJson(entry);
	});

	if (retainedOriginalOversizedEntries.length > 0) {
		const extraArchive = writeArchiveChunks({
			cwd,
			sessionKey: sessionName,
			entries: retainedOriginalOversizedEntries,
			targetChunkBytes: config.archive.targetChunkBytes,
			maxChunkBytes: config.archive.maxChunkBytes,
		});
		archiveResult.chunks.push(...extraArchive.chunks);
	}

	const latestSessionInfo = extractLatestSessionInfoEntry(allEntries);
	const latestModelChange = extractLatestModelChangeEntry(allEntries);
	const latestThinking = extractLatestThinkingEntry(allEntries);
	const header = getSafeHeader(allEntries, sourceSessionPath, cwd);
	const rebasedState: ObservationState = {
		...cloneJson(state),
		rawMessageCursor: 0,
		lastObservedMessageIndex: 0,
	};
	const rolloverEntry: SessionRolloverEntry = {
		version: 1,
		token,
		reason,
		createdAt: nowIso(),
		sourceSessionPath,
		targetSessionPath: targetHotSessionPath,
		sessionName,
		coveredEntryIds,
		trimmedEntryIds,
		archiveChunks: archiveResult.chunks,
		cleanupOriginalSessionPath: sourceSessionPath,
	};
	const rolloverCustomEntry = {
		type: "custom",
		id: `om-rollover-${Date.now()}`,
		timestamp: nowIso(),
		customType: ROLLOVER_ENTRY_TYPE,
		data: rolloverEntry,
	};

	const outEntries: SessionEntryLike[] = [header];
	const metadataEntries = [latestSessionInfo, latestModelChange, latestThinking]
		.filter((entry): entry is SessionEntryLike => Boolean(entry))
		.map((entry) => cloneJson(entry));

	if (metadataEntries[0] && metadataEntries[0].type === "session_info") {
		metadataEntries[0].name = sessionName;
	}

	let parentId: string | null = String(header.id);
	for (const entry of [...metadataEntries, rolloverCustomEntry, ...rebuiltMessages]) {
		const next = makeLinearChild(entry, parentId);
		outEntries.push(next);
		parentId = String(next.id || parentId || "");
	}

	writeSessionEntries(targetHotSessionPath, outEntries);
	const projectedHotBytes = estimateEntriesBytes(outEntries);
	const pendingRecord: PendingSessionSwitchRecord = {
		version: 1,
		token,
		createdAt: rolloverEntry.createdAt,
		reason,
		sessionName,
		sourceSessionPath,
		targetSessionPath: targetHotSessionPath,
		coveredEntryIds,
		trimmedEntryIds,
		archiveChunks: archiveResult.chunks,
		nextState: rebasedState,
		cleanupOriginalSessionPath: sourceSessionPath,
	};

	return {
		hotSessionPath: targetHotSessionPath,
		coveredEntryIds,
		trimmedEntryIds,
		archiveChunks: archiveResult.chunks,
		pendingRecord,
		rolloverEntry,
		projectedHotBytes,
	};
}

export function pickSafeMessageStartIndex(branchEntries: SessionEntryLike[], observedMessageIndex: number): number {
	const messageEntries = getMessageEntries(branchEntries);
	return Math.max(0, Math.min(observedMessageIndex, messageEntries.length));
}

export function extractBranchMessageEntries(branchEntries: SessionEntryLike[]): SessionEntryLike[] {
	return branchEntries.filter(isMessageEntry);
}

export function estimateArchiveableSavingsBytes(branchEntries: SessionEntryLike[], safeMessageStartIndex: number, config: ObservationalMemoryConfig): {
	coveredBytes: number;
	oversizedRetainedBytes: number;
	hasOversizedEntries: boolean;
} {
	const messageEntries = getMessageEntries(branchEntries);
	const coveredEntries = messageEntries.slice(0, safeMessageStartIndex);
	const retainedEntries = messageEntries.slice(safeMessageStartIndex);
	const coveredBytes = estimateEntriesBytes(coveredEntries);
	let oversizedRetainedBytes = 0;
	let hasOversizedEntries = false;
	for (const entry of retainedEntries) {
		const bytes = getEntryApproxBytes(entry);
		if (bytes >= config.oversizedEntries.entryBytes) {
			hasOversizedEntries = true;
			oversizedRetainedBytes += Math.max(0, bytes - config.oversizedEntries.stubPreviewChars);
		}
	}
	return { coveredBytes, oversizedRetainedBytes, hasOversizedEntries };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingHotDecorations(base: string): string {
	let next = base;
	while (true) {
		const stripped = next.replace(/\.hot(?:\.\d+)?$/, "");
		if (stripped === next) return next;
		next = stripped;
	}
}

function inferHotSequence(rootBase: string, base: string): number | null {
	if (base === `${rootBase}.hot`) {
		return 1;
	}
	const numbered = base.match(new RegExp(`^${escapeRegExp(rootBase)}\\.hot\\.(\\d+)$`));
	if (numbered) {
		return Number.parseInt(numbered[1] || "0", 10) || null;
	}
	const repeated = base.match(new RegExp(`^${escapeRegExp(rootBase)}((?:\\.hot)+)$`));
	if (repeated) {
		return (repeated[1]?.match(/\.hot/g) || []).length;
	}
	return null;
}

export function createHotSessionPath(sourceSessionPath: string): string {
	const dir = path.dirname(sourceSessionPath);
	const ext = path.extname(sourceSessionPath) || ".jsonl";
	const sourceBase = path.basename(sourceSessionPath, ext);
	const rootBase = stripTrailingHotDecorations(sourceBase);
	let maxSequence = 0;
	try {
		for (const fileName of fs.readdirSync(dir)) {
			if (path.extname(fileName) !== ext) continue;
			const base = path.basename(fileName, ext);
			const sequence = inferHotSequence(rootBase, base);
			if (sequence && sequence > maxSequence) {
				maxSequence = sequence;
			}
		}
	} catch {
		
	}
	let nextSequence = Math.max(1, maxSequence + 1);
	let candidate = path.join(dir, `${rootBase}.hot.${String(nextSequence).padStart(3, "0")}${ext}`);
	while (fs.existsSync(candidate)) {
		nextSequence += 1;
		candidate = path.join(dir, `${rootBase}.hot.${String(nextSequence).padStart(3, "0")}${ext}`);
	}
	return candidate;
}

export function cleanupArchivedOriginalSource(sourceSessionPath: string, sessionName: string, cwd: string): string | undefined {
	if (!sourceSessionPath || !fs.existsSync(sourceSessionPath)) return undefined;
	const archiveDir = getRawArchiveDir(sessionName, cwd);
	const dest = path.join(archiveDir, `source-original-${path.basename(sourceSessionPath)}`);
	let resolved = dest;
	let counter = 1;
	while (fs.existsSync(resolved)) {
		resolved = `${dest}.${counter++}`;
	}
	fs.renameSync(sourceSessionPath, resolved);
	return resolved;
}
