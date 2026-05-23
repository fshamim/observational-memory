import * as fs from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExperienceBankConfig, ExperienceBankIndex, ExperienceRank, ExperienceRecord, ExperienceStatus } from "../types";
import { getExperienceIndexPath, getExperienceItemsDir, writeJsonFileAtomic } from "./om-paths";

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function normalizeWordList(values: string[]): string[] {
	return Array.from(
		new Set(
			values
				.map((value) => value.trim().toLowerCase())
				.filter(Boolean),
		),
	).sort();
}

function getDefaultIndex(): ExperienceBankIndex {
	return { version: 1, nextId: 1, items: [] };
}

function getItemPath(cwd: string, id: string): string {
	return `${getExperienceItemsDir(cwd)}/${id}.json`;
}

export function loadExperienceIndex(cwd = process.cwd()): ExperienceBankIndex {
	const filePath = getExperienceIndexPath(cwd);
	try {
		if (fs.existsSync(filePath)) {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (raw && typeof raw === "object" && Array.isArray(raw.items) && typeof raw.nextId === "number") {
				return raw as ExperienceBankIndex;
			}
		}
	} catch {
		// ignore invalid files and recreate later
	}
	return getDefaultIndex();
}

export function saveExperienceIndex(index: ExperienceBankIndex, cwd = process.cwd()): void {
	writeJsonFileAtomic(getExperienceIndexPath(cwd), index);
}

export function loadExperienceRecord(id: string, cwd = process.cwd()): ExperienceRecord | null {
	try {
		const filePath = getItemPath(cwd, id);
		if (!fs.existsSync(filePath)) return null;
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return raw as ExperienceRecord;
	} catch {
		return null;
	}
}

export function listExperienceRecords(cwd = process.cwd()): ExperienceRecord[] {
	const index = loadExperienceIndex(cwd);
	return index.items
		.map((item) => loadExperienceRecord(item.id, cwd))
		.filter((item): item is ExperienceRecord => Boolean(item));
}

function inferRank(record: Pick<ExperienceRecord, "status" | "score" | "retrievedCount">): ExperienceRank {
	if (record.status === "trusted") return "trusted";
	if (record.retrievedCount <= 0) return "never-used";
	if (record.score >= 80) return "trusted";
	if (record.score >= 55) return "high";
	if (record.score >= 25) return "medium";
	return "low";
}

function ensureStatus(score: number, previousStatus: ExperienceStatus): ExperienceStatus {
	if (previousStatus === "merged" || previousStatus === "deprecated") return previousStatus;
	if (score >= 80) return "trusted";
	if (score >= 20) return previousStatus === "candidate" ? "active" : previousStatus;
	return previousStatus;
}

function computeScore(record: ExperienceRecord): number {
	return (
		record.helpedCount * 20 +
		record.appliedCount * 8 +
		record.retrievedCount * 2 -
		record.hurtCount * 18 -
		record.ignoredCount * 3
	);
}

function writeRecord(record: ExperienceRecord, cwd = process.cwd()): void {
	writeJsonFileAtomic(getItemPath(cwd, record.id), record);
}

function findExistingBySignature(text: string, toolNames: string[], cwd = process.cwd()): ExperienceRecord | null {
	const normalizedText = normalizeText(text).toLowerCase();
	const tools = normalizeWordList(toolNames);
	for (const record of listExperienceRecords(cwd)) {
		if (normalizeText(record.text).toLowerCase() !== normalizedText) continue;
		if (JSON.stringify(normalizeWordList(record.toolNames)) !== JSON.stringify(tools)) continue;
		return record;
	}
	return null;
}

export function upsertExperienceCandidate(
	candidate: Omit<ExperienceRecord, "id" | "createdAt" | "updatedAt" | "score" | "rank" | "retrievedCount" | "appliedCount" | "helpedCount" | "hurtCount" | "ignoredCount">,
	cwd = process.cwd(),
): ExperienceRecord {
	const existing = findExistingBySignature(candidate.text, candidate.toolNames, cwd);
	if (existing) {
		existing.updatedAt = nowIso();
		writeRecord(existing, cwd);
		return existing;
	}
	const index = loadExperienceIndex(cwd);
	const id = `E${String(index.nextId).padStart(6, "0")}`;
	const createdAt = nowIso();
	const record: ExperienceRecord = {
		...candidate,
		id,
		text: normalizeText(candidate.text),
		toolNames: normalizeWordList(candidate.toolNames),
		triggerPatterns: normalizeWordList(candidate.triggerPatterns),
		createdAt,
		updatedAt: createdAt,
		retrievedCount: 0,
		appliedCount: 0,
		helpedCount: 0,
		hurtCount: 0,
		ignoredCount: 0,
		score: 0,
		rank: "never-used",
		status: candidate.status,
	};
	writeRecord(record, cwd);
	index.items.push({ id, status: record.status, score: record.score, rank: record.rank });
	index.nextId += 1;
	saveExperienceIndex(index, cwd);
	return record;
}

function updateIndexRecord(record: ExperienceRecord, cwd = process.cwd()): void {
	const index = loadExperienceIndex(cwd);
	const item = index.items.find((entry) => entry.id === record.id);
	if (item) {
		item.status = record.status;
		item.score = record.score;
		item.rank = record.rank;
	} else {
		index.items.push({ id: record.id, status: record.status, score: record.score, rank: record.rank });
	}
	saveExperienceIndex(index, cwd);
}

export function registerExperienceRetrieval(ids: string[], cwd = process.cwd()): void {
	for (const id of ids) {
		const record = loadExperienceRecord(id, cwd);
		if (!record) continue;
		record.retrievedCount += 1;
		record.score = computeScore(record);
		record.rank = inferRank(record);
		record.status = ensureStatus(record.score, record.status);
		record.updatedAt = nowIso();
		writeRecord(record, cwd);
		updateIndexRecord(record, cwd);
	}
}

export function registerExperienceOutcome(
	ids: string[],
	outcome: "helped" | "hurt" | "ignored",
	appliedIds: string[] = [],
	cwd = process.cwd(),
): void {
	const appliedSet = new Set(appliedIds);
	for (const id of ids) {
		const record = loadExperienceRecord(id, cwd);
		if (!record) continue;
		const applied = appliedSet.has(id);
		if (applied) {
			record.appliedCount += 1;
		}
		if (outcome === "helped" && applied) record.helpedCount += 1;
		if (outcome === "hurt" && applied) record.hurtCount += 1;
		if (outcome === "ignored" && !applied) record.ignoredCount += 1;
		record.score = computeScore(record);
		record.rank = inferRank(record);
		record.status = ensureStatus(record.score, record.status);
		record.updatedAt = nowIso();
		writeRecord(record, cwd);
		updateIndexRecord(record, cwd);
	}
}

function extractToolNamesFromMessage(message: AgentMessage): string[] {
	const names: string[] = [];
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part?.type === "toolCall" && typeof part.name === "string" && part.name.trim()) {
				names.push(part.name.trim().toLowerCase());
			}
		}
	}
	if ((message as any)?.role === "toolResult" && typeof (message as any)?.toolName === "string") {
		names.push(String((message as any).toolName).trim().toLowerCase());
	}
	return normalizeWordList(names);
}

function extractUserText(messages: AgentMessage[]): string {
	return messages
		.filter((message: any) => message?.role === "user")
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			if (Array.isArray(message.content)) {
				return message.content
					.map((part: any) => (part?.type === "text" ? String(part.text || "") : ""))
					.join("\n");
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
}

export function deriveExperienceCandidatesFromMessages(params: {
	messages: AgentMessage[];
	sourceSessionName: string;
	sourceSessionPath?: string;
	coveredEntryIds: string[];
	entryIdStart?: string;
	entryIdEnd?: string;
}): ExperienceRecord[] {
	const { messages } = params;
	const created: ExperienceRecord[] = [];
	const userText = extractUserText(messages);
	const explicitPreference = userText.match(/(?:use|prefer)\s+([a-z0-9_.-]+).*?(?:instead of|rather than|not)\s+([a-z0-9_.-]+)/i);
	if (explicitPreference) {
		created.push({
			id: "",
			kind: "decision_rule",
			text: `When a user explicitly corrects tool choice, prefer ${explicitPreference[1]} over ${explicitPreference[2]} for the current task family.`,
			toolNames: [explicitPreference[1], explicitPreference[2]],
			triggerPatterns: ["user correction", "tool preference"],
			status: "candidate",
			score: 0,
			rank: "never-used",
			retrievedCount: 0,
			appliedCount: 0,
			helpedCount: 0,
			hurtCount: 0,
			ignoredCount: 0,
			createdAt: "",
			updatedAt: "",
			source: {
				sourceSessionName: params.sourceSessionName,
				sourceSessionPath: params.sourceSessionPath,
				entryIdStart: params.entryIdStart,
				entryIdEnd: params.entryIdEnd,
				coveredEntryIds: [...params.coveredEntryIds],
			},
			supersedes: [],
		});
	}

	for (let i = 0; i < messages.length - 2; i++) {
		const first = messages[i] as any;
		const second = messages[i + 1] as any;
		const third = messages[i + 2] as any;
		const firstTools = extractToolNamesFromMessage(first);
		const thirdTools = extractToolNamesFromMessage(third);
		const secondErrorText = normalizeText(String(second?.errorMessage || second?.content || "")).toLowerCase();
		if (first?.role !== "assistant" || second?.role !== "toolResult" || third?.role !== "assistant") continue;
		if (firstTools.length === 0 || thirdTools.length === 0) continue;
		if (firstTools[0] === thirdTools[0]) continue;
		if (!/error|failed|not found|timeout|denied|invalid|exceed/.test(secondErrorText)) continue;
		created.push({
			id: "",
			kind: "execution_tip",
			text: `When ${firstTools[0]} fails with an execution error, consider switching to ${thirdTools[0]} as a nearby fallback strategy.`,
			toolNames: [firstTools[0], thirdTools[0]],
			triggerPatterns: ["tool failure", "fallback"],
			status: "candidate",
			score: 0,
			rank: "never-used",
			retrievedCount: 0,
			appliedCount: 0,
			helpedCount: 0,
			hurtCount: 0,
			ignoredCount: 0,
			createdAt: "",
			updatedAt: "",
			source: {
				sourceSessionName: params.sourceSessionName,
				sourceSessionPath: params.sourceSessionPath,
				entryIdStart: params.entryIdStart,
				entryIdEnd: params.entryIdEnd,
				coveredEntryIds: [...params.coveredEntryIds],
			},
			supersedes: [],
		});
		break;
	}

	const deduped = new Map<string, ExperienceRecord>();
	for (const record of created) {
		const key = `${normalizeText(record.text).toLowerCase()}|${normalizeWordList(record.toolNames).join(",")}`;
		if (!deduped.has(key)) deduped.set(key, record);
	}
	return Array.from(deduped.values());
}

function scoreExperience(record: ExperienceRecord, inputText: string, toolHints: string[]): number {
	let score = record.score;
	const normalizedText = inputText.toLowerCase();
	for (const toolName of record.toolNames) {
		if (toolHints.includes(toolName) || normalizedText.includes(toolName)) {
			score += 20;
		}
	}
	for (const pattern of record.triggerPatterns) {
		if (normalizedText.includes(pattern)) {
			score += 8;
		}
	}
	return score;
}

export function selectRelevantExperiences(params: {
	cwd?: string;
	text: string;
	toolHints?: string[];
	config: ExperienceBankConfig;
}): ExperienceRecord[] {
	const cwd = params.cwd || process.cwd();
	const toolHints = normalizeWordList(params.toolHints || []);
	const records = listExperienceRecords(cwd)
		.filter((record) => record.status !== "deprecated" && record.score >= params.config.minScoreToInject)
		.map((record) => ({ record, score: scoreExperience(record, params.text, toolHints) }))
		.filter(({ score }) => score >= params.config.minScoreToInject)
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, params.config.maxInjectedExperiences));
	const selected = records.map(({ record }) => record);
	if (selected.length > 0) {
		registerExperienceRetrieval(selected.map((record) => record.id), cwd);
	}
	return selected;
}

export function formatExperiencesForPrompt(records: ExperienceRecord[], maxTextChars: number): string {
	if (records.length === 0) return "";
	return records
		.map((record) => {
			const text = record.text.length > maxTextChars ? `${record.text.slice(0, maxTextChars)}...` : record.text;
			return `- [${record.id}] ${text}`;
		})
		.join("\n");
}
