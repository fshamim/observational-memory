import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ObservationalMemoryConfig } from "./types";
import type { RequestAuth } from "./auth";
import { estimateStringTokens } from "./token-estimator";
import { validateReflectedObservations } from "./reflection-guard";
import { getProjectOmDir } from "./lib/om-paths";

export interface OmCompareArgs {
	sessionPath: string;
	sampleCount: number;
	minInputTokens: number;
	timeoutMs?: number;
	promptTokenLimit?: number;
	reportPath?: string;
}

export interface OmComparisonSample {
	sampleId: string;
	sessionPath: string;
	entryId: string;
	timestamp: string;
	lineNumber: number;
	eventType: string;
	generationCount: number;
	activeObservations: string;
	existingCompacted: string;
	activeObservationTokens: number;
	compactedObservationTokens: number;
	inputTokens: number;
}

export type CompressionAlgorithm = "reflector" | "caveman" | "reobserve";

export interface CompressionArmResult {
	algorithm: CompressionAlgorithm;
	success: boolean;
	error?: string;
	outputText: string;
	outputTokens: number;
	tokenReductionPercent: number;
	signalRetentionPercent: number;
	lossinessPercentEstimate: number;
	deadOutputTokensEstimate: number;
	deadOutputPercentEstimate: number;
	meaningfulContextGainTokensEstimate: number;
	meaningfulContextGainPercentEstimate: number;
	formatRetention: {
		dateRecall: number;
		bulletCoverage: number;
		completionRecall: number;
		taskRetention: number;
		anchorRecall: number;
		keywordRecall: number;
	};
	qualityScore: number;
	hardFailure: boolean;
	hardFailureReason?: string;
}

export interface CompressionSampleComparisonResult {
	sample: OmComparisonSample;
	reflector: CompressionArmResult;
	caveman: CompressionArmResult;
	reobserve: CompressionArmResult;
	recommendedWinner: CompressionAlgorithm | "tie";
}

export interface CompressionArmAggregate {
	algorithm: CompressionAlgorithm;
	sampleCount: number;
	successCount: number;
	hardFailureCount: number;
	hardFailureRatePercent: number;
	medianTokenReductionPercent: number;
	medianSignalRetentionPercent: number;
	medianLossinessPercentEstimate: number;
	p90LossinessPercentEstimate: number;
	medianMeaningfulContextGainPercentEstimate: number;
	meanMeaningfulContextGainTokensEstimate: number;
	meanDeadOutputPercentEstimate: number;
	overallScore: number;
}

export interface DecisionMatrixCriterion {
	criterion: string;
	threshold: string;
	reflector: { value: string; pass: boolean };
	caveman: { value: string; pass: boolean };
	reobserve: { value: string; pass: boolean };
}

export interface CompressionDecisionMatrix {
	criteria: DecisionMatrixCriterion[];
	recommendation:
		| "keep_reflector"
		| "candidate_caveman"
		| "candidate_reobserve"
		| "collect_more_samples";
	reason: string;
}
export interface CompressionComparisonReport {
	createdAt: string;
	projectCwd: string;
	sessionPath: string;
	configSnapshot: {
		reflectorModel: { provider: string; modelId: string };
		reflectorPromptTokenLimit: number;
		reflectorTimeoutMs: number;
		reflectionTriggerContextPercent: number;
		reflectionTargetContextPercent: number;
	};
	compareOptions: {
		sampleCount: number;
		minInputTokens: number;
		timeoutMs: number;
		promptTokenLimit: number;
	};
	samples: CompressionSampleComparisonResult[];
	aggregate: {
		reflector: CompressionArmAggregate;
		caveman: CompressionArmAggregate;
		reobserve: CompressionArmAggregate;
	};
	decisionMatrix: CompressionDecisionMatrix;
}

function asNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	const parsed = typeof value === "number" ? value : parseInt(String(value || ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function formatPercent(value: number, digits = 1): string {
	return `${value.toFixed(digits)}%`;
}

function formatNumber(value: number, digits = 1): string {
	return Number.isFinite(value) ? value.toFixed(digits) : "0.0";
}

function truncateForReport(text: string, maxChars = 4000): string {
	const value = String(text || "");
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 48))}\n...[truncated ${value.length - maxChars} chars for report]`;
}

function extractQueueText(items: any): string {
	if (!Array.isArray(items)) return "";
	return items
		.map((item) => String(item?.text || "").trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function getSerializedObservationText(state: any): string {
	return String(state?.activeObservations || "").trim() || extractQueueText(state?.observations);
}

function getSerializedReflectionText(state: any): string {
	return String(state?.compactedObservations || "").trim() || extractQueueText(state?.reflections);
}

function sanitizeSampleForReport(sample: OmComparisonSample): OmComparisonSample {
	return {
		...sample,
		activeObservations: truncateForReport(sample.activeObservations, 2400),
		existingCompacted: truncateForReport(sample.existingCompacted, 2400),
	};
}

function sanitizeArmResultForReport(result: CompressionArmResult): CompressionArmResult {
	return {
		...result,
		outputText: truncateForReport(result.outputText, 3200),
	};
}

export function parseOmCompareArgs(rawArgs: string, fallbackSessionPath: string): OmCompareArgs {
	const tokens = String(rawArgs || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	let sessionPath = fallbackSessionPath || "";
	let sampleCount = 6;
	let minInputTokens = 20000;
	let timeoutMs: number | undefined;
	let promptTokenLimit: number | undefined;
	let reportPath: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--session") {
			sessionPath = tokens[i + 1] || sessionPath;
			i += 1;
			continue;
		}
		if (token === "--samples") {
			sampleCount = asNumber(tokens[i + 1], sampleCount, 1, 50);
			i += 1;
			continue;
		}
		if (token === "--min-tokens") {
			minInputTokens = asNumber(tokens[i + 1], minInputTokens, 1000, 400000);
			i += 1;
			continue;
		}
		if (token === "--timeout-ms") {
			timeoutMs = asNumber(tokens[i + 1], timeoutMs || 120000, 10000, 15 * 60 * 1000);
			i += 1;
			continue;
		}
		if (token === "--prompt-limit") {
			promptTokenLimit = asNumber(tokens[i + 1], promptTokenLimit || 140000, 8000, 400000);
			i += 1;
			continue;
		}
		if (token === "--report") {
			reportPath = tokens[i + 1] || reportPath;
			i += 1;
			continue;
		}
		if (token.startsWith("--")) {
			continue;
		}
		positional.push(token);
	}

	if (positional.length > 0) {
		if (/^\d+$/.test(positional[0])) {
			sampleCount = asNumber(positional[0], sampleCount, 1, 50);
		} else {
			sessionPath = positional[0];
		}
	}
	if (positional.length > 1 && /^\d+$/.test(positional[1])) {
		sampleCount = asNumber(positional[1], sampleCount, 1, 50);
	}

	if (!sessionPath) {
		throw new Error("Missing session file path. Use /om compare --session <path> [--samples N]");
	}

	const resolvedSessionPath = path.resolve(sessionPath);
	if (!fs.existsSync(resolvedSessionPath)) {
		throw new Error(`Session file not found: ${resolvedSessionPath}`);
	}

	return {
		sessionPath: resolvedSessionPath,
		sampleCount,
		minInputTokens,
		timeoutMs,
		promptTokenLimit,
		reportPath: reportPath ? path.resolve(reportPath) : undefined,
	};
}

function buildCombinedInput(observations: string, existingCompacted: string): string {
	return existingCompacted
		? `## PREVIOUSLY COMPACTED OBSERVATIONS\n\n${existingCompacted}\n\n## ACTIVE OBSERVATIONS TO COMPRESS\n\n${observations}`
		: observations;
}

export async function collectObservationSamplesFromSessionFile(
	sessionPath: string,
	options?: { sampleCount?: number; minInputTokens?: number },
): Promise<OmComparisonSample[]> {
	const resolvedPath = path.resolve(sessionPath);
	const sampleCount = asNumber(options?.sampleCount, 6, 1, 50);
	const minInputTokens = asNumber(options?.minInputTokens, 20000, 1000, 400000);

	const candidates: OmComparisonSample[] = [];
	const stream = fs.createReadStream(resolvedPath, { encoding: "utf-8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let lineNumber = 0;

	for await (const line of rl) {
		lineNumber += 1;
		if (!line || !line.includes('"customType":"om:state"')) {
			continue;
		}
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "custom" || entry?.customType !== "om:state") {
			continue;
		}
		const data = entry?.data || {};
		const state = data?.state || {};
		const activeObservations = getSerializedObservationText(state);
		if (!activeObservations) continue;

		const existingCompacted = getSerializedReflectionText(state);
		const activeTokens = Math.max(0, asNumber(state?.totalObservationTokens, estimateStringTokens(activeObservations), 0));
		const compactedTokens = Math.max(0, asNumber(state?.totalReflectionTokens ?? state?.totalCompactedTokens, estimateStringTokens(existingCompacted), 0));
		const inputTokens = estimateStringTokens(buildCombinedInput(activeObservations, existingCompacted));

		candidates.push({
			sampleId: "",
			sessionPath: resolvedPath,
			entryId: String(entry?.id || `line-${lineNumber}`),
			timestamp: String(entry?.timestamp || data?.timestamp || ""),
			lineNumber,
			eventType: String(data?.eventType || "observation"),
			generationCount: asNumber(state?.generationCount, 0, 0, 100000),
			activeObservations,
			existingCompacted,
			activeObservationTokens: activeTokens,
			compactedObservationTokens: compactedTokens,
			inputTokens,
		});
	}

	const bySize = [...candidates]
		.sort((a, b) => {
			if (b.activeObservationTokens !== a.activeObservationTokens) {
				return b.activeObservationTokens - a.activeObservationTokens;
			}
			return b.lineNumber - a.lineNumber;
		});

	let selected = bySize.filter((candidate) => candidate.activeObservationTokens >= minInputTokens);
	if (selected.length === 0) {
		selected = bySize;
	}
	selected = selected.slice(0, sampleCount);

	return selected.map((sample, index) => ({
		...sample,
		sampleId: `S${String(index + 1).padStart(2, "0")}`,
	}));
}

const STOP_WORDS = new Set([
	"the",
	"and",
	"that",
	"this",
	"with",
	"from",
	"have",
	"been",
	"were",
	"will",
	"would",
	"could",
	"should",
	"into",
	"about",
	"after",
	"before",
	"there",
	"their",
	"they",
	"them",
	"then",
	"than",
	"just",
	"very",
	"also",
	"only",
	"through",
	"user",
	"agent",
	"date",
	"time",
	"message",
	"messages",
	"observations",
	"observation",
]);

function toKeywordSet(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9_\-]+/g, " ")
		.split(/\s+/)
		.map((word) => word.trim())
		.filter(Boolean);
	const out = new Set<string>();
	for (const word of words) {
		if (word.length < 4) continue;
		if (/^\d+$/.test(word)) continue;
		if (STOP_WORDS.has(word)) continue;
		out.add(word);
	}
	return out;
}

function setRecall(reference: Set<string>, candidate: Set<string>): number {
	if (reference.size === 0) return 1;
	if (candidate.size === 0) return 0;
	let shared = 0;
	for (const token of reference) {
		if (candidate.has(token)) shared += 1;
	}
	return shared / reference.size;
}

function extractDateHeaders(text: string): Set<string> {
	const matches = text.match(/^Date:\s+.+$/gm) || [];
	return new Set(matches.map((line) => line.trim().toLowerCase()));
}

function countBullets(text: string): number {
	const matches = text.match(/^\*\s+/gm);
	return matches ? matches.length : 0;
}

function extractCompletionLines(text: string): Set<string> {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("✅"));
	return new Set(lines.map((line) => line.toLowerCase()));
}

const URL_REGEX = /https?:\/\/[^\s)]+/g;
const PATH_REGEX = /(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)[\w\-/\\.]+|[\w\-.]+[\/\\][\w\-/\\.]+/g;
const CODE_SPAN_REGEX = /`([^`\n]{1,240})`/g;

function extractAnchors(text: string): Set<string> {
	const anchors = new Set<string>();
	for (const match of text.match(URL_REGEX) || []) {
		anchors.add(match.trim().toLowerCase());
	}
	for (const match of text.match(PATH_REGEX) || []) {
		anchors.add(match.trim().toLowerCase());
	}
	for (const match of text.matchAll(CODE_SPAN_REGEX)) {
		const token = String(match[1] || "").trim();
		if (token) anchors.add(token.toLowerCase());
	}
	return anchors;
}

function hasTaskSection(text: string): boolean {
	return /<current-task>|^Primary:\s+/gim.test(text);
}

function evaluateCompressionOutput(params: {
	algorithm: CompressionAlgorithm;
	referenceInput: string;
	activeObservations: string;
	existingCompacted: string;
	outputText: string;
	error?: string;
}): CompressionArmResult {
	if (params.error) {
		return {
			algorithm: params.algorithm,
			success: false,
			error: params.error,
			outputText: "",
			outputTokens: 0,
			tokenReductionPercent: 0,
			signalRetentionPercent: 0,
			lossinessPercentEstimate: 100,
			deadOutputTokensEstimate: 0,
			deadOutputPercentEstimate: 100,
			meaningfulContextGainTokensEstimate: 0,
			meaningfulContextGainPercentEstimate: 0,
			formatRetention: {
				dateRecall: 0,
				bulletCoverage: 0,
				completionRecall: 0,
				taskRetention: 0,
				anchorRecall: 0,
				keywordRecall: 0,
			},
			qualityScore: 0,
			hardFailure: true,
			hardFailureReason: params.error,
		};
	}

	const inputTokens = Math.max(1, estimateStringTokens(params.referenceInput));
	const output = String(params.outputText || "").trim();
	const outputTokens = estimateStringTokens(output);
	const tokenReductionPercent = Math.max(0, (1 - outputTokens / inputTokens) * 100);

	const dateRecall = setRecall(extractDateHeaders(params.referenceInput), extractDateHeaders(output));
	const inputBullets = countBullets(params.referenceInput);
	const outputBullets = countBullets(output);
	const bulletCoverage = inputBullets > 0 ? Math.min(1, outputBullets / inputBullets) : 1;
	const completionRecall = setRecall(extractCompletionLines(params.referenceInput), extractCompletionLines(output));
	const taskRetention = hasTaskSection(params.referenceInput)
		? (hasTaskSection(output) ? 1 : 0)
		: 1;
	const anchorRecall = setRecall(extractAnchors(params.referenceInput), extractAnchors(output));
	const keywordRecall = setRecall(toKeywordSet(params.referenceInput), toKeywordSet(output));

	const weightedRetention =
		keywordRecall * 0.35 +
		anchorRecall * 0.25 +
		dateRecall * 0.1 +
		completionRecall * 0.1 +
		bulletCoverage * 0.1 +
		taskRetention * 0.1;
	const signalRetentionPercent = Math.max(0, Math.min(100, weightedRetention * 100));
	const lossinessPercentEstimate = 100 - signalRetentionPercent;
	const deadOutputTokensEstimate = outputTokens * (1 - weightedRetention);
	const deadOutputPercentEstimate = outputTokens > 0 ? (deadOutputTokensEstimate / outputTokens) * 100 : 0;
	const meaningfulContextGainTokensEstimate = Math.max(0, (inputTokens - outputTokens) * weightedRetention);
	const meaningfulContextGainPercentEstimate = Math.max(0, (meaningfulContextGainTokensEstimate / inputTokens) * 100);

	const validation = validateReflectedObservations({
		inputObservations: params.activeObservations,
		existingCompacted: params.existingCompacted,
		compactedObservations: output,
	});
	const hardFailure = !validation.ok;
	const hardFailureReason = hardFailure ? validation.reason : undefined;
	const safetyScore = hardFailure ? 0 : 1;
	const qualityScore =
		(weightedRetention * 0.5) +
		((tokenReductionPercent / 100) * 0.35) +
		(safetyScore * 0.15);

	return {
		algorithm: params.algorithm,
		success: true,
		outputText: output,
		outputTokens,
		tokenReductionPercent,
		signalRetentionPercent,
		lossinessPercentEstimate,
		deadOutputTokensEstimate,
		deadOutputPercentEstimate,
		meaningfulContextGainTokensEstimate,
		meaningfulContextGainPercentEstimate,
		formatRetention: {
			dateRecall,
			bulletCoverage,
			completionRecall,
			taskRetention,
			anchorRecall,
			keywordRecall,
		},
		qualityScore,
		hardFailure,
		hardFailureReason,
	};
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
	return sorted[rank];
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[middle - 1] + sorted[middle]) / 2;
	}
	return sorted[middle];
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateArmResults(
	algorithm: CompressionAlgorithm,
	rows: CompressionArmResult[],
): CompressionArmAggregate {
	const sampleCount = rows.length;
	const successRows = rows.filter((row) => row.success);
	const hardFailureCount = rows.filter((row) => row.hardFailure).length;
	const hardFailureRatePercent = sampleCount > 0 ? (hardFailureCount / sampleCount) * 100 : 0;

	const tokenReduction = successRows.map((row) => row.tokenReductionPercent);
	const retainedSignal = successRows.map((row) => row.signalRetentionPercent);
	const lossiness = successRows.map((row) => row.lossinessPercentEstimate);
	const meaningfulGainPercent = successRows.map((row) => row.meaningfulContextGainPercentEstimate);
	const meaningfulGainTokens = successRows.map((row) => row.meaningfulContextGainTokensEstimate);
	const deadOutputPercent = successRows.map((row) => row.deadOutputPercentEstimate);

	const normalizedReduction = median(tokenReduction) / 100;
	const normalizedSignal = median(retainedSignal) / 100;
	const normalizedSafety = 1 - hardFailureRatePercent / 100;
	const overallScore =
		normalizedReduction * 0.4 +
		normalizedSignal * 0.45 +
		normalizedSafety * 0.15;

	return {
		algorithm,
		sampleCount,
		successCount: successRows.length,
		hardFailureCount,
		hardFailureRatePercent,
		medianTokenReductionPercent: median(tokenReduction),
		medianSignalRetentionPercent: median(retainedSignal),
		medianLossinessPercentEstimate: median(lossiness),
		p90LossinessPercentEstimate: percentile(lossiness, 90),
		medianMeaningfulContextGainPercentEstimate: median(meaningfulGainPercent),
		meanMeaningfulContextGainTokensEstimate: mean(meaningfulGainTokens),
		meanDeadOutputPercentEstimate: mean(deadOutputPercent),
		overallScore,
	};
}

function buildDecisionMatrix(aggregate: {
	reflector: CompressionArmAggregate;
	caveman: CompressionArmAggregate;
	reobserve: CompressionArmAggregate;
}): CompressionDecisionMatrix {
	const reflector = aggregate.reflector;
	const caveman = aggregate.caveman;
	const reobserve = aggregate.reobserve;

	const criteria: DecisionMatrixCriterion[] = [
		{
			criterion: "Hard safety failure rate",
			threshold: "<= 5%",
			reflector: {
				value: formatPercent(reflector.hardFailureRatePercent),
				pass: reflector.hardFailureRatePercent <= 5,
			},
			caveman: {
				value: formatPercent(caveman.hardFailureRatePercent),
				pass: caveman.hardFailureRatePercent <= 5,
			},
			reobserve: {
				value: formatPercent(reobserve.hardFailureRatePercent),
				pass: reobserve.hardFailureRatePercent <= 5,
			},
		},
		{
			criterion: "Median signal retention",
			threshold: ">= 55%",
			reflector: {
				value: formatPercent(reflector.medianSignalRetentionPercent),
				pass: reflector.medianSignalRetentionPercent >= 55,
			},
			caveman: {
				value: formatPercent(caveman.medianSignalRetentionPercent),
				pass: caveman.medianSignalRetentionPercent >= 55,
			},
			reobserve: {
				value: formatPercent(reobserve.medianSignalRetentionPercent),
				pass: reobserve.medianSignalRetentionPercent >= 55,
			},
		},
		{
			criterion: "P90 lossiness estimate",
			threshold: "<= 45%",
			reflector: {
				value: formatPercent(reflector.p90LossinessPercentEstimate),
				pass: reflector.p90LossinessPercentEstimate <= 45,
			},
			caveman: {
				value: formatPercent(caveman.p90LossinessPercentEstimate),
				pass: caveman.p90LossinessPercentEstimate <= 45,
			},
			reobserve: {
				value: formatPercent(reobserve.p90LossinessPercentEstimate),
				pass: reobserve.p90LossinessPercentEstimate <= 45,
			},
		},
		{
			criterion: "Median token reduction",
			threshold: ">= 30%",
			reflector: {
				value: formatPercent(reflector.medianTokenReductionPercent),
				pass: reflector.medianTokenReductionPercent >= 30,
			},
			caveman: {
				value: formatPercent(caveman.medianTokenReductionPercent),
				pass: caveman.medianTokenReductionPercent >= 30,
			},
			reobserve: {
				value: formatPercent(reobserve.medianTokenReductionPercent),
				pass: reobserve.medianTokenReductionPercent >= 30,
			},
		},
		{
			criterion: "Median meaningful context gain",
			threshold: ">= 20% of input tokens",
			reflector: {
				value: formatPercent(reflector.medianMeaningfulContextGainPercentEstimate),
				pass: reflector.medianMeaningfulContextGainPercentEstimate >= 20,
			},
			caveman: {
				value: formatPercent(caveman.medianMeaningfulContextGainPercentEstimate),
				pass: caveman.medianMeaningfulContextGainPercentEstimate >= 20,
			},
			reobserve: {
				value: formatPercent(reobserve.medianMeaningfulContextGainPercentEstimate),
				pass: reobserve.medianMeaningfulContextGainPercentEstimate >= 20,
			},
		},
	];

	const candidates: Array<{
		algorithm: Exclude<CompressionAlgorithm, "reflector">;
		aggregate: CompressionArmAggregate;
		recommendation: CompressionDecisionMatrix["recommendation"];
	}> = [
		{ algorithm: "caveman", aggregate: caveman, recommendation: "candidate_caveman" },
		{ algorithm: "reobserve", aggregate: reobserve, recommendation: "candidate_reobserve" },
	];

	const viable = candidates
		.filter((candidate) => {
			const passAll = criteria.every((criterion) => criterion[candidate.algorithm].pass);
			if (!passAll) return false;
			if (candidate.aggregate.hardFailureRatePercent > reflector.hardFailureRatePercent) return false;
			const scoreDelta = candidate.aggregate.overallScore - reflector.overallScore;
			if (scoreDelta < 0.03) return false;
			const lossinessDelta = candidate.aggregate.medianLossinessPercentEstimate - reflector.medianLossinessPercentEstimate;
			if (lossinessDelta > 5) return false;
			return true;
		})
		.sort((a, b) => b.aggregate.overallScore - a.aggregate.overallScore);

	if (viable.length > 0) {
		const winner = viable[0];
		const reason =
			winner.algorithm === "caveman"
				? "Caveman passes all gates, beats reflector utility score, and keeps lossiness within acceptable delta."
				: "Re-observe passes all gates, beats reflector utility score, and keeps lossiness within acceptable delta.";
		return {
			criteria,
			recommendation: winner.recommendation,
			reason,
		};
	}

	const anyCandidateClose = candidates.some((candidate) => {
		const scoreDelta = candidate.aggregate.overallScore - reflector.overallScore;
		return scoreDelta > -0.02;
	});

	if (anyCandidateClose) {
		return {
			criteria,
			recommendation: "collect_more_samples",
			reason:
				"Candidate strategies are close to reflector but did not clear all gates; collect more real-session samples before switching.",
		};
	}

	return {
		criteria,
		recommendation: "keep_reflector",
		reason:
			"Candidate strategies failed quality/safety gates or underperformed reflector on aggregate utility.",
	};
}

function summarizeWinner(
	reflector: CompressionArmResult,
	caveman: CompressionArmResult,
	reobserve: CompressionArmResult,
): CompressionAlgorithm | "tie" {
	const arms = [reflector, caveman, reobserve].filter((arm) => arm.success && !arm.hardFailure);
	if (arms.length === 0) {
		const successful = [reflector, caveman, reobserve].filter((arm) => arm.success);
		if (successful.length === 0) return "tie";
		successful.sort((a, b) => b.qualityScore - a.qualityScore);
		if (successful.length === 1) return successful[0].algorithm;
		return successful[0].qualityScore - successful[1].qualityScore >= 0.03
			? successful[0].algorithm
			: "tie";
	}

	arms.sort((a, b) => b.qualityScore - a.qualityScore);
	if (arms.length === 1) return arms[0].algorithm;
	return arms[0].qualityScore - arms[1].qualityScore >= 0.03
		? arms[0].algorithm
		: "tie";
}

export async function runCompressionComparisonOnSession(params: {
	sessionPath: string;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	getObserverAuth?: () => Promise<RequestAuth>;
	sampleCount?: number;
	minInputTokens?: number;
	timeoutMs?: number;
	promptTokenLimit?: number;
	onProgress?: (message: string) => void;
}): Promise<CompressionComparisonReport> {
	const samples = await collectObservationSamplesFromSessionFile(params.sessionPath, {
		sampleCount: params.sampleCount,
		minInputTokens: params.minInputTokens,
	});
	if (samples.length === 0) {
		throw new Error(`No OM observation samples found in session file: ${params.sessionPath}`);
	}

	const compareTimeoutMs = Math.max(params.timeoutMs ?? Math.max(params.config.reflectorTimeoutMs, 120000), 10000);
	const comparePromptTokenLimit = Math.max(params.promptTokenLimit ?? params.config.reflectorPromptTokenLimit, 8000);

	const { runReflector } = await import("./reflector");
	const { runCavemanReflector } = await import("./caveman-reflector");
	const { runObserver } = await import("./observer");
	const observerAuthGetter = params.getObserverAuth ?? params.getAuth;

	const rows: CompressionSampleComparisonResult[] = [];

	for (const sample of samples) {
		params.onProgress?.(`Comparing sample ${sample.sampleId} (~${sample.inputTokens} tokens)`);
		const referenceInput = buildCombinedInput(sample.activeObservations, sample.existingCompacted);

		let reflectorOutput = "";
		let reflectorError: string | undefined;
		try {
			const result = await runReflector({
				observations: sample.activeObservations,
				existingCompacted: sample.existingCompacted,
				compressionLevel: 0,
				generationCount: sample.generationCount,
				config: params.config,
				getAuth: params.getAuth,
				promptTokenLimit: comparePromptTokenLimit,
				timeoutMs: compareTimeoutMs,
			});
			reflectorOutput = result.compactedObservations;
		} catch (error) {
			reflectorError = error instanceof Error ? error.message : String(error);
		}

		let cavemanOutput = "";
		let cavemanError: string | undefined;
		try {
			const result = await runCavemanReflector({
				observations: sample.activeObservations,
				existingCompacted: sample.existingCompacted,
				compressionLevel: 0,
				generationCount: sample.generationCount,
				config: params.config,
				getAuth: params.getAuth,
				promptTokenLimit: comparePromptTokenLimit,
				timeoutMs: compareTimeoutMs,
			});
			cavemanOutput = result.compactedObservations;
		} catch (error) {
			cavemanError = error instanceof Error ? error.message : String(error);
		}

		let reobserveOutput = "";
		let reobserveError: string | undefined;
		try {
			const result = await runObserver({
				unobservedMessages: [
					{
						role: "user",
						content: [{ type: "text", text: referenceInput }],
						timestamp: Date.now(),
					} as any,
				],
				previousObservations: "",
				config: params.config,
				getAuth: observerAuthGetter,
				timezone: "UTC",
				timeoutMs: compareTimeoutMs,
				promptTokenLimit: comparePromptTokenLimit,
			});
			const currentTask = String(result.currentTask || "").trim();
			reobserveOutput = [
				String(result.observations || "").trim(),
				currentTask ? `<current-task>\n${currentTask}\n</current-task>` : "",
			]
				.filter(Boolean)
				.join("\n\n")
				.trim();
		} catch (error) {
			reobserveError = error instanceof Error ? error.message : String(error);
		}

		const reflector = evaluateCompressionOutput({
			algorithm: "reflector",
			referenceInput,
			activeObservations: sample.activeObservations,
			existingCompacted: sample.existingCompacted,
			outputText: reflectorOutput,
			error: reflectorError,
		});
		const caveman = evaluateCompressionOutput({
			algorithm: "caveman",
			referenceInput,
			activeObservations: sample.activeObservations,
			existingCompacted: sample.existingCompacted,
			outputText: cavemanOutput,
			error: cavemanError,
		});
		const reobserve = evaluateCompressionOutput({
			algorithm: "reobserve",
			referenceInput,
			activeObservations: sample.activeObservations,
			existingCompacted: sample.existingCompacted,
			outputText: reobserveOutput,
			error: reobserveError,
		});

		rows.push({
			sample: sanitizeSampleForReport(sample),
			reflector: sanitizeArmResultForReport(reflector),
			caveman: sanitizeArmResultForReport(caveman),
			reobserve: sanitizeArmResultForReport(reobserve),
			recommendedWinner: summarizeWinner(reflector, caveman, reobserve),
		});
	}

	const aggregate = {
		reflector: aggregateArmResults("reflector", rows.map((row) => row.reflector)),
		caveman: aggregateArmResults("caveman", rows.map((row) => row.caveman)),
		reobserve: aggregateArmResults("reobserve", rows.map((row) => row.reobserve)),
	};

	const decisionMatrix = buildDecisionMatrix(aggregate);

	return {
		createdAt: new Date().toISOString(),
		projectCwd: process.cwd(),
		sessionPath: path.resolve(params.sessionPath),
		configSnapshot: {
			reflectorModel: { ...params.config.reflectorModel },
			reflectorPromptTokenLimit: params.config.reflectorPromptTokenLimit,
			reflectorTimeoutMs: params.config.reflectorTimeoutMs,
			reflectionTriggerContextPercent: params.config.reflectionTriggerContextPercent,
			reflectionTargetContextPercent: params.config.reflectionTargetContextPercent,
		},
		compareOptions: {
			sampleCount: samples.length,
			minInputTokens: asNumber(params.minInputTokens, 20000, 1000),
			timeoutMs: compareTimeoutMs,
			promptTokenLimit: comparePromptTokenLimit,
		},
		samples: rows,
		aggregate,
		decisionMatrix,
	};
}

function markdownForAggregate(aggregate: CompressionArmAggregate): string {
	return [
		`| ${aggregate.algorithm} | ${aggregate.sampleCount} | ${aggregate.successCount} | ${formatPercent(aggregate.hardFailureRatePercent)} | ${formatPercent(aggregate.medianTokenReductionPercent)} | ${formatPercent(aggregate.medianSignalRetentionPercent)} | ${formatPercent(aggregate.medianLossinessPercentEstimate)} | ${formatPercent(aggregate.medianMeaningfulContextGainPercentEstimate)} | ${formatNumber(aggregate.meanMeaningfulContextGainTokensEstimate, 0)} | ${formatPercent(aggregate.meanDeadOutputPercentEstimate)} | ${formatNumber(aggregate.overallScore * 100)} |`,
	].join("\n");
}

export function formatComparisonReportMarkdown(report: CompressionComparisonReport): string {
	const lines: string[] = [];
	lines.push("# OM Compression Comparison Report");
	lines.push("");
	lines.push(`Generated: ${report.createdAt}`);
	lines.push(`Session: ${report.sessionPath}`);
	lines.push(`Model: ${report.configSnapshot.reflectorModel.provider}/${report.configSnapshot.reflectorModel.modelId}`);
	lines.push(`Compare timeout: ${report.compareOptions.timeoutMs}ms`);
	lines.push(`Prompt token limit: ${report.compareOptions.promptTokenLimit}`);
	lines.push("");
	lines.push("## Aggregate score matrix");
	lines.push("");
	lines.push("| Algorithm | Samples | Success | Hard fail rate | Median reduction | Median signal retention | Median lossiness est. | Median meaningful context gain | Mean meaningful gain tokens | Mean dead output % | Overall score | ");
	lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
	lines.push(markdownForAggregate(report.aggregate.reflector));
	lines.push(markdownForAggregate(report.aggregate.caveman));
	lines.push(markdownForAggregate(report.aggregate.reobserve));
	lines.push("");

	lines.push("## Phase-3 decision criteria");
	lines.push("");
	lines.push("| Criterion | Threshold | Reflector | Caveman | Re-observe |");
	lines.push("|---|---|---|---|---|");
	for (const criterion of report.decisionMatrix.criteria) {
		const reflectorStatus = `${criterion.reflector.value} ${criterion.reflector.pass ? "✅" : "❌"}`;
		const cavemanStatus = `${criterion.caveman.value} ${criterion.caveman.pass ? "✅" : "❌"}`;
		const reobserveStatus = `${criterion.reobserve.value} ${criterion.reobserve.pass ? "✅" : "❌"}`;
		lines.push(`| ${criterion.criterion} | ${criterion.threshold} | ${reflectorStatus} | ${cavemanStatus} | ${reobserveStatus} |`);
	}
	lines.push("");
	lines.push(`Recommendation: **${report.decisionMatrix.recommendation}**`);
	lines.push(`Reason: ${report.decisionMatrix.reason}`);
	lines.push("");

	lines.push("## Sample-by-sample scoring rubric");
	lines.push("");
	lines.push("| Sample | Input tok | Reflector reduction | Caveman reduction | Re-observe reduction | Reflector lossiness | Caveman lossiness | Re-observe lossiness | Reflector meaningful gain | Caveman meaningful gain | Re-observe meaningful gain | Winner |");
	lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
	for (const row of report.samples) {
		lines.push(
			`| ${row.sample.sampleId} | ${row.sample.inputTokens} | ${formatPercent(row.reflector.tokenReductionPercent)} | ${formatPercent(row.caveman.tokenReductionPercent)} | ${formatPercent(row.reobserve.tokenReductionPercent)} | ${formatPercent(row.reflector.lossinessPercentEstimate)} | ${formatPercent(row.caveman.lossinessPercentEstimate)} | ${formatPercent(row.reobserve.lossinessPercentEstimate)} | ${formatPercent(row.reflector.meaningfulContextGainPercentEstimate)} | ${formatPercent(row.caveman.meaningfulContextGainPercentEstimate)} | ${formatPercent(row.reobserve.meaningfulContextGainPercentEstimate)} | ${row.recommendedWinner} |`,
		);
	}
	lines.push("");

	lines.push("## Lossiness estimation notes");
	lines.push("");
	lines.push("- `signal retention` is a weighted estimate from keyword recall, technical-anchor recall (paths/code/URLs), date retention, completion-marker retention, task retention, and bullet coverage.");
	lines.push("- `lossiness estimate` = `100 - signal retention`.");
	lines.push("- `dead output %` estimates the share of compressed tokens that likely do not carry recoverable source signal.");
	lines.push("- `meaningful context gain` estimates tokens freed while retaining source signal.");

	return lines.join("\n");
}

export function writeComparisonReport(
	report: CompressionComparisonReport,
	options?: { cwd?: string; reportPath?: string },
): { jsonPath: string; markdownPath: string } {
	const cwd = options?.cwd || process.cwd();
	const reportsDir = path.join(getProjectOmDir(cwd), "reports");
	if (!fs.existsSync(reportsDir)) {
		fs.mkdirSync(reportsDir, { recursive: true });
	}

	const timestamp = report.createdAt
		.replace(/[:]/g, "-")
		.replace(/\..+$/, "")
		.replace(/[^a-zA-Z0-9T-]/g, "-");
	const defaultJsonPath = path.join(reportsDir, `compression-compare-${timestamp}.json`);
	const jsonPath = options?.reportPath ? path.resolve(options.reportPath) : defaultJsonPath;
	const markdownPath = jsonPath.replace(/\.json$/i, ".md");

	const jsonDir = path.dirname(jsonPath);
	if (!fs.existsSync(jsonDir)) {
		fs.mkdirSync(jsonDir, { recursive: true });
	}

	fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
	fs.writeFileSync(markdownPath, formatComparisonReportMarkdown(report), "utf-8");
	return { jsonPath, markdownPath };
}
