export interface SessionRolloverConfig {
	enabled: boolean;
	warnBytes: number;
	targetBytes: number;
	hardBytes: number;
	legacyRecoveryCandidateBytes: number;
	minProjectedSavingsBytes: number;
}

export interface OversizedEntryConfig {
	entryBytes: number;
	stubPreviewChars: number;
	trimWorkflowToolResults: boolean;
}

export interface ArchiveConfig {
	targetChunkBytes: number;
	maxChunkBytes: number;
	preserveOriginalSessionFile: boolean;
}

export interface ExperienceBankConfig {
	enabled: boolean;
	maxInjectedExperiences: number;
	minScoreToInject: number;
	maxTextChars: number;
}

export type CompressionStrategy = "reflector" | "reobserve";

export interface CacheOptimizationConfig {
	enabled: boolean;
	maxPromptContextPercent: number;
	snapshotTokenBudget: number;
	activeTailTokenBudget: number;
	minCheckpointTurns: number;
	minCheckpointMs: number;
}

export interface RawMessageQueueConfig {
	observeThresholdPercent: number;
	oldestScopePercent: number;
}

export interface ObservationQueueConfig {
	reobserveThresholdPercent: number;
	oldestScopePercent: number;
}

export interface ReflectionQueueConfig {
	reobserveThresholdPercent: number;
	archiveOldToMemoryMd: boolean;
	archiveThresholdPercent: number;
	archivePlaceholderTokenBudget: number;
	memoryMdPath: string;
}

export interface ExperienceGenerationConfig {
	enabled: boolean;
	generateAfter: "observations";
	maxOpsPerObservation: number;
	maxWords: number;
	mergeSimilarityThreshold: number;
}

export interface ObservationalMemoryConfig {
	enabled: boolean;
	observerModel: { provider: string; modelId: string };
	reflectorModel: { provider: string; modelId: string };

	compressionStrategy: CompressionStrategy;
	observationTriggerContextPercent: number;
	observationTargetContextPercent: number;
	observationScopePercent: number;
	preserveRecentMessages: number;
	minObservationMessages: number;
	reflectionTriggerContextPercent: number;
	reflectionTargetContextPercent: number;
	contextWindowSize: number;

	maxReflectionRetries: number;
	observerPromptTokenLimit: number;
	reflectorPromptTokenLimit: number;
	observerTimeoutMs: number;
	reflectorTimeoutMs: number;
	observerMaxAttempts: number;
	reflectorMaxAttempts: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	errorNotifyCooldownMs: number;
	footerRenderThrottleMs: number;
	footerUsagePollIntervalMs: number;
	cacheOptimization: CacheOptimizationConfig;

	sessionRollover: SessionRolloverConfig;
	oversizedEntries: OversizedEntryConfig;
	archive: ArchiveConfig;
	experienceBank: ExperienceBankConfig;
	rawMessages: RawMessageQueueConfig;
	observations: ObservationQueueConfig;
	reflections: ReflectionQueueConfig;
	experiences: ExperienceGenerationConfig;
}

// Notes for the examples below:
// - Percent examples use a 272k-token runtime context window because that is a
//   common live model window in OM sessions.
// - Example math therefore uses 272,000 * percent.
// - Actual runtime thresholds are recomputed from the active model's window.
// - `contextWindowSize` below is only the fallback when runtime/model metadata
//   is unavailable, so examples intentionally use 272k even though the fallback
//   default remains 250k.
export const DEFAULT_CONFIG: ObservationalMemoryConfig = {
	// Master on/off switch for OM. If false, no prompt injection, observation,
	// reflection, footer updates, rollover, or experience-bank work runs.
	enabled: true,

	// Model used for observation passes. In `reobserve` mode this is also the
	// model that performs compaction-style reflection work.
	observerModel: { provider: "openai-codex", modelId: "gpt-5.4-mini" },

	// Separate model for classic reflector mode. In `reobserve` mode this can be
	// configured but is not the primary compaction path.
	reflectorModel: { provider: "openai-codex", modelId: "gpt-5.4-mini" },

	// `reobserve` = compact by re-observing older summaries into fewer summaries.
	// `reflector` = use the dedicated reflection pipeline/model.
	compressionStrategy: "reobserve",

	// Public/legacy top-level mirror of the observation trigger. This is the
	// context-usage percent where OM starts trying to observe older raw messages.
	// Example at 272k: 45% = 122,400 tokens.
	observationTriggerContextPercent: 50,

	// Public/legacy top-level mirror of the observation target. After OM starts
	// observing, it tries to get effective context usage back down toward this
	// target instead of hovering right at the trigger.
	// Example at 272k: 25% = 68,000 tokens.
	observationTargetContextPercent: 30,

	// Legacy top-level scope hint for how much of the oldest still-unobserved raw
	// history may be considered in one observation planning pass.
	// Example at 272k: 65% = 176,800 tokens of the oldest raw backlog can be in
	// scope before other guards trim further.
	observationScopePercent: 5,

	// Always protect this many newest raw messages from being swept into the next
	// observation batch so the active conversation tail stays intact.
	preserveRecentMessages: 12,

	// Never schedule an observation batch smaller than this many messages.
	// `1` allows OM to make progress even when only a single safe message remains.
	minObservationMessages: 10,

	// Public/legacy top-level reflection trigger mirror. This represents the
	// normalized reflection trigger percent after config loading.
	// Example at 272k: 10% = 27,200 tokens.
	// Note: with the current nested defaults below, the effective reobserve
	// trigger is driven by `observations.reobserveThresholdPercent` (15%).
	reflectionTriggerContextPercent: 12,

	// Once reflection/compaction starts, OM tries to reduce observation pressure
	// toward this target rather than stopping exactly at the trigger.
	// Example at 272k: 5% = 13,600 tokens.
	reflectionTargetContextPercent: 5,

	// Fallback context window used only when runtime/model metadata does not
	// provide a better value. Threshold comments in this file still use 272k
	// because that is the common live runtime example.
	contextWindowSize: 250000,

	// Maximum extra retry attempts for reflector-style compression validation.
	// `3` means OM can keep trying a few times before giving up on that run.
	maxReflectionRetries: 3,

	// Hard cap for the observer request prompt size.
	// Example: even on a 272k model, OM keeps observer prompts under 160k.
	observerPromptTokenLimit: 160000,

	// Hard cap for dedicated reflector prompts.
	// Example: even on a 272k model, reflector prompts stay under 140k.
	reflectorPromptTokenLimit: 140000,

	// Abort a single observation model call after 30 seconds.
	observerTimeoutMs: 30000,

	// Abort a single reflector model call after 30 seconds.
	reflectorTimeoutMs: 30000,

	// Retry observation calls up to 3 attempts total when transient failures hit.
	observerMaxAttempts: 3,

	// Retry reflector calls up to 3 attempts total when transient failures hit.
	reflectorMaxAttempts: 3,

	// First retry backoff delay = 5 seconds.
	retryBaseDelayMs: 5000,

	// Retry backoff never grows beyond 60 seconds.
	retryMaxDelayMs: 60000,

	// Avoid spamming repeated OM error notifications more often than once per
	// minute unless the code explicitly forces a notification.
	errorNotifyCooldownMs: 60000,

	// Throttle footer redraw work to at most about once every 1.25 seconds.
	footerRenderThrottleMs: 1250,

	// Refresh footer usage/quota polling every 5 minutes.
	footerUsagePollIntervalMs: 5 * 60 * 1000,

	cacheOptimization: {
		// When enabled, OM derives thresholds from a capped share of the prompt
		// budget instead of treating the full context window as safely usable.
		enabled: true,

		// Soft cap for how much of the prompt OM wants to treat as usable working
		// context. With a 272k window, 50% = 136,000 tokens.
		// This cap also clamps other thresholds above it.
		maxPromptContextPercent: 60,

		// How many reflection tokens may be re-injected as a compact snapshot.
		// Example: at most ~12k tokens of prior compacted memory ride forward.
		snapshotTokenBudget: 12000,

		// How many observation tokens from the active tail may be re-injected.
		// Example: keep only ~2.5k tokens of the freshest observation tail active.
		activeTailTokenBudget: 2500,

		// In `reobserve` mode, require at least 6 completed turns since the last
		// reflection checkpoint before another automatic reflection can start.
		minCheckpointTurns: 6,

		// In `reobserve` mode, also require at least 5 minutes since the last
		// reflection checkpoint. Both turn and time gates must pass.
		minCheckpointMs: 5 * 60 * 1000,
	},

	sessionRollover: {
		// Allow OM to prepare/suggest session rollover for very large session files.
		enabled: true,

		// Start warning when the session file reaches about 150 MiB.
		warnBytes: 10 * 1024 * 1024,

		// Preferred rollover target point: about 200 MiB.
		targetBytes: 20 * 1024 * 1024,

		// Stronger guardrail: beyond about 250 MiB, rollover becomes urgent.
		hardBytes: 30 * 1024 * 1024,

		// Legacy recovery threshold for especially bloated historical sessions.
		legacyRecoveryCandidateBytes: 40 * 1024 * 1024,

		// Only bother rolling over if OM estimates it can save at least ~50 MiB.
		minProjectedSavingsBytes: 3 * 1024 * 1024,
	},

	oversizedEntries: {
		// Any single session entry above ~8 MiB is considered oversized and may be
		// stubbed/trimmed for safer archival and rollover handling.
		entryBytes: 8 * 1024 * 1024,

		// Keep up to 1,500 preview characters when replacing an oversized entry
		// with a stub so humans still see what it was.
		stubPreviewChars: 1500,

		// Special-case workflow tool results because they can explode session size.
		trimWorkflowToolResults: true,
	},

	archive: {
		// Preferred archive chunk size during rollover: ~64 MiB per chunk.
		targetChunkBytes: 64 * 1024 * 1024,

		// Hard ceiling for any archive chunk: ~128 MiB.
		maxChunkBytes: 128 * 1024 * 1024,

		// Keep the original session file after rollover instead of deleting it.
		preserveOriginalSessionFile: true,
	},

	experienceBank: {
		// Enable the experience-bank feature that stores reusable execution tips / rules.
		enabled: true,

		// Inject at most 3 matching experiences into the active prompt at once.
		maxInjectedExperiences: 3,

		// Only inject experiences whose retrieval score is at least 20.
		minScoreToInject: 20,

		// Truncate injected experience text to 240 characters each.
		maxTextChars: 240,
	},

	rawMessages: {
		// Effective observation trigger used by runtime threshold math.
		// At a 272k window: 45% = 122,400 tokens.
		// Because cacheOptimization caps usable prompt share at 60%, this 49%
		// remains valid; if you set this above 59%, the cap would clamp it.
		observeThresholdPercent: 50,

		// Observation planner starts from roughly the oldest 25% slice of the raw
		// backlog when choosing what to observe next.
		// At a 272k window: 25% = 68,000 tokens worth of oldest raw history.
		oldestScopePercent: 5,
	},

	observations: {
		// Reflection trigger for the `reobserve` strategy. Once total observation
		// tokens reach this threshold, OM becomes eligible to compact them into a
		// smaller representation (subject to checkpoint cadence gates).
		// At a 272k window: 15% = 40,800 tokens.
		reobserveThresholdPercent: 12,

		// During reobserve compaction, focus first on the oldest 25% slice of the
		// observation backlog.
		// At a 272k window: 25% = 68,000 tokens worth of oldest observations.
		oldestScopePercent: 6,
	},

	reflections: {
		// Refresh trigger for already-compacted reflections. If reflections
		// themselves grow too large, OM can re-compact them again.
		// At a 272k window: 10% = 27,200 tokens.
		reobserveThresholdPercent: 10,

		// Persist older reflections into MEMORY.md when appropriate so durable
		// memory survives beyond the current session file.
		archiveOldToMemoryMd: true,

		// Archive only once active reflection text grows past this threshold.
		// Placeholders do not count toward this total.
		archiveThresholdPercent: 10,

		// Keep only a tiny rolling budget of archive placeholders in prompt-
		// visible memory. Full detail remains in MEMORY.md.
		archivePlaceholderTokenBudget: 256,

		// Relative path where archived reflection memory is written.
		memoryMdPath: "MEMORY.md",
	},

	experiences: {
		// Generate/update experience-bank candidates from observations.
		enabled: true,

		// Experiences are derived only after observation runs, not directly from
		// raw chat turns or reflection runs.
		generateAfter: "observations",

		// Allow up to 4 add/modify/merge operations per observation-derived pass.
		maxOpsPerObservation: 4,

		// Cap each generated experience at about 64 words so it stays short,
		// reusable, and prompt-friendly.
		maxWords: 64,

		// If two experiences are at least 70% similar, OM may merge them rather
		// than keep near-duplicate records.
		mergeSimilarityThreshold: 0.7,
	},
};

export interface ObservationStateMeta {
	schemaVersion: number;
	workspaceId: string;
	sessionId: string;
	modelId: string;
	contextWindow: number;
	systemPromptHash: string;
	createdAt: string;
	updatedAt: string;
}

export interface OmObservationItem {
	id: string;
	text: string;
	tokenCount: number;
	createdAt: string;
	source: {
		messageStartIndex: number;
		messageEndIndex: number;
		entryIds?: string[];
	};
}

export interface OmReflectionItem {
	id: string;
	text: string;
	tokenCount: number;
	createdAt: string;
	generation: number;
	sourceObservationIds?: string[];
	refreshedFromReflectionIds?: string[];
	archivedToMemoryMdHash?: string;
	archivedToMemoryMdPath?: string;
	placeholder?: boolean;
}

export interface OmExperienceItem {
	id: string;
	text: string;
	createdAt: string;
	updatedAt: string;
	sourceObservationIds: string[];
	sourceRawMessageRange?: {
		messageStartIndex: number;
		messageEndIndex: number;
	};
	mergedFrom?: string[];
	modifiedFrom?: string;
	score?: number;
	retrievedCount?: number;
	appliedCount?: number;
	helpedCount?: number;
	hurtCount?: number;
	ignoredCount?: number;
}

export type OmExperienceOp =
	| { option: "add"; experience: string }
	| { option: "modify"; modifiedFrom: string; experience: string }
	| { option: "merge"; mergedFrom: string[]; experience: string };

export interface ObservationState {
	schemaVersion: number;
	rawMessageCursor: number;
	observations: OmObservationItem[];
	reflections: OmReflectionItem[];
	experiences: OmExperienceItem[];
	generationCount: number;
	lastObservedTimestamp: string;
	lastReflectionTimestamp?: string;
	lastReflectionRefreshTimestamp?: string;
	totalObservationTokens: number;
	totalReflectionTokens: number;
	totalExperienceTokens: number;
	meta?: ObservationStateMeta;
	// legacy compatibility fields still persisted for older runtime paths
	activeObservations: string;
	compactedObservations: string;
	lastObservedMessageIndex: number;
	totalCompactedTokens: number;
}

export type SerializedObservationState = Record<string, unknown>;

export interface ObservationStateEntry {
	version: 1;
	eventType: "observation" | "reflection" | "reflection_refresh" | "manual_reset";
	state: SerializedObservationState;
	timestamp: string;
}

export interface ObservationDiagnosticEntry {
	version: 1;
	level: "info" | "warning" | "error";
	phase:
		| "session_start"
		| "observe"
		| "observe_retry"
		| "observe_success"
		| "reflect"
		| "reflect_retry"
		| "reflect_success"
		| "reflect_refresh"
		| "footer"
		| "session_before_compact"
		| "manual_reset"
		| "session_shutdown"
		| "rollover"
		| "recovery"
		| "experience";
	message: string;
	timestamp: string;
	details?: Record<string, unknown>;
}

export interface ArchiveChunkManifest {
	path: string;
	entryCount: number;
	approxBytes: number;
	entryIdStart?: string;
	entryIdEnd?: string;
}

export interface SessionRolloverEntry {
	version: 1;
	token: string;
	reason: string;
	createdAt: string;
	sourceSessionPath: string;
	targetSessionPath: string;
	sessionName: string;
	coveredEntryIds: string[];
	trimmedEntryIds: string[];
	archiveChunks: ArchiveChunkManifest[];
	cleanupOriginalSessionPath?: string;
}

export interface PendingSessionSwitchRecord {
	version: 1;
	token: string;
	createdAt: string;
	reason: string;
	sessionName: string;
	sourceSessionPath: string;
	targetSessionPath: string;
	coveredEntryIds: string[];
	trimmedEntryIds: string[];
	archiveChunks: ArchiveChunkManifest[];
	nextState?: ObservationState;
	cleanupOriginalSessionPath?: string;
}

export type ExperienceStatus = "candidate" | "active" | "merged" | "deprecated" | "trusted";
export type ExperienceRank = "never-used" | "low" | "medium" | "high" | "trusted";
export type ExperienceKind = "execution_tip" | "decision_rule";

export interface ExperienceRecord {
	id: string;
	kind: ExperienceKind;
	text: string;
	toolNames: string[];
	triggerPatterns: string[];
	status: ExperienceStatus;
	score: number;
	rank: ExperienceRank;
	retrievedCount: number;
	appliedCount: number;
	helpedCount: number;
	hurtCount: number;
	ignoredCount: number;
	createdAt: string;
	updatedAt: string;
	source: {
		sourceSessionName: string;
		sourceSessionPath?: string;
		entryIdStart?: string;
		entryIdEnd?: string;
		coveredEntryIds: string[];
	};
	supersedes: string[];
}

export interface ExperienceBankIndex {
	version: 1;
	nextId: number;
	items: Array<{ id: string; status: ExperienceStatus; score: number; rank: ExperienceRank }>;
}

export const CUSTOM_ENTRY_TYPE = "om:state";
export const DIAGNOSTIC_ENTRY_TYPE = "om:diagnostic";
export const ROLLOVER_ENTRY_TYPE = "om:rollover";
