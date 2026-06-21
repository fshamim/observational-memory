import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, completeSimple } from "@mariozechner/pi-ai";
import type { ObservationalMemoryConfig } from "./types";
import {
	isMissingProviderApiKeyError,
	prefersProviderManagedAuth,
	type RequestAuth,
} from "./auth";
import { formatMessagesForObserverLines } from "./message-formatter";
import { buildObserverSystemPrompt, buildObserverTaskPrompt } from "./prompts";
import { estimateStringTokens } from "./token-estimator";
import { chunkLinesByTokenBudget, takeTailWithinTokenBudget } from "./chunking";
import { createTimeoutSignal, parsePromptTooLongLimit } from "./async-utils";

export async function runObserver(params: {
	unobservedMessages: AgentMessage[];
	previousObservations: string;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	timezone: string;
	signal?: AbortSignal;
	promptTokenLimit?: number;
	timeoutMs?: number;
}): Promise<{
	observations: string;
	currentTask?: string;
	chunkCount: number;
}> {
	const { unobservedMessages, previousObservations, config, getAuth, timezone, signal } = params;
	const formattedLines = formatMessagesForObserverLines(unobservedMessages, timezone);
	if (formattedLines.length === 0) {
		return { observations: "", chunkCount: 0 };
	}

	let promptTokenLimit = params.promptTokenLimit ?? config.observerPromptTokenLimit;
	let lastError: unknown;

	for (let budgetAttempt = 1; budgetAttempt <= 3; budgetAttempt++) {
		try {
			return await runObserverWithBudget({
				formattedLines,
				previousObservations,
				config,
				getAuth,
				signal,
				promptTokenLimit,
				timeoutMs: params.timeoutMs ?? config.observerTimeoutMs,
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

	throw lastError instanceof Error ? lastError : new Error(String(lastError || "Observer failed"));
}

async function runObserverWithBudget(params: {
	formattedLines: string[];
	previousObservations: string;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	signal?: AbortSignal;
	promptTokenLimit: number;
	timeoutMs: number;
}): Promise<{
	observations: string;
	currentTask?: string;
	chunkCount: number;
}> {
	const { formattedLines, previousObservations, config, getAuth, signal, promptTokenLimit, timeoutMs } = params;
	const systemPrompt = buildObserverSystemPrompt();
	const systemTokens = estimateStringTokens(systemPrompt);
	const availablePromptTokens = Math.max(4000, promptTokenLimit - systemTokens - 4096 - 4096);
	const historyBudget = Math.max(2000, Math.min(20000, Math.floor(availablePromptTokens * 0.2)));
	const messageBudget = Math.max(2000, availablePromptTokens - historyBudget - 2048);
	const messageChunks = chunkLinesByTokenBudget(formattedLines, messageBudget);
	if (messageChunks.length === 0) {
		return { observations: "", chunkCount: 0 };
	}

	const model = getModel(
		config.observerModel.provider as any,
		config.observerModel.modelId as any,
	);
	const newObservationParts: string[] = [];
	let rollingObservations = previousObservations.trim();
	let currentTask: string | undefined;

	for (const chunkText of messageChunks) {
		const priorContext = takeTailWithinTokenBudget(rollingObservations, historyBudget);
		const taskPrompt = buildObserverTaskPrompt(chunkText, priorContext);
		const response = await completeObserverChunk({
			model,
			getAuth,
			systemPrompt,
			taskPrompt,
			timeoutMs,
			signal,
		});
		const parsed = parseObserverOutput(response);
		const observations = parsed.observations.trim();

		if (observations) {
			newObservationParts.push(observations);
			rollingObservations = rollingObservations
				? `${rollingObservations}\n\n${observations}`
				: observations;
		}
		if (parsed.currentTask) {
			currentTask = parsed.currentTask;
		}
	}

	return {
		observations: newObservationParts.join("\n\n").trim(),
		currentTask,
		chunkCount: messageChunks.length,
	};
}

async function completeObserverChunk(params: {
	model: any;
	getAuth: () => Promise<RequestAuth>;
	systemPrompt: string;
	taskPrompt: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<string> {
	const { model, getAuth, systemPrompt, taskPrompt, timeoutMs, signal } = params;
	const timeout = createTimeoutSignal(timeoutMs, signal);
	const context = {
		systemPrompt,
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: taskPrompt }],
				timestamp: Date.now(),
			},
		],
	};
	const baseOptions = { maxTokens: 4096, signal: timeout.signal };
	try {
		try {
			const response = await completeSimple(model, context, baseOptions);
			return extractObserverText(response, timeout.signal, timeoutMs);
		} catch (error) {
			if (!prefersProviderManagedAuth(model) || !isMissingProviderApiKeyError(error, model.provider)) {
				throw error;
			}
			// ponytail: MultiCodex overrides the provider stream; if it is not present, fall back to direct auth.
		}

		const auth = await getAuth();
		const response = await completeSimple(model, context, {
			...baseOptions,
			apiKey: auth.apiKey,
			headers: auth.headers,
		});
		return extractObserverText(response, timeout.signal, timeoutMs);
	} finally {
		timeout.dispose();
	}
}

function extractObserverText(response: any, signal: AbortSignal, timeoutMs: number): string {
	if (response.stopReason === "error") {
		throw new Error(`Observer LLM error: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "aborted") {
		throw signal.reason instanceof Error ? signal.reason : new Error(`Observer request aborted after ${timeoutMs}ms`);
	}

	return response.content
		.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

function parseObserverOutput(output: string): {
	observations: string;
	currentTask?: string;
} {
	if (detectDegenerateRepetition(output)) {
		return { observations: "" };
	}

	const observationsMatch = output.match(/<observations>([\s\S]*?)<\/observations>/i);
	const observations = observationsMatch?.[1]?.trim() || "";

	const taskMatch = output.match(/<current-task>([\s\S]*?)<\/current-task>/i);
	const currentTask = taskMatch?.[1]?.trim() || undefined;

	if (!observations && output.trim()) {
		const listLines = output
			.split("\n")
			.filter((line) => /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line));
		if (listLines.length > 0) {
			return { observations: listLines.join("\n"), currentTask };
		}
		return { observations: output.trim(), currentTask };
	}

	return { observations, currentTask };
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
