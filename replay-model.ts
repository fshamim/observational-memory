import { estimateStringTokens } from "./token-estimator";

export type ReplayEntryKind =
	| "user"
	| "assistant"
	| "tool-call"
	| "tool-result"
	| "observation"
	| "thinking"
	| "experience"
	| "skill"
	| "system"
	| "other";

export interface ReplayContextUsage {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
}

export interface ReplayLeafEntry {
	id: string;
	rawEntryId: string;
	kind: ReplayEntryKind;
	label: string;
	summary: string;
	detail: string;
	timestamp: string;
	rawBranchIndex: number;
	approxTokens: number;
	inContext: boolean;
}

export interface ReplayGroup {
	id: string;
	kind: "turn" | "system";
	title: string;
	summary: string;
	timestamp: string;
	badges: string[];
	entries: ReplayLeafEntry[];
	rawEntryStartIndex: number;
	rawEntryEndIndex: number;
	inContext: boolean;
	isContextStart: boolean;
}

export interface ReplayModel {
	sessionName: string;
	sessionFilePath: string;
	groups: ReplayGroup[];
	contextUsage: ReplayContextUsage;
	contextStartRawIndex: number;
	contextStartGroupIndex: number;
	omStartRawIndex: number;
	totalRawEntries: number;
	totalMessageEntries: number;
}

export interface BuildReplayModelOptions {
	sessionName?: string;
	sessionFilePath?: string;
	contextUsage?: ReplayContextUsage;
	omMessageStartIndex?: number;
}

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function compactWords(text: string, maxWords = 5, maxChars = 64): string {
	const clean = cleanText(text);
	if (!clean) return "(empty)";
	const words = clean.split(" ");
	const head = words.slice(0, maxWords).join(" ");
	if (head.length > maxChars) {
		return `${head.slice(0, maxChars - 1)}…`;
	}
	return words.length > maxWords || clean.length > head.length ? `${head}…` : head;
}

function compactLine(text: string, maxChars = 72): string {
	const clean = cleanText(text);
	if (!clean) return "(empty)";
	return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

function toIsoTimestamp(value: number | string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeReplayTimestamp(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			const iso = toIsoTimestamp(value);
			if (iso) return iso;
		}
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) continue;
			if (/^\d+$/.test(trimmed)) {
				const numeric = Number(trimmed);
				if (Number.isFinite(numeric)) {
					const iso = toIsoTimestamp(numeric);
					if (iso) return iso;
				}
			}
			const iso = toIsoTimestamp(trimmed);
			if (iso) return iso;
		}
	}
	return "";
}

function detectStructuredContentKind(text: string): ReplayEntryKind | null {
	const lower = text.toLowerCase();
	if (lower.includes("relevant operational experiences") || lower.includes("experience bank")) {
		return "experience";
	}
	if (lower.includes("skill.md") || /\bskills?\b/.test(lower)) {
		return "skill";
	}
	if (lower.includes("observational memory") || lower.includes("om:") || lower.includes("active observations")) {
		return "observation";
	}
	return null;
}

function extractTextParts(content: any): string[] {
	if (typeof content === "string") {
		return content.trim() ? [content] : [];
	}
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
			texts.push(part.text);
		} else if (part?.type === "thinking" && typeof part.text === "string" && part.text.trim()) {
			texts.push(part.text);
		}
	}
	return texts;
}

function extractToolCalls(content: any): Array<{ id: string; name: string; argumentsText: string }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ id: string; name: string; argumentsText: string }> = [];
	for (const part of content) {
		if (part?.type !== "toolCall") continue;
		const argsText = typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments || {});
		calls.push({
			id: String(part.id || `${part.name || "tool"}-${calls.length}`),
			name: String(part.name || "tool"),
			argumentsText: argsText,
		});
	}
	return calls;
}

function extractThinkingParts(content: any): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part) => part?.type === "thinking")
		.map((part) => String(part.text || "").trim())
		.filter(Boolean);
}

function messageToLeafEntries(entry: any, rawBranchIndex: number): ReplayLeafEntry[] {
	const message = entry?.message || {};
	const timestamp = normalizeReplayTimestamp(message.timestamp, entry.timestamp);
	const rawEntryId = String(entry?.id || `entry-${rawBranchIndex}`);
	const role = String(message.role || "other");
	const detailParts: ReplayLeafEntry[] = [];

	if (role === "user") {
		const text = extractTextParts(message.content).join("\n") || String(message.content || "");
		detailParts.push({
			id: `${rawEntryId}:user`,
			rawEntryId,
			kind: "user",
			label: "USER",
			summary: compactWords(text, 5, 60),
			detail: text || "(empty user message)",
			timestamp,
			rawBranchIndex,
			approxTokens: Math.max(4, estimateStringTokens(text || "user")),
			inContext: false,
		});
		return detailParts;
	}

	if (role === "assistant") {
		const thinkingBlocks = extractThinkingParts(message.content);
		for (const [idx, thought] of thinkingBlocks.entries()) {
			detailParts.push({
				id: `${rawEntryId}:thinking:${idx}`,
				rawEntryId,
				kind: "thinking",
				label: "THINK",
				summary: compactLine("System thinking block", 48),
				detail: thought || "(hidden system thinking)",
				timestamp,
				rawBranchIndex,
				approxTokens: Math.max(4, estimateStringTokens(thought || "thinking")),
				inContext: false,
			});
		}

		const text = extractTextParts(message.content).join("\n");
		if (text) {
			const structuredKind = detectStructuredContentKind(text);
			detailParts.push({
				id: `${rawEntryId}:assistant`,
				rawEntryId,
				kind: structuredKind === "experience" ? "experience" : structuredKind === "skill" ? "skill" : "assistant",
				label: structuredKind === "experience" ? "EXP" : structuredKind === "skill" ? "SKILL" : "ASSIST",
				summary: compactLine(text, 72),
				detail: text,
				timestamp,
				rawBranchIndex,
				approxTokens: Math.max(6, estimateStringTokens(text)),
				inContext: false,
			});
		}

		const toolCalls = extractToolCalls(message.content);
		for (const [idx, call] of toolCalls.entries()) {
			detailParts.push({
				id: `${rawEntryId}:tool-call:${idx}`,
				rawEntryId,
				kind: "tool-call",
				label: "CALL",
				summary: compactLine(`${call.name} ${call.argumentsText}`, 72),
				detail: `${call.name}\n\n${call.argumentsText}`,
				timestamp,
				rawBranchIndex,
				approxTokens: Math.max(6, estimateStringTokens(call.name + call.argumentsText)),
				inContext: false,
			});
		}

		if (detailParts.length === 0) {
			detailParts.push({
				id: `${rawEntryId}:assistant`,
				rawEntryId,
				kind: "assistant",
				label: "ASSIST",
				summary: compactLine(String(message.stopReason || "Assistant activity"), 48),
				detail: JSON.stringify(message, null, 2),
				timestamp,
				rawBranchIndex,
				approxTokens: 8,
				inContext: false,
			});
		}
		return detailParts;
	}

	if (role === "toolResult") {
		const toolName = String(message.toolName || "tool");
		const text = extractTextParts(message.content).join("\n") || String(message.content || JSON.stringify(message, null, 2));
		return [{
			id: `${rawEntryId}:tool-result`,
			rawEntryId,
			kind: "tool-result",
			label: "TOOL",
			summary: compactLine(`${toolName}: ${text}`, 72),
			detail: `${toolName}\n\n${text}`,
			timestamp,
			rawBranchIndex,
			approxTokens: Math.max(6, estimateStringTokens(toolName + text)),
			inContext: false,
		}];
	}

	return [{
		id: `${rawEntryId}:other`,
		rawEntryId,
		kind: "other",
		label: role.toUpperCase() || "OTHER",
		summary: compactLine(JSON.stringify(message), 72),
		detail: JSON.stringify(message, null, 2),
		timestamp,
		rawBranchIndex,
		approxTokens: 8,
		inContext: false,
	}];
}

function customEntryToLeafEntry(entry: any, rawBranchIndex: number): ReplayLeafEntry {
	const timestamp = normalizeReplayTimestamp(entry?.timestamp, entry?.data?.timestamp);
	const rawEntryId = String(entry?.id || `entry-${rawBranchIndex}`);
	const customType = String(entry?.customType || "custom");
	const dataText = JSON.stringify(entry?.data || {}, null, 2);
	if (customType === "om:state") {
		const payload = entry?.data?.state || {};
		const reflectionTokens = payload.totalReflectionTokens || payload.totalCompactedTokens || 0;
		const summary = `gen ${payload.generationCount || 0} · obs ~${payload.totalObservationTokens || 0} · refl ~${reflectionTokens}`;
		return {
			id: `${rawEntryId}:observation`,
			rawEntryId,
			kind: "observation",
			label: "OBS",
			summary,
			detail: dataText,
			timestamp,
			rawBranchIndex,
			approxTokens: Math.max(6, estimateStringTokens(summary)),
			inContext: false,
		};
	}
	if (customType === "om:diagnostic") {
		const phase = String(entry?.data?.phase || "diag");
		const message = String(entry?.data?.message || "diagnostic");
		return {
			id: `${rawEntryId}:diag`,
			rawEntryId,
			kind: "observation",
			label: "OBS",
			summary: compactLine(`${phase}: ${message}`, 72),
			detail: dataText,
			timestamp,
			rawBranchIndex,
			approxTokens: Math.max(4, estimateStringTokens(message)),
			inContext: false,
		};
	}
	if (customType === "om:rollover") {
		const reason = String(entry?.data?.reason || "rollover");
		return {
			id: `${rawEntryId}:rollover`,
			rawEntryId,
			kind: "system",
			label: "ROLL",
			summary: compactLine(`rollover ${reason}`, 56),
			detail: dataText,
			timestamp,
			rawBranchIndex,
			approxTokens: 8,
			inContext: false,
		};
	}
	const detectedKind = detectStructuredContentKind(dataText) || "system";
	const label = detectedKind === "experience" ? "EXP" : detectedKind === "skill" ? "SKILL" : "SYS";
	return {
		id: `${rawEntryId}:custom`,
		rawEntryId,
		kind: detectedKind,
		label,
		summary: compactLine(`${customType}: ${dataText}`, 72),
		detail: dataText,
		timestamp,
		rawBranchIndex,
		approxTokens: Math.max(4, estimateStringTokens(dataText)),
		inContext: false,
	};
}

function structuralEntryToLeafEntry(entry: any, rawBranchIndex: number): ReplayLeafEntry | null {
	const rawEntryId = String(entry?.id || `entry-${rawBranchIndex}`);
	const timestamp = normalizeReplayTimestamp(entry?.timestamp, entry?.message?.timestamp, entry?.details?.timestamp);
	if (entry?.type === "thinking_level_change") {
		const detail = `Thinking level → ${String(entry?.thinkingLevel || "unknown")}`;
		return {
			id: `${rawEntryId}:thinking-level`,
			rawEntryId,
			kind: "thinking",
			label: "THINK",
			summary: compactLine(detail, 56),
			detail,
			timestamp,
			rawBranchIndex,
			approxTokens: 4,
			inContext: false,
		};
	}
	if (entry?.type === "model_change") {
		const detail = `Model → ${String(entry?.provider || "")}/${String(entry?.modelId || "")}`;
		return {
			id: `${rawEntryId}:model`,
			rawEntryId,
			kind: "system",
			label: "MODEL",
			summary: compactLine(detail, 56),
			detail,
			timestamp,
			rawBranchIndex,
			approxTokens: 4,
			inContext: false,
		};
	}
	if (entry?.type === "session_info") {
		const detail = `Session name → ${String(entry?.name || "(unnamed)")}`;
		return {
			id: `${rawEntryId}:session-info`,
			rawEntryId,
			kind: "system",
			label: "SESSION",
			summary: compactLine(detail, 56),
			detail,
			timestamp,
			rawBranchIndex,
			approxTokens: 4,
			inContext: false,
		};
	}
	if (entry?.type === "custom_message") {
		const detail = JSON.stringify(entry, null, 2);
		const detectedKind = detectStructuredContentKind(detail) || "system";
		return {
			id: `${rawEntryId}:custom-message`,
			rawEntryId,
			kind: detectedKind,
			label: detectedKind === "experience" ? "EXP" : detectedKind === "skill" ? "SKILL" : "SYS",
			summary: compactLine(detail, 72),
			detail,
			timestamp,
			rawBranchIndex,
			approxTokens: Math.max(4, estimateStringTokens(detail)),
			inContext: false,
		};
	}
	return null;
}

function entryToLeafEntries(entry: any, rawBranchIndex: number): ReplayLeafEntry[] {
	if (entry?.type === "message") {
		return messageToLeafEntries(entry, rawBranchIndex);
	}
	if (entry?.type === "custom") {
		return [customEntryToLeafEntry(entry, rawBranchIndex)];
	}
	const structural = structuralEntryToLeafEntry(entry, rawBranchIndex);
	return structural ? [structural] : [];
}

function badgeOrder(entryKinds: Set<ReplayEntryKind>): string[] {
	const order: Array<[ReplayEntryKind, string]> = [
		["user", "USER"],
		["assistant", "ASSIST"],
		["tool-call", "CALL"],
		["tool-result", "TOOL"],
		["observation", "OBS"],
		["thinking", "THINK"],
		["experience", "EXP"],
		["skill", "SKILL"],
		["system", "SYS"],
		["other", "OTHER"],
	];
	return order.filter(([kind]) => entryKinds.has(kind)).map(([, label]) => label);
}

function estimateRawEntryTokens(entry: any): number {
	if (entry?.type === "message") {
		const message = entry?.message || {};
		const texts = extractTextParts(message.content).join("\n");
		const toolCalls = extractToolCalls(message.content)
			.map((call) => `${call.name} ${call.argumentsText}`)
			.join("\n");
		const toolName = typeof message.toolName === "string" ? message.toolName : "";
		const combined = `${texts}\n${toolCalls}\n${toolName}`.trim();
		return Math.max(6, estimateStringTokens(combined || JSON.stringify(message)) + 8);
	}
	if (entry?.type === "custom") {
		return Math.max(6, estimateStringTokens(JSON.stringify(entry?.data || {})) + 4);
	}
	return 4;
}

function resolveMessageOrdinalToRawIndex(branchEntries: any[], messageIndex: number): number {
	if (messageIndex <= 0) return 0;
	let ordinal = 0;
	for (let index = 0; index < branchEntries.length; index++) {
		if (branchEntries[index]?.type !== "message") continue;
		if (ordinal >= messageIndex) {
			return index;
		}
		ordinal += 1;
	}
	return branchEntries.length > 0 ? branchEntries.length - 1 : 0;
}

function estimateContextStartRawIndex(branchEntries: any[], contextUsage?: ReplayContextUsage): number {
	const explicitTokens =
		typeof contextUsage?.tokens === "number" && Number.isFinite(contextUsage.tokens) && contextUsage.tokens > 0
			? contextUsage.tokens
			: typeof contextUsage?.percent === "number" && typeof contextUsage?.contextWindow === "number"
				? Math.floor((contextUsage.percent / 100) * contextUsage.contextWindow)
				: 0;
	if (!explicitTokens || branchEntries.length === 0) return 0;
	let total = 0;
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		total += estimateRawEntryTokens(branchEntries[index]);
		if (total >= explicitTokens) {
			return index;
		}
	}
	return 0;
}

export function buildReplayModel(branchEntries: any[], options: BuildReplayModelOptions = {}): ReplayModel {
	const contextUsage = options.contextUsage || {};
	const omStartRawIndex = resolveMessageOrdinalToRawIndex(branchEntries, Math.max(0, options.omMessageStartIndex || 0));
	const usageStartRawIndex = estimateContextStartRawIndex(branchEntries, contextUsage);
	const contextStartRawIndex = Math.max(omStartRawIndex, usageStartRawIndex);

	const groups: ReplayGroup[] = [];
	let currentGroup: ReplayGroup | null = null;
	let systemGroupCount = 0;
	let turnCount = 0;
	let totalMessageEntries = 0;

	for (let rawIndex = 0; rawIndex < branchEntries.length; rawIndex++) {
		const entry = branchEntries[rawIndex];
		if (entry?.type === "message") totalMessageEntries += 1;
		const leafEntries = entryToLeafEntries(entry, rawIndex);
		for (const leaf of leafEntries) {
			const startsTurn = leaf.kind === "user";
			if (startsTurn || !currentGroup) {
				if (startsTurn) {
					turnCount += 1;
					currentGroup = {
						id: `turn-${turnCount}`,
						kind: "turn",
						title: `Turn ${turnCount}`,
						summary: leaf.summary,
						timestamp: leaf.timestamp,
						badges: [],
						entries: [],
						rawEntryStartIndex: rawIndex,
						rawEntryEndIndex: rawIndex,
						inContext: false,
						isContextStart: false,
					};
				} else {
					systemGroupCount += 1;
					currentGroup = {
						id: `system-${systemGroupCount}`,
						kind: "system",
						title: `System ${systemGroupCount}`,
						summary: leaf.summary,
						timestamp: leaf.timestamp,
						badges: [],
						entries: [],
						rawEntryStartIndex: rawIndex,
						rawEntryEndIndex: rawIndex,
						inContext: false,
						isContextStart: false,
					};
				}
				groups.push(currentGroup);
			}
			leaf.inContext = leaf.rawBranchIndex >= contextStartRawIndex;
			currentGroup.entries.push(leaf);
			currentGroup.rawEntryEndIndex = Math.max(currentGroup.rawEntryEndIndex, rawIndex);
			if (leaf.rawBranchIndex < currentGroup.rawEntryStartIndex) {
				currentGroup.rawEntryStartIndex = leaf.rawBranchIndex;
			}
		}
	}

	let contextStartGroupIndex = groups.length > 0 ? groups.length - 1 : 0;
	for (let index = 0; index < groups.length; index++) {
		const group = groups[index];
		group.inContext = group.entries.some((entry) => entry.inContext) || group.rawEntryEndIndex >= contextStartRawIndex;
		group.isContextStart = group.rawEntryStartIndex <= contextStartRawIndex && group.rawEntryEndIndex >= contextStartRawIndex;
		if (group.isContextStart) {
			contextStartGroupIndex = index;
		}
		group.badges = badgeOrder(new Set(group.entries.map((entry) => entry.kind)));
		if (!group.summary) {
			group.summary = group.entries[0]?.summary || "(empty group)";
		}
	}

	return {
		sessionName: options.sessionName || "(unnamed session)",
		sessionFilePath: options.sessionFilePath || "",
		groups,
		contextUsage,
		contextStartRawIndex,
		contextStartGroupIndex,
		omStartRawIndex,
		totalRawEntries: branchEntries.length,
		totalMessageEntries,
	};
}

export type ReplayVisibleRow =
	| { type: "group"; groupIndex: number; inContext: boolean; isContextStart: boolean }
	| { type: "entry"; groupIndex: number; entryIndex: number; inContext: boolean };

export function buildVisibleRows(model: ReplayModel, expandedGroupIds: Set<string>, contextOnly: boolean): ReplayVisibleRow[] {
	const rows: ReplayVisibleRow[] = [];
	for (let groupIndex = 0; groupIndex < model.groups.length; groupIndex++) {
		const group = model.groups[groupIndex];
		if (contextOnly && !group.inContext) continue;
		rows.push({
			type: "group",
			groupIndex,
			inContext: group.inContext,
			isContextStart: group.isContextStart,
		});
		if (expandedGroupIds.has(group.id)) {
			for (let entryIndex = 0; entryIndex < group.entries.length; entryIndex++) {
				const entry = group.entries[entryIndex];
				rows.push({
					type: "entry",
					groupIndex,
					entryIndex,
					inContext: entry.inContext,
				});
			}
		}
	}
	return rows;
}
