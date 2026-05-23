import { getModel, completeSimple } from "@mariozechner/pi-ai";
import type { ObservationalMemoryConfig } from "./types";
import type { RequestAuth } from "./auth";
import { estimateStringTokens } from "./token-estimator";
import { chunkTextByTokenBudget } from "./chunking";
import { createTimeoutSignal, parsePromptTooLongLimit } from "./async-utils";
import { extractReflectedObservations } from "./reflection-parser";
import { buildCavemanReflectorPrompt, buildCavemanReflectorSystemPrompt } from "./caveman-prompts";

export async function runCavemanReflector(params: {
	observations: string;
	existingCompacted: string;
	compressionLevel: 0 | 1 | 2 | 3;
	generationCount: number;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	signal?: AbortSignal;
	promptTokenLimit?: number;
	timeoutMs?: number;
}): Promise<{
	compactedObservations: string;
	compressed: boolean;
	degenerate: boolean;
	chunkCount: number;
}> {
	const { observations, existingCompacted, compressionLevel, config, getAuth, signal } = params;
	let promptTokenLimit = params.promptTokenLimit ?? config.reflectorPromptTokenLimit;
	let lastError: unknown;

	for (let budgetAttempt = 1; budgetAttempt <= 3; budgetAttempt++) {
		try {
			return await runCavemanReflectorWithBudget({
				observations,
				existingCompacted,
				compressionLevel,
				config,
				getAuth,
				signal,
				promptTokenLimit,
				timeoutMs: params.timeoutMs ?? config.reflectorTimeoutMs,
			});
		} catch (error) {
			lastError = error;
			const limit = parsePromptTooLongLimit(error);
			if (!limit || budgetAttempt >= 3) {
				throw error;
			}
			const nextLimit = Math.min(promptTokenLimit - 8000, Math.floor(limit.maxTokens * 0.7));
			if (nextLimit < 8000 || nextLimit >= promptTokenLimit) {
				throw error;
			}
			promptTokenLimit = nextLimit;
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError || "Caveman reflector failed"));
}

async function runCavemanReflectorWithBudget(params: {
	observations: string;
	existingCompacted: string;
	compressionLevel: 0 | 1 | 2 | 3;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	signal?: AbortSignal;
	promptTokenLimit: number;
	timeoutMs: number;
}): Promise<{
	compactedObservations: string;
	compressed: boolean;
	degenerate: boolean;
	chunkCount: number;
}> {
	const { observations, existingCompacted, compressionLevel, config, getAuth, signal, promptTokenLimit, timeoutMs } = params;
	const combinedInput = existingCompacted
		? `## PREVIOUSLY COMPACTED OBSERVATIONS\n\n${existingCompacted}\n\n## ACTIVE OBSERVATIONS TO COMPRESS\n\n${observations}`
		: observations;
	const inputTokens = estimateStringTokens(combinedInput);

	const systemPrompt = buildCavemanReflectorSystemPrompt();
	const systemTokens = estimateStringTokens(systemPrompt);
	const availablePromptTokens = Math.max(4000, promptTokenLimit - systemTokens - 8192 - 4096);

	const model = getModel(
		config.reflectorModel.provider as any,
		config.reflectorModel.modelId as any,
	);
	const auth = await getAuth();

	if (inputTokens <= availablePromptTokens) {
		const pass = await runCavemanPass({
			model,
			auth,
			inputObservations: combinedInput,
			compressionLevel,
			timeoutMs,
			signal,
		});
		return {
			compactedObservations: pass.compactedObservations,
			compressed: estimateStringTokens(pass.compactedObservations) < inputTokens,
			degenerate: pass.degenerate,
			chunkCount: 1,
		};
	}

	const chunkBudget = Math.max(2000, Math.floor(availablePromptTokens * 0.35));
	const chunks = chunkTextByTokenBudget(combinedInput, chunkBudget);
	let rollingCompacted = "";
	let chunkCount = 0;

	for (const chunk of chunks) {
		chunkCount++;

		if (rollingCompacted && estimateStringTokens(rollingCompacted) > Math.floor(availablePromptTokens * 0.35)) {
			rollingCompacted = await compressRollingSummary({
				model,
				auth,
				rollingCompacted,
				compressionLevel: Math.min(3, compressionLevel + 1) as 0 | 1 | 2 | 3,
				timeoutMs,
				signal,
			});
		}

		const pass = await runCavemanPass({
			model,
			auth,
			inputObservations: rollingCompacted
				? `## PREVIOUSLY COMPACTED OBSERVATIONS\n\n${rollingCompacted}\n\n## ACTIVE OBSERVATIONS TO COMPRESS\n\n${chunk}`
				: chunk,
			compressionLevel,
			timeoutMs,
			signal,
		});

		if (pass.degenerate) {
			return {
				compactedObservations: rollingCompacted,
				compressed: estimateStringTokens(rollingCompacted) < inputTokens,
				degenerate: true,
				chunkCount,
			};
		}

		rollingCompacted = pass.compactedObservations;
	}

	return {
		compactedObservations: rollingCompacted,
		compressed: estimateStringTokens(rollingCompacted) < inputTokens,
		degenerate: false,
		chunkCount: Math.max(1, chunkCount),
	};
}

async function compressRollingSummary(params: {
	model: any;
	auth: RequestAuth;
	rollingCompacted: string;
	compressionLevel: 0 | 1 | 2 | 3;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<string> {
	const pass = await runCavemanPass({
		model: params.model,
		auth: params.auth,
		inputObservations: params.rollingCompacted,
		compressionLevel: params.compressionLevel,
		timeoutMs: params.timeoutMs,
		signal: params.signal,
	});
	if (pass.degenerate || !pass.compactedObservations.trim()) {
		return params.rollingCompacted;
	}
	return pass.compactedObservations;
}

async function runCavemanPass(params: {
	model: any;
	auth: RequestAuth;
	inputObservations: string;
	compressionLevel: 0 | 1 | 2 | 3;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{
	compactedObservations: string;
	degenerate: boolean;
}> {
	const { model, auth, inputObservations, compressionLevel, timeoutMs, signal } = params;
	const systemPrompt = buildCavemanReflectorSystemPrompt();
	const taskPrompt = buildCavemanReflectorPrompt(inputObservations, compressionLevel);
	const timeout = createTimeoutSignal(timeoutMs, signal);

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: taskPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal: timeout.signal },
		);

		if (response.stopReason === "error") {
			throw new Error(`Caveman reflector LLM error: ${response.errorMessage || "Unknown error"}`);
		}
		if (response.stopReason === "aborted") {
			throw timeout.signal.reason instanceof Error
				? timeout.signal.reason
				: new Error(`Caveman reflector request aborted after ${timeoutMs}ms`);
		}

		const output = response.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		if (detectDegenerateRepetition(output)) {
			return { compactedObservations: "", degenerate: true };
		}

		const parsed = extractReflectedObservations(output, inputObservations);
		return {
			compactedObservations: parsed.observations,
			degenerate: false,
		};
	} finally {
		timeout.dispose();
	}
}

function detectDegenerateRepetition(text: string): boolean {
	if (text.length < 200) return false;

	const chunkSize = 50;
	const threshold = 5;
	const seen = new Map<string, number>();

	for (let i = 0; i <= text.length - chunkSize; i += 10) {
		const chunk = text.slice(i, i + chunkSize);
		const count = (seen.get(chunk) || 0) + 1;
		seen.set(chunk, count);
		if (count > threshold) return true;
	}
	return false;
}
