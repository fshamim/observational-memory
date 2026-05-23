import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ObservationalMemoryConfig } from "./types";
import type { RequestAuth } from "./auth";
import { estimateStringTokens } from "./token-estimator";
import { runObserver } from "./observer";

function canonicalizeObservationText(text: string): string {
	return String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

export async function runReobserver(params: {
	observations: string;
	existingCompacted: string;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	signal?: AbortSignal;
	timeoutMs?: number;
	promptTokenLimit?: number;
}): Promise<{
	compactedObservations: string;
	compressed: boolean;
	degenerate: boolean;
	chunkCount: number;
}> {
	const combinedInput = params.existingCompacted
		? `## PREVIOUSLY COMPACTED OBSERVATIONS\n\n${params.existingCompacted}\n\n## ACTIVE OBSERVATIONS TO COMPRESS\n\n${params.observations}`
		: params.observations;
	const normalizedInput = canonicalizeObservationText(combinedInput);
	if (!normalizedInput) {
		return {
			compactedObservations: "",
			compressed: false,
			degenerate: true,
			chunkCount: 0,
		};
	}

	const syntheticMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: normalizedInput }],
		timestamp: Date.now(),
	} as AgentMessage;

	const observerResult = await runObserver({
		unobservedMessages: [syntheticMessage],
		previousObservations: "",
		config: params.config,
		getAuth: params.getAuth,
		timezone: "UTC",
		signal: params.signal,
		timeoutMs: params.timeoutMs,
		promptTokenLimit: params.promptTokenLimit,
	});

	const compactedObservations = canonicalizeObservationText(observerResult.observations);
	const inputTokens = estimateStringTokens(normalizedInput);
	const outputTokens = estimateStringTokens(compactedObservations);

	return {
		compactedObservations,
		compressed: outputTokens < inputTokens,
		degenerate: !compactedObservations,
		chunkCount: observerResult.chunkCount,
	};
}
