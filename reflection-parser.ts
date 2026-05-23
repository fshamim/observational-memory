import { estimateStringTokens } from "./token-estimator";
import { computeKeywordOverlap } from "./reflection-guard";

export interface ReflectionParseResult {
	observations: string;
	candidateCount: number;
	selectedIndex: number;
	selectedTokens: number;
	selectedOverlap: number;
}

function extractTagBlocks(text: string, tagName: string): string[] {
	const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "gi");
	const out: string[] = [];
	for (const match of text.matchAll(regex)) {
		const block = (match[1] || "").trim();
		if (block) out.push(block);
	}
	return out;
}

export function extractReflectedObservations(output: string, inputObservations: string): ReflectionParseResult {
	const normalizedOutput = output.trim();
	const candidates = extractTagBlocks(normalizedOutput, "observations");
	if (candidates.length === 0) {
		return {
			observations: normalizedOutput,
			candidateCount: 0,
			selectedIndex: -1,
			selectedTokens: estimateStringTokens(normalizedOutput),
			selectedOverlap: computeKeywordOverlap(inputObservations, normalizedOutput),
		};
	}

	let bestIndex = candidates.length - 1;
	let bestScore = -Infinity;
	let bestOverlap = 0;
	let bestTokens = 0;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const overlap = computeKeywordOverlap(inputObservations, candidate);
		const candidateTokens = estimateStringTokens(candidate);
		const recencyBonus = candidates.length > 1 ? (index / (candidates.length - 1)) * 0.03 : 0;
		const tokenBonus = Math.min(0.05, candidateTokens / 20000);
		const score = overlap + recencyBonus + tokenBonus;
		if (
			score > bestScore + 1e-9 ||
			(Math.abs(score - bestScore) <= 1e-9 && index > bestIndex)
		) {
			bestScore = score;
			bestIndex = index;
			bestOverlap = overlap;
			bestTokens = candidateTokens;
		}
	}

	const selected = candidates[bestIndex] || candidates[candidates.length - 1] || normalizedOutput;
	return {
		observations: selected,
		candidateCount: candidates.length,
		selectedIndex: bestIndex,
		selectedTokens: bestTokens || estimateStringTokens(selected),
		selectedOverlap: bestOverlap,
	};
}
