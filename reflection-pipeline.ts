import type { RequestAuth } from "./auth";
import { appendReflectionsToMemoryMd } from "./memory-md";
import {
	appendReflectionFromObservations,
	computeQueueTokenTotals,
	getActiveReflectionItems,
	getReflectionText,
	getReflectionTokenTotal,
	hasObservationItems,
	hasReflectionItems,
	replaceReflectionsAfterArchive,
	selectOldestObservationBatch,
} from "./memory-queues";
import { chooseReflectionMode, computeOmContextThresholds, type OmContextThresholds } from "./pipeline-planner";
import { validateReflectedObservations } from "./reflection-guard";
import type { ObservationState, ObservationalMemoryConfig } from "./types";

export interface ReflectionRunPlan {
	strategy: "reflector" | "reobserve";
	mode: "observations" | "reflections";
	thresholds: OmContextThresholds;
	observationTokens: number;
	reflectionTokens: number;
	maxAttempts: number;
	timeoutMs: number;
	promptTokenLimit: number;
}

type ReflectorRunner = (params: {
	observations: string;
	existingCompacted: string;
	compressionLevel: 0 | 1 | 2 | 3;
	generationCount: number;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	signal?: AbortSignal;
	promptTokenLimit?: number;
	timeoutMs?: number;
}) => Promise<{
	compactedObservations: string;
	compressed: boolean;
	degenerate: boolean;
	chunkCount: number;
}>;

type ReobserverRunner = (params: {
	observations: string;
	existingCompacted: string;
	config: ObservationalMemoryConfig;
	getAuth: () => Promise<RequestAuth>;
	signal?: AbortSignal;
	timeoutMs?: number;
	promptTokenLimit?: number;
}) => Promise<{
	compactedObservations: string;
	compressed: boolean;
	degenerate: boolean;
	chunkCount: number;
}>;

export interface ReflectionPipelineDeps {
	runReflector?: ReflectorRunner;
	runReobserver?: ReobserverRunner;
	appendReflectionsToMemoryMd?: typeof appendReflectionsToMemoryMd;
	validateReflectedObservations?: typeof validateReflectedObservations;
}

export function planReflectionRun(args: {
	config: ObservationalMemoryConfig;
	state: ObservationState;
	strategy: "reflector" | "reobserve";
	force?: boolean;
	contextWindow: number;
	completedTurnCount: number;
	lastReflectionCheckpointTurn: number;
	lastReflectionCheckpointAtMs: number;
	nowMs?: number;
}): ReflectionRunPlan | null {
	if (!hasObservationItems(args.state) && !hasReflectionItems(args.state)) {
		return null;
	}

	const thresholds = computeOmContextThresholds({
		config: args.config,
		contextWindow: args.contextWindow,
	});
	const observationTokens = args.state.totalObservationTokens;
	const reflectionTokens = getReflectionTokenTotal(args.state);
	const mode = chooseReflectionMode({
		state: args.state,
		thresholds,
		force: args.force,
	});
	if (!mode) {
		return null;
	}

	if (args.strategy === "reobserve" && args.config.cacheOptimization.enabled && !args.force) {
		const turnsSinceCheckpoint = Math.max(0, args.completedTurnCount - args.lastReflectionCheckpointTurn);
		const msSinceCheckpoint = (args.nowMs ?? Date.now()) - args.lastReflectionCheckpointAtMs;
		const enoughTurns = turnsSinceCheckpoint >= args.config.cacheOptimization.minCheckpointTurns;
		const enoughTime = msSinceCheckpoint >= args.config.cacheOptimization.minCheckpointMs;
		if (!enoughTurns || !enoughTime) {
			return null;
		}
	}

	return {
		strategy: args.strategy,
		mode,
		thresholds,
		observationTokens,
		reflectionTokens,
		maxAttempts: Math.max(1, args.strategy === "reobserve" ? args.config.observerMaxAttempts : args.config.reflectorMaxAttempts),
		timeoutMs: args.strategy === "reobserve" ? args.config.observerTimeoutMs : args.config.reflectorTimeoutMs,
		promptTokenLimit: args.strategy === "reobserve" ? args.config.observerPromptTokenLimit : args.config.reflectorPromptTokenLimit,
	};
}

export async function executeReflectionPlan(args: {
	config: ObservationalMemoryConfig;
	state: ObservationState;
	getAuth: () => Promise<RequestAuth>;
	plan: ReflectionRunPlan;
	cwd: string;
	sessionName: string;
	signal?: AbortSignal;
	deps?: ReflectionPipelineDeps;
}): Promise<boolean> {
	const appendArchive = args.deps?.appendReflectionsToMemoryMd ?? appendReflectionsToMemoryMd;
	const validate = args.deps?.validateReflectedObservations ?? validateReflectedObservations;
	const maxCompressionRetries = args.plan.strategy === "reobserve" ? 0 : args.config.maxReflectionRetries;
	let inputText = "";
	let sourceObservationIds: string[] = [];
	let archivedHash: string | undefined;
	let previousReflectionText = "";

	if (args.plan.mode === "observations") {
		const batch = selectOldestObservationBatch({
			state: args.state,
			contextWindow: args.plan.thresholds.contextWindow,
			oldestScopePercent: args.config.observations.oldestScopePercent,
		});
		if (!batch || !batch.text.trim()) {
			return false;
		}
		inputText = batch.text;
		sourceObservationIds = batch.items.map((item) => item.id);
	} else {
		const activeReflections = getActiveReflectionItems(args.state);
		previousReflectionText = getReflectionText(args.state).trim();
		if (!previousReflectionText || activeReflections.length === 0) {
			return false;
		}
		inputText = previousReflectionText;
		const archiveThresholdTokens = Math.max(
			1,
			Math.floor(args.plan.thresholds.contextWindow * (Math.max(1, Math.min(100, args.config.reflections.archiveThresholdPercent)) / 100)),
		);
		if (args.config.reflections.archiveOldToMemoryMd && args.state.totalReflectionTokens >= archiveThresholdTokens) {
			const archived = await appendArchive({
				cwd: args.cwd,
				configuredPath: args.config.reflections.memoryMdPath,
				sessionName: args.sessionName,
				generation: args.state.generationCount,
				reflections: activeReflections,
			});
			archivedHash = archived.hash;
		}
	}

	let lastError: unknown;
	for (let level = 0; level <= maxCompressionRetries; level++) {
		try {
			const result = args.plan.strategy === "reobserve"
				? await (args.deps?.runReobserver ?? (await import("./reobserver")).runReobserver)({
					observations: inputText,
					existingCompacted: "",
					config: args.config,
					getAuth: args.getAuth,
					signal: args.signal,
					timeoutMs: args.plan.timeoutMs,
					promptTokenLimit: args.plan.promptTokenLimit,
				})
				: await (args.deps?.runReflector ?? (await import("./reflector")).runReflector)({
					observations: inputText,
					existingCompacted: "",
					compressionLevel: level as 0 | 1 | 2 | 3,
					generationCount: args.state.generationCount,
					config: args.config,
					getAuth: args.getAuth,
					signal: args.signal,
					timeoutMs: args.plan.timeoutMs,
					promptTokenLimit: args.plan.promptTokenLimit,
				});
			if (result.degenerate) {
				return false;
			}

			const compactedText = result.compactedObservations.trim();
			const validation = validate({
				inputObservations: inputText,
				existingCompacted: "",
				compactedObservations: compactedText,
			});
			if (!validation.ok) {
				const validationError = new Error(
					`Reflection output rejected by safety guard (${validation.reason}; input~${validation.inputTokens}, output~${validation.outputTokens}, ratio=${validation.compressionRatio.toFixed(4)}, overlap=${validation.keywordOverlap.toFixed(4)})`,
				);
				validationError.name = "ReflectionSafetyGuardError";
				throw validationError;
			}
			if (!result.compressed && level < maxCompressionRetries) {
				continue;
			}

			if (args.plan.mode === "observations") {
				appendReflectionFromObservations({
					state: args.state,
					reflectionText: compactedText,
					consumedObservationIds: sourceObservationIds,
				});
			} else {
				replaceReflectionsAfterArchive({
					state: args.state,
					reflectionText: compactedText,
					archivedHash,
					archivedPath: archivedHash ? args.config.reflections.memoryMdPath : undefined,
					placeholderTokenBudget: args.config.reflections.archivePlaceholderTokenBudget,
				});
			}
			computeQueueTokenTotals(args.state);
			return true;
		} catch (error) {
			if (error instanceof Error && error.name === "ReflectionSafetyGuardError") {
				throw error;
			}
			lastError = error;
		}
	}

	if (lastError) {
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	return false;
}
