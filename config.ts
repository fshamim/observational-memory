import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
	type ObservationalMemoryConfig,
	DEFAULT_CONFIG,
	type ArchiveConfig,
	type OversizedEntryConfig,
	type SessionRolloverConfig,
	type ExperienceBankConfig,
	type CacheOptimizationConfig,
	type CompressionStrategy,
	type RawMessageQueueConfig,
	type ObservationQueueConfig,
	type ReflectionQueueConfig,
	type ExperienceGenerationConfig,
} from "./types";

export function getGlobalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions", "observational-memory", "config.json");
}

export function getProjectConfigPath(cwd = process.cwd()): string {
	return path.join(cwd, ".pi", "observational-memory.json");
}

export function stringifyDefaultConfig(): string {
	return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

export function ensureProjectConfigFile(cwd = process.cwd()): {
	path: string;
	created: boolean;
	error?: string;
} {
	const filePath = getProjectConfigPath(cwd);
	try {
		if (fs.existsSync(filePath)) {
			return { path: filePath, created: false };
		}
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, stringifyDefaultConfig(), { flag: "wx" });
		return { path: filePath, created: true };
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? String((error as any).code || "") : "";
		if (code === "EEXIST") {
			return { path: filePath, created: false };
		}
		return {
			path: filePath,
			created: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepMerge<T>(base: T, override: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(override)) {
		return (override as T) ?? base;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = out[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			out[key] = deepMerge(existing, value);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

function readJsonObject(filePath: string): Record<string, unknown> {
	try {
		if (fs.existsSync(filePath)) {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			return isPlainObject(parsed) ? parsed : {};
		}
	} catch {
		// Ignore invalid config files and fall back to defaults.
	}
	return {};
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, value));
}

function loadMergedRawConfig(cwd = process.cwd()): Record<string, unknown> {
	const globalRaw = readJsonObject(getGlobalConfigPath());
	const projectRaw = readJsonObject(getProjectConfigPath(cwd));
	return deepMerge(deepMerge({}, globalRaw), projectRaw);
}

function applyLegacyAliases(raw: Record<string, unknown>): Record<string, unknown> {
	const merged = deepMerge({}, raw) as Record<string, unknown>;
	const rawMessages = isPlainObject(merged.rawMessages) ? { ...merged.rawMessages } : {};
	const observations = isPlainObject(merged.observations) ? { ...merged.observations } : {};
	const reflections = isPlainObject(merged.reflections) ? { ...merged.reflections } : {};
	const experiences = isPlainObject(merged.experiences) ? { ...merged.experiences } : {};

	if (rawMessages.observeThresholdPercent === undefined) {
		rawMessages.observeThresholdPercent = merged.observationTriggerContextPercent ?? merged.forceObserveContextPercent;
	}
	if (rawMessages.oldestScopePercent === undefined) {
		rawMessages.oldestScopePercent = merged.observationScopePercent ?? merged.observationScopeContextPercent ?? merged.observationScopePercent;
	}
	if (observations.reobserveThresholdPercent === undefined) {
		observations.reobserveThresholdPercent = merged.reflectionTriggerContextPercent ?? merged.reflectionObservationContextPercent;
	}
	if (observations.oldestScopePercent === undefined) {
		observations.oldestScopePercent = merged.reflectionTargetContextPercent;
	}
	if (experiences.enabled === undefined && isPlainObject(merged.experienceBank)) {
		experiences.enabled = (merged.experienceBank as Record<string, unknown>).enabled;
	}
	merged.rawMessages = rawMessages;
	merged.observations = observations;
	merged.reflections = reflections;
	merged.experiences = experiences;
	return merged;
}

function resolveSessionRolloverConfig(merged: Record<string, unknown>): SessionRolloverConfig {
	const raw = isPlainObject(merged.sessionRollover) ? merged.sessionRollover : {};
	return {
		enabled: asBoolean(raw.enabled, DEFAULT_CONFIG.sessionRollover.enabled),
		warnBytes: clampNumber(raw.warnBytes, DEFAULT_CONFIG.sessionRollover.warnBytes, 8 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
		targetBytes: clampNumber(raw.targetBytes, DEFAULT_CONFIG.sessionRollover.targetBytes, 16 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
		hardBytes: clampNumber(raw.hardBytes, DEFAULT_CONFIG.sessionRollover.hardBytes, 24 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
		legacyRecoveryCandidateBytes: clampNumber(raw.legacyRecoveryCandidateBytes, DEFAULT_CONFIG.sessionRollover.legacyRecoveryCandidateBytes, 32 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
		minProjectedSavingsBytes: clampNumber(raw.minProjectedSavingsBytes, DEFAULT_CONFIG.sessionRollover.minProjectedSavingsBytes, 1 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
	};
}

function resolveOversizedEntryConfig(merged: Record<string, unknown>): OversizedEntryConfig {
	const raw = isPlainObject(merged.oversizedEntries) ? merged.oversizedEntries : {};
	return {
		entryBytes: clampNumber(raw.entryBytes, DEFAULT_CONFIG.oversizedEntries.entryBytes, 1024, Number.MAX_SAFE_INTEGER),
		stubPreviewChars: clampNumber(raw.stubPreviewChars, DEFAULT_CONFIG.oversizedEntries.stubPreviewChars, 120, 8000),
		trimWorkflowToolResults: asBoolean(raw.trimWorkflowToolResults, DEFAULT_CONFIG.oversizedEntries.trimWorkflowToolResults),
	};
}

function resolveArchiveConfig(merged: Record<string, unknown>): ArchiveConfig {
	const raw = isPlainObject(merged.archive) ? merged.archive : {};
	return {
		targetChunkBytes: clampNumber(raw.targetChunkBytes, DEFAULT_CONFIG.archive.targetChunkBytes, 1024, Number.MAX_SAFE_INTEGER),
		maxChunkBytes: clampNumber(raw.maxChunkBytes, DEFAULT_CONFIG.archive.maxChunkBytes, 1024, Number.MAX_SAFE_INTEGER),
		preserveOriginalSessionFile: asBoolean(raw.preserveOriginalSessionFile, DEFAULT_CONFIG.archive.preserveOriginalSessionFile),
	};
}

function resolveExperienceBankConfig(merged: Record<string, unknown>): ExperienceBankConfig {
	const raw = isPlainObject(merged.experienceBank) ? merged.experienceBank : {};
	return {
		enabled: asBoolean(raw.enabled, DEFAULT_CONFIG.experienceBank.enabled),
		maxInjectedExperiences: clampNumber(raw.maxInjectedExperiences, DEFAULT_CONFIG.experienceBank.maxInjectedExperiences, 0, 12),
		minScoreToInject: clampNumber(raw.minScoreToInject, DEFAULT_CONFIG.experienceBank.minScoreToInject, -1000, 1000),
		maxTextChars: clampNumber(raw.maxTextChars, DEFAULT_CONFIG.experienceBank.maxTextChars, 60, 2000),
	};
}

function resolveCompressionStrategy(value: unknown): CompressionStrategy {
	const normalized = String(value || "").trim().toLowerCase();
	return normalized === "reflector" || normalized === "reobserve"
		? (normalized as CompressionStrategy)
		: DEFAULT_CONFIG.compressionStrategy;
}

function resolveCacheOptimizationConfig(merged: Record<string, unknown>): CacheOptimizationConfig {
	const raw = isPlainObject(merged.cacheOptimization) ? merged.cacheOptimization : {};
	return {
		enabled: asBoolean(raw.enabled, DEFAULT_CONFIG.cacheOptimization.enabled),
		maxPromptContextPercent: clampNumber(raw.maxPromptContextPercent, DEFAULT_CONFIG.cacheOptimization.maxPromptContextPercent, 20, 95),
		snapshotTokenBudget: clampNumber(raw.snapshotTokenBudget, DEFAULT_CONFIG.cacheOptimization.snapshotTokenBudget, 2000, 200000),
		activeTailTokenBudget: clampNumber(raw.activeTailTokenBudget, DEFAULT_CONFIG.cacheOptimization.activeTailTokenBudget, 500, 50000),
		minCheckpointTurns: clampNumber(raw.minCheckpointTurns, DEFAULT_CONFIG.cacheOptimization.minCheckpointTurns, 0, 200),
		minCheckpointMs: clampNumber(raw.minCheckpointMs, DEFAULT_CONFIG.cacheOptimization.minCheckpointMs, 0, 24 * 60 * 60 * 1000),
	};
}

function resolveRawMessagesConfig(merged: Record<string, unknown>): RawMessageQueueConfig {
	const raw = isPlainObject(merged.rawMessages) ? merged.rawMessages : {};
	return {
		observeThresholdPercent: clampNumber(raw.observeThresholdPercent, DEFAULT_CONFIG.rawMessages.observeThresholdPercent, 1, 95),
		oldestScopePercent: clampNumber(raw.oldestScopePercent, DEFAULT_CONFIG.rawMessages.oldestScopePercent, 1, 100),
	};
}

function resolveObservationsConfig(merged: Record<string, unknown>): ObservationQueueConfig {
	const raw = isPlainObject(merged.observations) ? merged.observations : {};
	return {
		reobserveThresholdPercent: clampNumber(raw.reobserveThresholdPercent, DEFAULT_CONFIG.observations.reobserveThresholdPercent, 1, 95),
		oldestScopePercent: clampNumber(raw.oldestScopePercent, DEFAULT_CONFIG.observations.oldestScopePercent, 1, 100),
	};
}

function resolveReflectionsConfig(merged: Record<string, unknown>): ReflectionQueueConfig {
	const raw = isPlainObject(merged.reflections) ? merged.reflections : {};
	return {
		reobserveThresholdPercent: clampNumber(raw.reobserveThresholdPercent, DEFAULT_CONFIG.reflections.reobserveThresholdPercent, 1, 95),
		archiveOldToMemoryMd: asBoolean(raw.archiveOldToMemoryMd, DEFAULT_CONFIG.reflections.archiveOldToMemoryMd),
		archiveThresholdPercent: clampNumber(raw.archiveThresholdPercent, DEFAULT_CONFIG.reflections.archiveThresholdPercent, 1, 95),
		archivePlaceholderTokenBudget: clampNumber(raw.archivePlaceholderTokenBudget, DEFAULT_CONFIG.reflections.archivePlaceholderTokenBudget, 0, 8192),
		memoryMdPath: asString(raw.memoryMdPath, DEFAULT_CONFIG.reflections.memoryMdPath),
	};
}

function resolveExperiencesConfig(merged: Record<string, unknown>): ExperienceGenerationConfig {
	const raw = isPlainObject(merged.experiences) ? merged.experiences : {};
	return {
		enabled: asBoolean(raw.enabled, DEFAULT_CONFIG.experiences.enabled),
		generateAfter: "observations",
		maxOpsPerObservation: clampNumber(raw.maxOpsPerObservation, DEFAULT_CONFIG.experiences.maxOpsPerObservation, 0, 10),
		maxWords: clampNumber(raw.maxWords, DEFAULT_CONFIG.experiences.maxWords, 16, 96),
		mergeSimilarityThreshold: clampNumber(raw.mergeSimilarityThreshold, DEFAULT_CONFIG.experiences.mergeSimilarityThreshold, 0, 1),
	};
}

export function loadConfig(cwd = process.cwd()): ObservationalMemoryConfig {
	const raw = applyLegacyAliases(loadMergedRawConfig(cwd));
	const merged = deepMerge(DEFAULT_CONFIG, raw) as ObservationalMemoryConfig & Record<string, unknown>;
	const compressionStrategy = resolveCompressionStrategy(merged.compressionStrategy);
	const cacheOptimization = resolveCacheOptimizationConfig(merged);
	const rawMessages = resolveRawMessagesConfig(merged);
	const observations = resolveObservationsConfig(merged);
	const reflections = resolveReflectionsConfig(merged);
	const experiences = resolveExperiencesConfig(merged);
	const sessionRollover = resolveSessionRolloverConfig(merged);
	const oversizedEntries = resolveOversizedEntryConfig(merged);
	const archive = resolveArchiveConfig(merged);
	const experienceBank = resolveExperienceBankConfig(merged);
	const normalizedTargetBytes = Math.max(sessionRollover.warnBytes, sessionRollover.targetBytes);
	const normalizedHardBytes = Math.max(normalizedTargetBytes, sessionRollover.hardBytes);
	const normalizedArchiveMax = Math.max(archive.targetChunkBytes, archive.maxChunkBytes);
	const observationTriggerContextPercent = rawMessages.observeThresholdPercent;
	const observationTargetContextPercent = Math.max(5, Math.min(observationTriggerContextPercent - 1, clampNumber(merged.observationTargetContextPercent, DEFAULT_CONFIG.observationTargetContextPercent, 1, 94)));
	const reflectionTriggerContextPercent = observations.reobserveThresholdPercent;
	const reflectionTargetContextPercent = Math.max(1, Math.min(reflectionTriggerContextPercent - 1, clampNumber(merged.reflectionTargetContextPercent, DEFAULT_CONFIG.reflectionTargetContextPercent, 1, 89)));

	return {
		enabled: asBoolean(merged.enabled, DEFAULT_CONFIG.enabled),
		observerModel: {
			provider: asString(merged?.observerModel?.provider, DEFAULT_CONFIG.observerModel.provider),
			modelId: asString(merged?.observerModel?.modelId, DEFAULT_CONFIG.observerModel.modelId),
		},
		reflectorModel: {
			provider: asString(merged?.reflectorModel?.provider, DEFAULT_CONFIG.reflectorModel.provider),
			modelId: asString(merged?.reflectorModel?.modelId, DEFAULT_CONFIG.reflectorModel.modelId),
		},
		compressionStrategy,
		observationTriggerContextPercent,
		observationTargetContextPercent,
		observationScopePercent: rawMessages.oldestScopePercent,
		preserveRecentMessages: clampNumber(merged.preserveRecentMessages, DEFAULT_CONFIG.preserveRecentMessages, 1, 400),
		minObservationMessages: clampNumber(merged.minObservationMessages, DEFAULT_CONFIG.minObservationMessages, 1, 200),
		reflectionTriggerContextPercent,
		reflectionTargetContextPercent,
		contextWindowSize: clampNumber(merged.contextWindowSize, DEFAULT_CONFIG.contextWindowSize, 10000, Number.MAX_SAFE_INTEGER),
		maxReflectionRetries: clampNumber(merged.maxReflectionRetries, DEFAULT_CONFIG.maxReflectionRetries, 0, 6),
		observerPromptTokenLimit: clampNumber(merged.observerPromptTokenLimit, DEFAULT_CONFIG.observerPromptTokenLimit, 8000, Number.MAX_SAFE_INTEGER),
		reflectorPromptTokenLimit: clampNumber(merged.reflectorPromptTokenLimit, DEFAULT_CONFIG.reflectorPromptTokenLimit, 8000, Number.MAX_SAFE_INTEGER),
		observerTimeoutMs: clampNumber(merged.observerTimeoutMs, DEFAULT_CONFIG.observerTimeoutMs, 1000, Number.MAX_SAFE_INTEGER),
		reflectorTimeoutMs: clampNumber(merged.reflectorTimeoutMs, DEFAULT_CONFIG.reflectorTimeoutMs, 1000, Number.MAX_SAFE_INTEGER),
		observerMaxAttempts: clampNumber(merged.observerMaxAttempts, DEFAULT_CONFIG.observerMaxAttempts, 1, 6),
		reflectorMaxAttempts: clampNumber(merged.reflectorMaxAttempts, DEFAULT_CONFIG.reflectorMaxAttempts, 1, 6),
		retryBaseDelayMs: clampNumber(merged.retryBaseDelayMs, DEFAULT_CONFIG.retryBaseDelayMs, 250, Number.MAX_SAFE_INTEGER),
		retryMaxDelayMs: clampNumber(merged.retryMaxDelayMs, DEFAULT_CONFIG.retryMaxDelayMs, 1000, Number.MAX_SAFE_INTEGER),
		errorNotifyCooldownMs: clampNumber(merged.errorNotifyCooldownMs, DEFAULT_CONFIG.errorNotifyCooldownMs, 0, Number.MAX_SAFE_INTEGER),
		footerRenderThrottleMs: clampNumber(merged.footerRenderThrottleMs, DEFAULT_CONFIG.footerRenderThrottleMs, 50, 5000),
		footerUsagePollIntervalMs: clampNumber((raw as any).footerUsagePollIntervalMs ?? (raw as any).codexQuotaPollIntervalMs, DEFAULT_CONFIG.footerUsagePollIntervalMs, 0, 24 * 60 * 60 * 1000),
		cacheOptimization,
		sessionRollover: {
			...sessionRollover,
			targetBytes: normalizedTargetBytes,
			hardBytes: normalizedHardBytes,
		},
		oversizedEntries,
		archive: {
			...archive,
			maxChunkBytes: normalizedArchiveMax,
		},
		experienceBank,
		rawMessages,
		observations,
		reflections,
		experiences,
	};
}
