import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	OmExperienceItem,
	OmExperienceOp,
	OmObservationItem,
	ObservationalMemoryConfig,
} from "./types";

export interface ToolTrajectoryEvidence {
	toolNames: string[];
	rawText: string;
	observationText: string;
	hasPythonFallback: boolean;
	hasStackTraceTargeting: boolean;
	hasProjectPathFact: boolean;
}

function normalizeText(text: string): string {
	return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeForSimilarity(text: string): string[] {
	return normalizeText(text)
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

function unique<T>(values: T[]): T[] {
	return Array.from(new Set(values));
}

function extractMessageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((part: any) => {
				if (part?.type === "text") return String(part.text || "");
				if (part?.type === "toolCall") {
					return `${String(part.name || "")} ${JSON.stringify(part.arguments || {})}`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function extractToolNames(messages: AgentMessage[]): string[] {
	const names: string[] = [];
	for (const message of messages as any[]) {
		if (Array.isArray(message?.content)) {
			for (const part of message.content) {
				if (part?.type === "toolCall" && typeof part.name === "string") {
					names.push(part.name.trim().toLowerCase());
				}
			}
		}
		if (message?.role === "toolResult" && typeof message?.toolName === "string") {
			names.push(message.toolName.trim().toLowerCase());
		}
	}
	return unique(names.filter(Boolean));
}

function wordCount(text: string): number {
	return normalizeText(text).split(/\s+/).filter(Boolean).length;
}

function containsProjectFact(text: string): boolean {
	const normalized = normalizeText(text).toLowerCase();
	return /\b(ghostclaw|keepa|observationalmemorytab|memory\.md|skill\.md|src\/|extensions\/|\.ts\b|\.md\b|amazon\.|linkedin)\b/.test(normalized);
}

function hasConditionPrefix(text: string): boolean {
	return /^(when|if|for|after|before)\b/i.test(normalizeText(text));
}

function hasActionLanguage(text: string): boolean {
	return /\b(run|retry|search|grep|rg|read|inspect|open|use|switch|check|target)\b/i.test(text);
}

function hasToolLanguage(text: string): boolean {
	return /\b(tool|command|bash|python3?|stack trace|stack frame|symbol|grep|rg|read|test)\b/i.test(text);
}

function jaccardSimilarity(a: string, b: string): number {
	const left = new Set(normalizeForSimilarity(a));
	const right = new Set(normalizeForSimilarity(b));
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	return intersection / (left.size + right.size - intersection);
}

export function extractToolTrajectoryEvidence(rawMessages: AgentMessage[], observationItems: OmObservationItem[] = []): ToolTrajectoryEvidence {
	const rawText = rawMessages.map((message) => extractMessageText(message)).join("\n");
	const observationText = observationItems.map((item) => item.text).join("\n\n");
	const lowerRaw = rawText.toLowerCase();
	const lowerObs = observationText.toLowerCase();
	const hasPythonFallback =
		/(python[^\n]*command not found|python[^\n]*not found|python[^\n]*no such file)/i.test(rawText) &&
		/\bpython3\b/i.test(rawText);
	const hasStackTraceTargeting =
		/(stack trace|traceback| at .*:\d+|\.tsx?:\d+)/i.test(rawText) &&
		/(grep|rg|search|read|open)/i.test(lowerRaw + "\n" + lowerObs);
	const hasProjectPathFact = containsProjectFact(rawText) || containsProjectFact(observationText);
	return {
		toolNames: extractToolNames(rawMessages),
		rawText,
		observationText,
		hasPythonFallback,
		hasStackTraceTargeting,
		hasProjectPathFact,
	};
}

export function buildExperienceCritiquePrompt(args: {
	evidence: ToolTrajectoryEvidence;
	existingExperiences: OmExperienceItem[];
	config: ObservationalMemoryConfig;
}): string {
	return [
		"Extract only generalizable tool-use experiences.",
		"Rules: under 64 words, condition-action form, no project facts, no file paths, no user facts.",
		"Allowed operations: add, modify, merge.",
		"Output JSON array only.",
		`Existing experiences: ${args.existingExperiences.map((item) => `[${item.id}] ${item.text}`).join(" | ") || "(none)"}`,
		`Observation evidence: ${args.evidence.observationText || "(none)"}`,
		`Raw evidence: ${args.evidence.rawText || "(none)"}`,
	].join("\n");
}

export function parseExperienceOps(text: string): OmExperienceOp[] {
	const trimmed = String(text || "").trim();
	if (!trimmed) return [];
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced?.[1]?.trim() || trimmed;
	try {
		const parsed = JSON.parse(candidate);
		return Array.isArray(parsed) ? (parsed as OmExperienceOp[]) : [];
	} catch {
		return [];
	}
}

export function qualifiesAsExperience(text: string, evidence: ToolTrajectoryEvidence, config: ObservationalMemoryConfig): boolean {
	const normalized = normalizeText(text);
	if (!normalized) return false;
	if (!hasConditionPrefix(normalized)) return false;
	if (wordCount(normalized) > config.experiences.maxWords) return false;
	if (containsProjectFact(normalized)) return false;
	if (!hasActionLanguage(normalized)) return false;
	if (!hasToolLanguage(normalized)) return false;
	if (evidence.hasProjectPathFact && /(ghostclaw|src\/|extensions\/|observationalmemorytab|memory\.md|skill\.md)/i.test(normalized)) {
		return false;
	}
	return Boolean(evidence.hasPythonFallback || evidence.hasStackTraceTargeting || evidence.toolNames.length > 0 || evidence.observationText);
}

function nextExperienceId(items: OmExperienceItem[]): string {
	const max = items.reduce((highest, item) => {
		const match = item.id.match(/(\d+)$/);
		return Math.max(highest, match ? Number(match[1]) : 0);
	}, 0);
	return `E${String(max + 1).padStart(6, "0")}`;
}

export function applyExperienceOps(args: {
	existingExperiences: OmExperienceItem[];
	ops: OmExperienceOp[];
	evidence: ToolTrajectoryEvidence;
	observationItems: OmObservationItem[];
	rawMessageRange?: { messageStartIndex: number; messageEndIndex: number };
	config: ObservationalMemoryConfig;
}): OmExperienceItem[] {
	const next = args.existingExperiences.map((item) => ({ ...item, sourceObservationIds: [...item.sourceObservationIds] }));
	const now = new Date().toISOString();
	for (const op of args.ops) {
		if (!qualifiesAsExperience(op.experience, args.evidence, args.config)) continue;
		const normalized = normalizeText(op.experience);
		if (next.some((item) => normalizeText(item.text).toLowerCase() === normalized.toLowerCase())) {
			continue;
		}
		if (op.option === "modify") {
			const index = next.findIndex((item) => item.id === op.modifiedFrom);
			if (index >= 0) {
				next[index] = {
					...next[index],
					text: normalized,
					updatedAt: now,
					modifiedFrom: op.modifiedFrom,
					sourceObservationIds: args.observationItems.map((item) => item.id),
					sourceRawMessageRange: args.rawMessageRange,
				};
			}
			continue;
		}
		if (op.option === "merge") {
			const mergedIds = unique(op.mergedFrom.filter(Boolean));
			if (mergedIds.length === 0) continue;
			const survivors = next.filter((item) => !mergedIds.includes(item.id));
			const keepId = [...mergedIds].sort()[0]!;
			survivors.push({
				id: keepId,
				text: normalized,
				createdAt: now,
				updatedAt: now,
				sourceObservationIds: args.observationItems.map((item) => item.id),
				sourceRawMessageRange: args.rawMessageRange,
				mergedFrom: mergedIds,
			});
			next.splice(0, next.length, ...survivors.sort((a, b) => a.id.localeCompare(b.id)));
			continue;
		}
		next.push({
			id: nextExperienceId(next),
			text: normalized,
			createdAt: now,
			updatedAt: now,
			sourceObservationIds: args.observationItems.map((item) => item.id),
			sourceRawMessageRange: args.rawMessageRange,
		});
	}
	return next;
}

function deriveDeterministicOps(args: {
	evidence: ToolTrajectoryEvidence;
	existingExperiences: OmExperienceItem[];
	config: ObservationalMemoryConfig;
}): OmExperienceOp[] {
	const candidates: string[] = [];
	if (args.evidence.hasPythonFallback) {
		candidates.push("When a bash command fails because python is unavailable, retry with python3 before changing the script logic.");
	}
	if (args.evidence.hasStackTraceTargeting) {
		candidates.push("When tests fail with stack traces, run the failing command first, then use named files, symbols, or stack frames to search before editing.");
	}
	const ops: OmExperienceOp[] = [];
	for (const candidate of candidates.slice(0, Math.max(0, args.config.experiences.maxOpsPerObservation))) {
		const similar = args.existingExperiences
			.map((item) => ({ item, similarity: jaccardSimilarity(item.text, candidate) }))
			.sort((a, b) => b.similarity - a.similarity);
		const best = similar[0];
		if (best && best.similarity >= args.config.experiences.mergeSimilarityThreshold) {
			ops.push({ option: "modify", modifiedFrom: best.item.id, experience: candidate });
		} else {
			ops.push({ option: "add", experience: candidate });
		}
	}
	return ops;
}

export async function deriveExperiencesAfterObservation(args: {
	rawMessages: AgentMessage[];
	observationItems: OmObservationItem[];
	existingExperiences: OmExperienceItem[];
	config: ObservationalMemoryConfig;
	rawMessageRange?: { messageStartIndex: number; messageEndIndex: number };
}): Promise<{ ops: OmExperienceOp[]; nextExperiences: OmExperienceItem[]; evidence: ToolTrajectoryEvidence }> {
	const evidence = extractToolTrajectoryEvidence(args.rawMessages, args.observationItems);
	if (args.observationItems.length === 0) {
		return { ops: [], nextExperiences: args.existingExperiences, evidence };
	}
	const ops = deriveDeterministicOps({
		evidence,
		existingExperiences: args.existingExperiences,
		config: args.config,
	});
	const nextExperiences = applyExperienceOps({
		existingExperiences: args.existingExperiences,
		ops,
		evidence,
		observationItems: args.observationItems,
		rawMessageRange: args.rawMessageRange,
		config: args.config,
	});
	return { ops, nextExperiences, evidence };
}

