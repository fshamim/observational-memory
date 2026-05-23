import { estimateStringTokens } from "./token-estimator";

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
	"into",
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

function normalizeKeywords(text: string): Set<string> {
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

export function computeKeywordOverlap(referenceText: string, candidateText: string): number {
	const reference = normalizeKeywords(referenceText);
	const candidate = normalizeKeywords(candidateText);
	if (reference.size === 0 || candidate.size === 0) {
		return 0;
	}
	let shared = 0;
	for (const token of candidate) {
		if (reference.has(token)) {
			shared += 1;
		}
	}
	return shared / candidate.size;
}

export interface ReflectionValidationResult {
	ok: boolean;
	reason: string;
	inputTokens: number;
	outputTokens: number;
	compressionRatio: number;
	keywordOverlap: number;
}

export function validateReflectedObservations(params: {
	inputObservations: string;
	existingCompacted: string;
	compactedObservations: string;
}): ReflectionValidationResult {
	const combinedInput = params.existingCompacted
		? `## PREVIOUSLY COMPACTED OBSERVATIONS\n\n${params.existingCompacted}\n\n## ACTIVE OBSERVATIONS TO COMPRESS\n\n${params.inputObservations}`
		: params.inputObservations;
	const output = params.compactedObservations.trim();
	const inputTokens = estimateStringTokens(combinedInput);
	const outputTokens = estimateStringTokens(output);
	const compressionRatio = outputTokens / Math.max(1, inputTokens);
	const keywordOverlap = computeKeywordOverlap(combinedInput, output);

	if (!output) {
		return {
			ok: false,
			reason: "empty-output",
			inputTokens,
			outputTokens,
			compressionRatio,
			keywordOverlap,
		};
	}

	const lowerOutput = output.toLowerCase();
	const hasTemplateArtifact = [
		"working on feature x",
		"continued work on feature x",
		"date: mon dd, yyyy",
		"(hh:mm) high-priority fact, decision, or user preference",
		"(hh:mm) medium-priority project context or result",
		"(hh:mm) completed outcome with concrete resolution",
	].some((marker) => lowerOutput.includes(marker));
	if (hasTemplateArtifact) {
		return {
			ok: false,
			reason: "template-artifact-detected",
			inputTokens,
			outputTokens,
			compressionRatio,
			keywordOverlap,
		};
	}

	if (inputTokens >= 50000 && outputTokens < 220) {
		return {
			ok: false,
			reason: "output-too-small-for-large-input",
			inputTokens,
			outputTokens,
			compressionRatio,
			keywordOverlap,
		};
	}

	if (inputTokens >= 20000 && outputTokens < 120) {
		return {
			ok: false,
			reason: "output-too-small",
			inputTokens,
			outputTokens,
			compressionRatio,
			keywordOverlap,
		};
	}

	const minimumRatio = inputTokens >= 50000 ? 0.0018 : inputTokens >= 20000 ? 0.0022 : inputTokens >= 10000 ? 0.0028 : 0;
	if (minimumRatio > 0 && compressionRatio < minimumRatio) {
		return {
			ok: false,
			reason: "compression-ratio-too-low",
			inputTokens,
			outputTokens,
			compressionRatio,
			keywordOverlap,
		};
	}

	const minimumOverlap = inputTokens >= 50000 ? 0.08 : inputTokens >= 20000 ? 0.06 : inputTokens >= 10000 ? 0.04 : 0;
	if (minimumOverlap > 0 && keywordOverlap < minimumOverlap) {
		return {
			ok: false,
			reason: "keyword-overlap-too-low",
			inputTokens,
			outputTokens,
			compressionRatio,
			keywordOverlap,
		};
	}

	return {
		ok: true,
		reason: "ok",
		inputTokens,
		outputTokens,
		compressionRatio,
		keywordOverlap,
	};
}
