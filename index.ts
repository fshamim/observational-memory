import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	ObservationState,
	ObservationStateEntry,
	ObservationDiagnosticEntry,
	PendingSessionSwitchRecord,
} from "./types";
import { ROLLOVER_ENTRY_TYPE } from "./types";
import { ensureProjectConfigFile, loadConfig } from "./config";
import { estimateStringTokens, estimateMessagesTokens } from "./token-estimator";
import { requireModelAuth, type RequestAuth, type CompatibleModelRegistry } from "./auth";
import {
	createInitialState,
	loadPersistedState,
	saveStateToFile,
	getStatePath,
	createDiagnosticEntry,
} from "./state";
import {
	getProjectOmDir,
	getPendingSwitchDir,
	getRawArchiveDir,
	getRecoveryReportPath,
	getDiagnosticLogPath,
	sanitizeSessionKey,
	writeJsonFileAtomic,
} from "./lib/om-paths";
import {
	buildHotSessionBundle,
	cleanupArchivedOriginalSource,
	createHotSessionPath,
	estimateArchiveableSavingsBytes,
	extractBranchMessageEntries,
} from "./lib/hot-session";
import { getMessageEntries, readSessionEntriesSync } from "./lib/session-jsonl";
import {
	createPendingSwitchToken,
	deletePendingSwitch,
	findPendingSwitchBySourceSessionPath,
	loadPendingSwitch,
	savePendingSwitch,
} from "./lib/pending-switch";
import { evaluateRolloverDecision } from "./lib/rollover-policy";
import {
	listExperienceRecords,
	registerExperienceOutcome,
	selectRelevantExperiences,
} from "./lib/experience-bank";
import {
	computeQueueTokenTotals,
	getObservationCursor,
	getObservationText,
	getReflectionText,
	getReflectionTokenTotal,
	hasObservationItems,
	hasReflectionItems,
	selectOldestRawMessageBatch,
} from "./memory-queues";
import {
	alignCursorToToolCallPairs as alignObservationCursorToToolPairs,
	computeContextPercent as computeObservationContextPercent,
	computeOmContextPressure,
	computeOmContextThresholds,
	planPendingObservationSlice,
	shouldArmObservation,
	shouldArmReflection,
	trimMessagesToTokenBudgetKeepingPairs,
	planForwardedContextSlice,
	type OmContextThresholds,
} from "./pipeline-planner";
import { buildObservationPromptSections as buildOmPromptSections, stripObservationPromptSuffix as stripOmPromptSuffix } from "./prompt-sections";
import { openOmReplayOverlay } from "./replay";
import type { ObservationalMemoryConfig } from "./types";
import {
	createCustomFooter,
	createFooterState,
	parseGitDiffShortstat,
	detectWorktree,
	type FooterState,
} from "./footer";
import { parseCodexQuotaStatusText } from "./codex-status-parser";
import { backoffDelayMs, describeAsyncError, isRetryableOmError, sleep } from "./async-utils";
import {
	computeObservationRearmDecision,
	executeObservationPlan,
	planObservationRun,
} from "./observation-pipeline";
import {
	executeReflectionPlan,
	planReflectionRun,
} from "./reflection-pipeline";
import {
	parseOmCompareArgs,
	runCompressionComparisonOnSession,
	writeComparisonReport,
} from "./compression-compare";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

/**
 * Load MCP server names from the cache file and convert to tool name prefixes.
 * pi-mcp-adapter names tools as `{serverName_with_dashes_to_underscores}_{toolName}`.
 * E.g., server "codebase-memory-mcp" → prefix "codebase_memory_mcp" → tool "codebase_memory_mcp_delete_project".
 */
function loadMcpServerPrefixes(): string[] {
	try {
		const cachePath = path.join(os.homedir(), ".pi", "agent", "mcp-cache.json");
		if (!fs.existsSync(cachePath)) return [];
		const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		if (!cache?.servers) return [];
		return Object.keys(cache.servers).map((name) => name.replace(/-/g, "_"));
	} catch {
		return [];
	}
}

/**
 * Count distinct MCP servers by matching tool names against known server prefixes.
 */
function countMcpServers(
	allTools: Array<{ name: string }>,
	mcpPrefixes: string[],
): number {
	const matchedServers = new Set<string>();
	for (const tool of allTools) {
		for (const prefix of mcpPrefixes) {
			if (tool.name.startsWith(prefix + "_")) {
				matchedServers.add(prefix);
				break;
			}
		}
	}
	return matchedServers.size;
}

function readGitDiffShortstatAsync(timeoutMs = 3000): Promise<{ added: number; removed: number } | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finalize = (value: { added: number; removed: number } | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		let output = "";
		let timedOut = false;
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("git", ["diff", "--shortstat"], {
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finalize(null);
			return;
		}

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				
			}
			finalize(null);
		}, timeoutMs);

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			output += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			if (output.length > 8192) {
				output = output.slice(-8192);
			}
		});

		proc.on("error", () => {
			clearTimeout(timer);
			finalize(null);
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return;
			if (code !== 0 && output.trim().length === 0) {
				finalize(null);
				return;
			}
			finalize(parseGitDiffShortstat(output));
		});
	});
}

function truncateInline(text: string, max = 120): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

function formatResetCountdown(resetAtMs: number): string {
	if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return "";
	const deltaMs = resetAtMs - Date.now();
	if (deltaMs <= 0) return "↺soon";

	const totalMinutes = Math.floor(deltaMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return `↺${days}d${hours}h`;
	if (hours > 0) return `↺${hours}h${minutes}m`;
	return `↺${minutes}m`;
}

function normalizeSessionLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.toLowerCase() === "untitled") return "";
	return trimmed;
}

function readSessionHeaderLabel(sessionFilePath: string): string {
	try {
		if (!sessionFilePath || !fs.existsSync(sessionFilePath)) return "";
		const fd = fs.openSync(sessionFilePath, "r");
		try {
			const buffer = Buffer.alloc(4096);
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
			if (bytesRead <= 0) return "";
			const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]?.trim();
			if (!firstLine) return "";
			const parsed = JSON.parse(firstLine);
			return (
				normalizeSessionLabel((parsed as any)?.title) ||
				normalizeSessionLabel((parsed as any)?.name) ||
				normalizeSessionLabel((parsed as any)?.sessionTitle) ||
				normalizeSessionLabel((parsed as any)?.sessionName) ||
				normalizeSessionLabel((parsed as any)?.label)
			);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

type CodexQuotaFooterSnapshot = {
	accountName: string;
	planType: string;
	remaining5hPercent: number | null;
	remaining7dPercent: number | null;
	reset5hAtMs: number | null;
	reset7dAtMs: number | null;
};

const EMERGENCY_OBSERVE_SCOPE_PERCENT = 30;
const CONTEXT_OVERFLOW_RECOVERY_WINDOW_MS = 2 * 60_000;

function readJsonFile(filePath: string): any | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function getByPaths(obj: any, paths: string[]): unknown {
	for (const pathExpr of paths) {
		let current: any = obj;
		let ok = true;
		for (const segment of pathExpr.split(".")) {
			if (!current || typeof current !== "object" || !(segment in current)) {
				ok = false;
				break;
			}
			current = current[segment];
		}
		if (ok) return current;
	}
	return undefined;
}

function normalizePercent(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const scaled = value >= 0 && value <= 1 ? value * 100 : value;
	return Math.max(0, Math.min(100, Math.round(scaled)));
}

function normalizeEpochMs(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

function pickRateLimitSnapshot(raw: any): any | null {
	if (!raw || typeof raw !== "object") return null;
	const byLimitId = raw.rateLimitsByLimitId || raw?.rateLimits?.rateLimitsByLimitId;
	if (byLimitId && typeof byLimitId === "object") {
		if (byLimitId.codex && typeof byLimitId.codex === "object") return byLimitId.codex;
		const first = Object.values(byLimitId).find((entry: any) => entry && typeof entry === "object");
		if (first) return first;
	}
	if (raw.rateLimits && typeof raw.rateLimits === "object") return raw.rateLimits;
	if (raw.snapshot?.rateLimits && typeof raw.snapshot.rateLimits === "object") return raw.snapshot.rateLimits;
	if (raw.accountRateLimits?.rateLimits && typeof raw.accountRateLimits.rateLimits === "object") {
		return raw.accountRateLimits.rateLimits;
	}
	return null;
}

function extractWindowInfo(window: any): { remainingPercent: number | null; resetAtMs: number | null; durationMins: number | null } {
	if (!window || typeof window !== "object") {
		return { remainingPercent: null, resetAtMs: null, durationMins: null };
	}
	const remainingDirect = normalizePercent((window as any).remainingPercent);
	const used = normalizePercent((window as any).usedPercent);
	const remainingPercent = remainingDirect ?? (used !== null ? Math.max(0, 100 - used) : null);
	const resetAtMs = normalizeEpochMs((window as any).resetsAt ?? (window as any).resetAt);
	const durationMins =
		typeof (window as any).windowDurationMins === "number" && Number.isFinite((window as any).windowDurationMins)
			? Math.round((window as any).windowDurationMins)
			: null;
	return { remainingPercent, resetAtMs, durationMins };
}

function loadCodexQuotaFooterSnapshot(codexProvider = "openai-codex"): CodexQuotaFooterSnapshot {
	const home = os.homedir();
	const snapshot: CodexQuotaFooterSnapshot = {
		accountName: "",
		planType: "",
		remaining5hPercent: null,
		remaining7dPercent: null,
		reset5hAtMs: null,
		reset7dAtMs: null,
	};

	// Resolve the active Codex account identity from Pi's own auth.json.
	// This is authoritative — it reflects exactly which account Pi is routing
	// Codex API calls through, regardless of any third-party extension state.
	try {
		const authJson = readJsonFile(path.join(home, ".pi", "agent", "auth.json")) as Record<string, any> | null;
		if (authJson && typeof authJson === "object") {
			const normalizedProvider = typeof codexProvider === "string" ? codexProvider.trim() : "";
			const fallbackKeys = isCodexProviderName(normalizedProvider)
				? []
				: Object.keys(authJson).filter((k) => k.startsWith("openai-codex") && k !== normalizedProvider);
			for (const key of [normalizedProvider, ...fallbackKeys]) {
				const entry = authJson[key];
				if (!entry?.access || typeof entry.access !== "string") continue;
				try {
					const parts = entry.access.split(".");
					if (parts.length < 2) continue;
					// Standard base64url → base64 decode of the JWT payload
					const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
					const payload = JSON.parse(
						Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf-8"),
					);
					const email = payload?.["https://api.openai.com/profile"]?.email;
					const planType = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
					if (typeof email === "string" && email.trim()) {
						snapshot.accountName = email.trim();
					}
					if (typeof planType === "string" && planType.trim()) {
						snapshot.planType = planType.trim();
					}
					if (snapshot.accountName) break;
				} catch {
					// Ignore JWT decode errors; try next entry
				}
			}
		}
	} catch {
		// Ignore auth.json read errors
	}

	const candidatePaths = [
		process.env.PI_CODEX_QUOTA_PATH,
		path.join(home, ".pi", "agent", "codex-rate-limits.json"),
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

	for (const filePath of candidatePaths) {
		const raw = readJsonFile(filePath);
		if (!raw || typeof raw !== "object") continue;

		if (!snapshot.accountName) {
			const accountName = getByPaths(raw, ["activeEmail", "account.email", "accountName", "email"]);
			if (typeof accountName === "string" && accountName.trim()) {
				snapshot.accountName = accountName.trim();
			}
		}

		if (!snapshot.planType) {
			const planType = getByPaths(raw, ["account.planType", "planType", "rateLimits.planType"]);
			if (typeof planType === "string" && planType.trim()) {
				snapshot.planType = planType.trim();
			}
		}

		const rateSnapshot = pickRateLimitSnapshot(raw);
		if (rateSnapshot) {
			const primary = extractWindowInfo((rateSnapshot as any).primary);
			const secondary = extractWindowInfo((rateSnapshot as any).secondary);
			const candidates = [primary, secondary].filter((w) => w.remainingPercent !== null || w.resetAtMs !== null);
			const fiveHour =
				candidates.find((w) => typeof w.durationMins === "number" && w.durationMins >= 240 && w.durationMins <= 360) ||
				primary;
			const sevenDay =
				candidates.find((w) => typeof w.durationMins === "number" && w.durationMins >= 9000 && w.durationMins <= 11000) ||
				secondary;

			if (snapshot.remaining5hPercent === null && fiveHour.remainingPercent !== null) {
				snapshot.remaining5hPercent = fiveHour.remainingPercent;
			}
			if (snapshot.remaining7dPercent === null && sevenDay.remainingPercent !== null) {
				snapshot.remaining7dPercent = sevenDay.remainingPercent;
			}
			if (!snapshot.reset5hAtMs && fiveHour.resetAtMs) {
				snapshot.reset5hAtMs = fiveHour.resetAtMs;
			}
			if (!snapshot.reset7dAtMs && sevenDay.resetAtMs) {
				snapshot.reset7dAtMs = sevenDay.resetAtMs;
			}
		}

		if (snapshot.remaining5hPercent === null) {
			const rem5 = normalizePercent(
				getByPaths(raw, [
					"remaining5hPercent",
					"fiveHourRemainingPercent",
					"window5h.remainingPercent",
					"limits.window5h.remainingPercent",
				]),
			);
			if (rem5 !== null) snapshot.remaining5hPercent = rem5;
		}

		if (snapshot.remaining7dPercent === null) {
			const rem7 = normalizePercent(
				getByPaths(raw, [
					"remaining7dPercent",
					"sevenDayRemainingPercent",
					"window7d.remainingPercent",
					"limits.window7d.remainingPercent",
				]),
			);
			if (rem7 !== null) snapshot.remaining7dPercent = rem7;
		}

		if (!snapshot.reset5hAtMs) {
			snapshot.reset5hAtMs = normalizeEpochMs(
				getByPaths(raw, [
					"window5h.resetsAt",
					"fiveHourResetAt",
					"reset5hAtMs",
					"rateLimits.primary.resetsAt",
				]),
			);
		}

		if (!snapshot.reset7dAtMs) {
			snapshot.reset7dAtMs = normalizeEpochMs(
				getByPaths(raw, [
					"window7d.resetsAt",
					"sevenDayResetAt",
					"reset7dAtMs",
					"resetAtMs",
					"resetAt",
					"rateLimits.secondary.resetsAt",
				]),
			);
		}

		if (
			snapshot.accountName &&
			(snapshot.remaining5hPercent !== null || snapshot.remaining7dPercent !== null)
		) {
			break;
		}
	}

	return snapshot;
}

function createEmptyCodexQuotaSnapshot(): CodexQuotaFooterSnapshot {
	return {
		accountName: "",
		planType: "",
		remaining5hPercent: null,
		remaining7dPercent: null,
		reset5hAtMs: null,
		reset7dAtMs: null,
	};
}

function normalizeAccountKey(accountName: string): string {
	return accountName.trim().toLowerCase();
}

function isCodexProviderName(provider: string): boolean {
	const normalized = provider.trim().toLowerCase();
	return /^openai-codex(?:-\d+)?$/.test(normalized);
}

function mergeCodexSnapshots(
	base: CodexQuotaFooterSnapshot,
	patch?: Partial<CodexQuotaFooterSnapshot> | null,
): CodexQuotaFooterSnapshot {
	if (!patch) return base;
	return {
		accountName: patch.accountName || base.accountName,
		planType: patch.planType || base.planType,
		remaining5hPercent: patch.remaining5hPercent ?? base.remaining5hPercent,
		remaining7dPercent: patch.remaining7dPercent ?? base.remaining7dPercent,
		reset5hAtMs: patch.reset5hAtMs ?? base.reset5hAtMs,
		reset7dAtMs: patch.reset7dAtMs ?? base.reset7dAtMs,
	};
}

function hasCodexUsage(snapshot?: Partial<CodexQuotaFooterSnapshot> | null): boolean {
	if (!snapshot) return false;
	return (
		typeof snapshot.remaining5hPercent === "number" ||
		typeof snapshot.remaining7dPercent === "number"
	);
}

function parseCodexSnapshotFromUnknown(raw: any): Partial<CodexQuotaFooterSnapshot> | null {
	if (!raw || typeof raw !== "object") return null;
	const patch: Partial<CodexQuotaFooterSnapshot> = {};

	const accountName = getByPaths(raw, ["activeEmail", "account.email", "accountName", "email"]);
	if (typeof accountName === "string" && accountName.trim()) {
		patch.accountName = accountName.trim();
	}

	const planType = getByPaths(raw, ["account.planType", "planType", "rateLimits.planType"]);
	if (typeof planType === "string" && planType.trim()) {
		patch.planType = planType.trim();
	}

	const rateSnapshot = pickRateLimitSnapshot(raw);
	if (rateSnapshot) {
		const primary = extractWindowInfo((rateSnapshot as any).primary);
		const secondary = extractWindowInfo((rateSnapshot as any).secondary);
		const windows = [primary, secondary].filter((w) => w.remainingPercent !== null || w.resetAtMs !== null);
		const fiveHour =
			windows.find((w) => typeof w.durationMins === "number" && w.durationMins >= 240 && w.durationMins <= 360) ||
			primary;
		const sevenDay =
			windows.find((w) => typeof w.durationMins === "number" && w.durationMins >= 9000 && w.durationMins <= 11000) ||
			secondary;
		patch.remaining5hPercent = fiveHour.remainingPercent;
		patch.remaining7dPercent = sevenDay.remainingPercent;
		patch.reset5hAtMs = fiveHour.resetAtMs;
		patch.reset7dAtMs = sevenDay.resetAtMs;
	}

	if (typeof patch.remaining5hPercent !== "number") {
		patch.remaining5hPercent = normalizePercent(getByPaths(raw, [
			"remaining5hPercent",
			"fiveHourRemainingPercent",
			"window5h.remainingPercent",
			"limits.window5h.remainingPercent",
		]));
	}
	if (typeof patch.remaining7dPercent !== "number") {
		patch.remaining7dPercent = normalizePercent(getByPaths(raw, [
			"remaining7dPercent",
			"sevenDayRemainingPercent",
			"window7d.remainingPercent",
			"limits.window7d.remainingPercent",
		]));
	}

	if (typeof patch.reset5hAtMs !== "number") {
		patch.reset5hAtMs = normalizeEpochMs(getByPaths(raw, [
			"window5h.resetsAt",
			"fiveHourResetAt",
			"reset5hAtMs",
			"rateLimits.primary.resetsAt",
		]));
	}
	if (typeof patch.reset7dAtMs !== "number") {
		patch.reset7dAtMs = normalizeEpochMs(getByPaths(raw, [
			"window7d.resetsAt",
			"sevenDayResetAt",
			"reset7dAtMs",
			"resetAtMs",
			"resetAt",
			"rateLimits.secondary.resetsAt",
		]));
	}

	const hasAny =
		Boolean(patch.accountName) ||
		typeof patch.remaining5hPercent === "number" ||
		typeof patch.remaining7dPercent === "number" ||
		typeof patch.reset5hAtMs === "number" ||
		typeof patch.reset7dAtMs === "number";
	return hasAny ? patch : null;
}

const FOOTER_DATA_QUOTA_METHODS = [
	"getUsage",
	"getUsageInfo",
	"getUsageStats",
	"getRateLimits",
	"getQuota",
	"getQuotaInfo",
	"getCodexUsage",
	"getCodexQuota",
	"getAccountUsage",
	"getAccountRateLimits",
	"getProviderUsage",
	"getModelUsage",
	"getFooterUsage",
];

function mergeParsedQuotaPayloads(payloads: any[]): Partial<CodexQuotaFooterSnapshot> | null {
	let best: Partial<CodexQuotaFooterSnapshot> | null = null;
	for (const payload of payloads) {
		const parsed = parseCodexSnapshotFromUnknown(payload);
		if (!parsed) continue;
		if (!best) {
			best = parsed;
			continue;
		}
		const mergedBest = mergeCodexSnapshots(createEmptyCodexQuotaSnapshot(), best);
		best = mergeCodexSnapshots(mergedBest, parsed);
	}
	return best;
}

function buildFooterDataArgCandidates(providerHint: string, modelHint: string): any[][] {
	const provider = providerHint.trim();
	const model = modelHint.trim();
	const candidates: any[][] = [
		[],
		provider ? [provider] : [],
		model ? [model] : [],
		(provider && model) ? [provider, model] : [],
		provider ? [{ provider }] : [],
		model ? [{ model, modelId: model }] : [],
		(provider || model) ? [{ provider, model, modelId: model }] : [],
	];

	const unique: any[][] = [];
	const seen = new Set<string>();
	for (const args of candidates) {
		if (!args) continue;
		const key = JSON.stringify(args);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(args);
	}
	return unique;
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs = 1500): Promise<T | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(undefined);
		}, timeoutMs);
		promise
			.then((value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			})
			.catch(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(undefined);
			});
	});
}

function extractCodexQuotaFromFooterData(
	footerData: any,
	providerHint = "",
	modelHint = "",
): { snapshot: Partial<CodexQuotaFooterSnapshot> | null; asyncPayloadPromises: Array<Promise<any>> } {
	if (!footerData || typeof footerData !== "object") {
		return { snapshot: null, asyncPayloadPromises: [] };
	}

	const payloads: any[] = [footerData];
	const asyncPayloadPromises: Array<Promise<any>> = [];
	const argCandidates = buildFooterDataArgCandidates(providerHint, modelHint);

	for (const methodName of FOOTER_DATA_QUOTA_METHODS) {
		const method = (footerData as any)?.[methodName];
		if (typeof method !== "function") continue;

		let capturedSync = false;
		let capturedAsync = false;
		for (const args of argCandidates) {
			let value: any;
			try {
				value = method.call(footerData, ...args);
			} catch {
				continue;
			}
			if (value && typeof (value as any).then === "function") {
				if (!capturedAsync) {
					asyncPayloadPromises.push(promiseWithTimeout(Promise.resolve(value)));
					capturedAsync = true;
				}
				continue;
			}
			if (typeof value !== "undefined" && value !== null) {
				payloads.push(value);
				capturedSync = true;
				break;
			}
		}
		if (capturedSync || capturedAsync) continue;
	}

	for (const key of ["usage", "quota", "rateLimits", "limits", "accountRateLimits", "state"]) {
		const nested = (footerData as any)?.[key];
		if (nested && typeof nested === "object") {
			payloads.push(nested);
		}
	}

	return {
		snapshot: mergeParsedQuotaPayloads(payloads),
		asyncPayloadPromises,
	};
}

function collectStringsDeep(value: unknown, sink: string[], depth = 0): void {
	if (depth > 4 || value == null) return;
	if (typeof value === "string") {
		sink.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectStringsDeep(entry, sink, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const entry of Object.values(value as Record<string, unknown>)) {
			collectStringsDeep(entry, sink, depth + 1);
		}
	}
}

function extractCodexQuotaFromExtensionStatuses(footerData: any): Partial<CodexQuotaFooterSnapshot> | null {
	const getter = footerData?.getExtensionStatuses;
	if (typeof getter !== "function") return null;
	let raw: unknown;
	try {
		raw = getter.call(footerData);
	} catch {
		return null;
	}
	const parts: string[] = [];
	collectStringsDeep(raw, parts);
	const joined = parts.join(" \n ");
	if (!joined.trim()) return null;

	const parsed = parseCodexQuotaStatusText(joined);
	if (parsed) {
		return parsed;
	}

	const stripped = stripAnsiCodes(joined).replace(/\s+/g, " ").trim();
	if (!stripped) return null;
	const patch: Partial<CodexQuotaFooterSnapshot> = {};
	const emailMatch = stripped.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
	if (emailMatch) {
		patch.accountName = emailMatch[0];
	}
	return patch.accountName ? patch : null;
}

function summarizeExtensionStatuses(footerData: any, maxLen = 160): string {
	const getter = footerData?.getExtensionStatuses;
	if (typeof getter !== "function") return "";
	try {
		const raw = getter.call(footerData);
		const parts: string[] = [];
		collectStringsDeep(raw, parts);
		const text = parts.join(" | ").replace(/\s+/g, " ").trim();
		if (!text) return "";
		return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
	} catch {
		return "";
	}
}

function stripAnsiCodes(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractConnectedMcpCountFromExtensionStatuses(footerData: any): number | null {
	const getter = footerData?.getExtensionStatuses;
	if (typeof getter !== "function") return null;

	let raw: unknown;
	try {
		raw = getter.call(footerData);
	} catch {
		return null;
	}

	const candidates: string[] = [];
	if (raw instanceof Map) {
		const mcpStatus = raw.get("mcp");
		if (typeof mcpStatus === "string" && mcpStatus.trim()) {
			candidates.push(mcpStatus);
		}
	}

	const parts: string[] = [];
	collectStringsDeep(raw, parts);
	for (const part of parts) {
		if (/\bmcp:/i.test(part)) {
			candidates.push(part);
		}
	}

	for (const candidate of candidates) {
		const text = stripAnsiCodes(candidate).replace(/\s+/g, " ").trim();
		if (!text || /^MCP:\s*connecting\b/i.test(text)) continue;

		const fractionMatch = text.match(/\bMCP:\s*(\d+)\s*\/\s*(\d+)\s*servers?\b/i);
		if (fractionMatch) {
			const connected = Number.parseInt(fractionMatch[1], 10);
			if (Number.isFinite(connected) && connected >= 0) {
				return connected;
			}
			continue;
		}

		const connectedMatch = text.match(/\bMCP:\s*(\d+)\s*servers?\s*connected\b/i);
		if (connectedMatch) {
			const connected = Number.parseInt(connectedMatch[1], 10);
			if (Number.isFinite(connected) && connected >= 0) {
				return connected;
			}
		}
	}

	return null;
}

// NOTE: Codex quota data prefers live footer status/method payloads when
// available, falls back to provider-scoped backend usage API probing, and uses
// file-based snapshots as the cold-start baseline.

type CodexProviderAuthIdentity = {
	accessToken: string;
	accountId?: string;
	accountName?: string;
	planType?: string;
};

function decodeCodexJwtIdentity(accessToken: string): { accountName?: string; planType?: string } {
	try {
		const parts = accessToken.split(".");
		if (parts.length < 2) return {};
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(
			Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf-8"),
		);
		const email = payload?.["https://api.openai.com/profile"]?.email;
		const planType = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
		return {
			accountName: typeof email === "string" && email.trim() ? email.trim() : undefined,
			planType: typeof planType === "string" && planType.trim() ? planType.trim() : undefined,
		};
	} catch {
		return {};
	}
}

function loadCodexProviderAuthIdentity(codexProvider = "openai-codex"): CodexProviderAuthIdentity | null {
	const authJson = readJsonFile(path.join(os.homedir(), ".pi", "agent", "auth.json")) as Record<string, any> | null;
	if (!authJson || typeof authJson !== "object") return null;

	const normalizedProvider = typeof codexProvider === "string" ? codexProvider.trim() : "";
	let resolvedProvider = normalizedProvider;
	if (!resolvedProvider || !authJson[resolvedProvider]) {
		const matches = Object.keys(authJson).filter((key) => key.startsWith("openai-codex"));
		if (matches.length === 1) {
			resolvedProvider = matches[0];
		}
	}
	const entry = authJson[resolvedProvider];
	if (!entry || typeof entry !== "object") return null;

	const accessToken = typeof entry.access === "string" && entry.access.trim() ? entry.access.trim() : "";
	if (!accessToken) return null;
	const accountIdRaw = entry.accountId ?? entry.account_id;
	const accountId = typeof accountIdRaw === "string" && accountIdRaw.trim() ? accountIdRaw.trim() : undefined;
	const identity = decodeCodexJwtIdentity(accessToken);
	return {
		accessToken,
		accountId,
		accountName: identity.accountName,
		planType: identity.planType,
	};
}

async function probeCodexQuotaViaBackendUsageApi(
	codexProvider = "openai-codex",
	timeoutMs = 6500,
): Promise<Partial<CodexQuotaFooterSnapshot> | null> {
	const identity = loadCodexProviderAuthIdentity(codexProvider);
	if (!identity?.accessToken) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${identity.accessToken}`,
			Accept: "application/json",
		};
		if (identity.accountId) {
			headers["ChatGPT-Account-Id"] = identity.accountId;
		}

		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) return null;

		const data = (await response.json()) as any;
		const primaryUsed = normalizePercent(data?.rate_limit?.primary_window?.used_percent);
		const secondaryUsed = normalizePercent(data?.rate_limit?.secondary_window?.used_percent);
		const primaryResetAt = normalizeEpochMs(data?.rate_limit?.primary_window?.reset_at);
		const secondaryResetAt = normalizeEpochMs(data?.rate_limit?.secondary_window?.reset_at);

		const patch: Partial<CodexQuotaFooterSnapshot> = {
			accountName: identity.accountName,
			planType: identity.planType,
		};
		if (typeof primaryUsed === "number") {
			patch.remaining5hPercent = Math.max(0, Math.min(100, Math.round(100 - primaryUsed)));
		}
		if (typeof secondaryUsed === "number") {
			patch.remaining7dPercent = Math.max(0, Math.min(100, Math.round(100 - secondaryUsed)));
		}
		if (typeof primaryResetAt === "number") {
			patch.reset5hAtMs = primaryResetAt;
		}
		if (typeof secondaryResetAt === "number") {
			patch.reset7dAtMs = secondaryResetAt;
		}
		if (!hasCodexUsage(patch)) return null;
		return patch;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export default function observationalMemoryExtension(pi: ExtensionAPI): void {
	const initialBootstrapResult = ensureProjectConfigFile();
	let pendingBootstrapNotice = initialBootstrapResult.updated
		? `Observational memory config was updated once to the new safe defaults.${initialBootstrapResult.backupPath ? ` Backup: ${initialBootstrapResult.backupPath}` : ""}`
		: initialBootstrapResult.error
			? `Observational memory config bootstrap failed: ${truncateInline(initialBootstrapResult.error, 160)}`
			: "";
	let config = loadConfig();
	if (!config.enabled) return;

	let state: ObservationState = createInitialState();
	let observerAuthGetter: (() => Promise<RequestAuth>) | null = null;
	let reflectorAuthGetter: (() => Promise<RequestAuth>) | null = null;
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const footerState: FooterState = createFooterState();

	// The context hook sees the FULL session messages (from buildSessionContext).
	// The agent_end/turn_end hooks only see messages from the current turn.
	let lastFullMessageCount = 0;
	let lastFullMessages: AgentMessage[] = [];
	let lastUnobservedMessages: AgentMessage[] = [];
	let lastUnobservedTokens = 0;
	let lastForwardedUnobservedMessageTokens = 0;
	let lastContextPercent: number | null = null;
	let lastRuntimeContextPercent: number | null = null;
	let lastEstimatedContextPercent: number | null = null;
	let lastObservationBatchMessages: AgentMessage[] = [];
	let lastObservationBatchTokens = 0;
	let lastObservationBatchStartIndex = 0;
	let lastObservationBatchEndIndex = 0;
	type ContextWindowSource = "model" | "usage" | "config-fallback";
	let activeContextWindow = config.contextWindowSize;
	let contextWindowSource: ContextWindowSource = "config-fallback";
	let observationInFlight: Promise<boolean> | null = null;
	let reflectionInFlight = false;
	let reflectionRunInFlight: Promise<boolean> | null = null;
	let lastOmError: string | null = null;
	let lastOmErrorAt = "";
	let lastOmErrorPhase = "";
	let forceObservationOnNextTurn = false;
	let forceReflectionOnNextTurn = false;
	let observationAttemptState: { attempt: number; maxAttempts: number } | null = null;
	let reflectionAttemptState: { attempt: number; maxAttempts: number } | null = null;
	let currentCtx: any | null = null;
	let footerRequestRender: (() => void) | null = null;
	let footerRenderTimer: ReturnType<typeof setTimeout> | null = null;
	let footerRenderQueued = false;
	let footerLastRenderAt = 0;
	let footerLastRenderKey = "";
	let footerBranchName = "";
	let footerDataProviderRef: any | null = null;
	let footerDataMethodNames = "";
	let activeProviderName = "";
	let lastFooterStatusText: string | undefined = undefined;
	let cachedSessionFilePath = "";
	let cachedSessionLabel = "";
	let shuttingDown = false;
	let lastUiErrorNotificationAt = 0;
	let codexQuotaProbeInFlight: Promise<void> | null = null;
	let codexQuotaLastSource = "";
	let codexQuotaCachedSnapshot: CodexQuotaFooterSnapshot | null = null;
	let footerUsagePollTimer: ReturnType<typeof setInterval> | null = null;
	let cachedThinkingLength = "";
	let cachedDefaultProvider = "";
	let contextOverflowRecoveryPending = false;
	let contextOverflowLastError = "";
	let contextOverflowLastAt = 0;
	let lastObservationPromptSuffix = "";
	let lastBranchEntries: any[] = [];
	let lastBranchMessageEntries: any[] = [];
	let sessionRolloverInFlight = false;
	let pendingSessionSwitchToken: string | null = null;
	let lastPendingSwitchRefreshBytes = 0;
	let lastSessionFileSizeBytes = 0;
	let lastProjectedHotSessionBytes = 0;
	let lastRolloverReason = "";
	let completedTurnCount = 0;
	let lastReflectionCheckpointTurn = 0;
	let lastReflectionCheckpointAtMs = 0;
	let currentActivityStatus = "";
	let pendingExperienceContext: {
		injected: Array<{ id: string; toolNames: string[] }>;
		appliedIds: Set<string>;
		sawAssistantError: boolean;
	} | null = null;
	const backgroundControllers = new Set<AbortController>();

	function ensureProjectConfigBootstrap(cwd?: string): void {
		const result = ensureProjectConfigFile(cwd || process.cwd());
		if (result.error) {
			pendingBootstrapNotice = `Observational memory config bootstrap failed: ${truncateInline(result.error, 160)}`;
		}
		if (result.updated) {
			const backupDetail = result.backupPath ? ` Backup: ${result.backupPath}` : "";
			pendingBootstrapNotice = `Observational memory config was updated once to the new safe defaults.${backupDetail}`;
		}
		if (pendingBootstrapNotice) {
			notifyOm(pendingBootstrapNotice, "warning", true);
			pendingBootstrapNotice = "";
		}
	}

	function reloadRuntimeConfig(cwd?: string): void {
		config = loadConfig(cwd || process.cwd());
	}

	function resolveSessionLabel(ctx: any): string {
		const directCandidates = [
			ctx?.session?.title,
			ctx?.session?.name,
			ctx?.sessionTitle,
			ctx?.sessionName,
			ctx?.sessionManager?.getSessionTitle?.(),
			ctx?.sessionManager?.getSessionName?.(),
		];
		for (const candidate of directCandidates) {
			const normalized = normalizeSessionLabel(candidate);
			if (normalized) return normalized;
		}

		const sessionFilePath = ctx?.sessionManager?.getSessionFile?.();
		if (typeof sessionFilePath === "string" && sessionFilePath.trim()) {
			const normalizedPath = sessionFilePath.trim();
			if (normalizedPath !== cachedSessionFilePath) {
				cachedSessionFilePath = normalizedPath;
				cachedSessionLabel = readSessionHeaderLabel(normalizedPath);
			}
			if (cachedSessionLabel) return cachedSessionLabel;
		}

		return "";
	}

	function syncSessionLabel(ctx: any): void {
		const nextLabel = resolveSessionLabel(ctx);
		if (nextLabel !== footerState.sessionLabel) {
			footerState.sessionLabel = nextLabel;
			requestFooterRender();
		}
	}

	function rememberContext(ctx: any): void {
		if (!ctx) return;
		currentCtx = ctx;
		syncSessionLabel(ctx);
		try {
			lastBranchEntries = typeof ctx?.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() || [] : [];
			lastBranchMessageEntries = extractBranchMessageEntries(lastBranchEntries);
		} catch {
			lastBranchEntries = [];
			lastBranchMessageEntries = [];
		}
	}

	function getRelevantExperiences() {
		if (!config.experienceBank.enabled || config.experienceBank.maxInjectedExperiences <= 0) {
			pendingExperienceContext = null;
			return [];
		}

		const recentMessages = lastUnobservedMessages.length > 0
			? lastUnobservedMessages.slice(-12)
			: lastBranchMessageEntries.slice(-12).map((entry: any) => entry.message as AgentMessage);
		const text = recentMessages
			.map((message: any) => {
				if (typeof message?.content === "string") return message.content;
				if (Array.isArray(message?.content)) {
					return message.content
						.map((part: any) => (part?.type === "text" ? String(part.text || "") : part?.type === "toolCall" ? String(part.name || "") : ""))
						.filter(Boolean)
						.join("\n");
				}
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
		const toolHints = Array.from(
			new Set(
				recentMessages.flatMap((message: any) => {
					const names: string[] = [];
					if (Array.isArray(message?.content)) {
						for (const part of message.content) {
							if (part?.type === "toolCall" && typeof part.name === "string" && part.name.trim()) {
								names.push(part.name.trim().toLowerCase());
							}
						}
					}
					if (message?.role === "toolResult" && typeof (message as any)?.toolName === "string") {
						names.push(String((message as any).toolName).trim().toLowerCase());
					}
					return names;
				}),
			),
		);
		const selected = selectRelevantExperiences({
			cwd: process.cwd(),
			text,
			toolHints,
			config: config.experienceBank,
		});
		pendingExperienceContext = selected.length > 0
			? {
				injected: selected.map((record) => ({ id: record.id, toolNames: [...record.toolNames] })),
				appliedIds: new Set<string>(),
				sawAssistantError: false,
			}
			: null;
		return selected;
	}

	function buildObservationPromptSections(): string[] {
		return buildOmPromptSections({
			state,
			config,
			experiences: getRelevantExperiences(),
		});
	}

	function buildObservationPromptSuffix(): string {
		const sections = buildObservationPromptSections();
		return sections.length > 0 ? `\n\n${sections.join("\n")}` : "";
	}

	function stripObservationPromptSuffix(systemPrompt: string): string {
		if (!systemPrompt) return systemPrompt;
		if (lastObservationPromptSuffix) {
			if (systemPrompt.endsWith(lastObservationPromptSuffix)) {
				return systemPrompt.slice(0, systemPrompt.length - lastObservationPromptSuffix.length);
			}
			const suffixIndex = systemPrompt.lastIndexOf(lastObservationPromptSuffix);
			if (suffixIndex >= 0) {
				return systemPrompt.slice(0, suffixIndex) + systemPrompt.slice(suffixIndex + lastObservationPromptSuffix.length);
			}
		}
		return stripOmPromptSuffix(systemPrompt);
	}

	function syncSystemPromptTokenEstimate(ctx?: any, explicitBaseSystemPrompt?: string): void {
		const basePrompt =
			typeof explicitBaseSystemPrompt === "string"
				? explicitBaseSystemPrompt
				: typeof ctx?.getSystemPrompt === "function"
					? stripObservationPromptSuffix(String(ctx.getSystemPrompt() || ""))
					: "";
		const nextTokens = estimateStringTokens(basePrompt || "");
		if (footerState.systemPromptTokens !== nextTokens) {
			footerState.systemPromptTokens = nextTokens;
			requestFooterRender();
		}
	}

	function syncRawMessageTokenEstimate(messages: AgentMessage[] | number): void {
		const nextTokens = typeof messages === "number"
			? Math.max(0, Math.floor(messages))
			: estimateMessagesTokens(Array.isArray(messages) ? messages : []);
		if (footerState.rawMessageTokens !== nextTokens) {
			footerState.rawMessageTokens = nextTokens;
			requestFooterRender();
		}
	}

	function setTransientActivityStatus(text: string): void {
		if (currentActivityStatus === text) return;
		currentActivityStatus = text;
		updateOmUi();
	}

	function clearTransientActivityStatus(): void {
		if (!currentActivityStatus) return;
		currentActivityStatus = "";
		updateOmUi();
	}

	function resolveLatestPendingSwitchToken(ctx: any, explicitToken?: string): string | null {
		const direct = String(explicitToken || "").trim();
		if (direct) return direct;
		if (pendingSessionSwitchToken) return pendingSessionSwitchToken;
		const entries = ctx?.sessionManager?.getEntries?.() || [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry?.type === "custom" && entry?.customType === ROLLOVER_ENTRY_TYPE && entry?.data?.token) {
				return String(entry.data.token);
			}
		}
		const currentSessionFile = String(ctx?.sessionManager?.getSessionFile?.() || "");
		const discovered = findPendingSwitchBySourceSessionPath(currentSessionFile, process.cwd());
		if (discovered?.token) {
			pendingSessionSwitchToken = String(discovered.token);
			return pendingSessionSwitchToken;
		}
		return null;
	}

	function resolvePendingSwitchRecord(ctx: any, explicitToken?: string): { token: string; pending: any } | null {
		const token = resolveLatestPendingSwitchToken(ctx, explicitToken);
		if (!token) return null;
		const pending = loadPendingSwitch(token, process.cwd());
		if (!pending) return null;
		return { token, pending };
	}

	function showPendingSwitchHint(ctx: any, pending: { token: string; pending: any }, source: string): void {
		pendingSessionSwitchToken = pending.token;
		setTransientActivityStatus(styleStatus("warning", "⟳ OM switch ready · /om switch"));
		appendDiagnostic("info", "rollover", "Pending OM hot-session switch is ready", {
			source,
			token: pending.token,
			targetSessionPath: pending.pending?.targetSessionPath,
		});
		notifyOm(
			`OM prepared a compact hot session for this session. Run /om switch to continue in ${path.basename(String(pending.pending?.targetSessionPath || "the hot session"))}.`,
			"warning",
			true,
		);
	}

	function refreshPendingHotSession(
		ctx: any,
		pending: PendingSessionSwitchRecord,
		reason: string,
		force = false,
	): PendingSessionSwitchRecord | null {
		const sourceSessionPath = String(pending?.sourceSessionPath || "");
		const targetSessionPath = String(pending?.targetSessionPath || "");
		const token = String(pending?.token || "");
		if (!sourceSessionPath || !targetSessionPath || !token || !fs.existsSync(sourceSessionPath)) return null;

		const currentSessionFile = String(ctx?.sessionManager?.getSessionFile?.() || "");
		if (currentSessionFile && path.resolve(currentSessionFile) !== path.resolve(sourceSessionPath)) return null;

		const currentBytes = fs.statSync(sourceSessionPath).size;
		if (!force && currentBytes === lastPendingSwitchRefreshBytes && fs.existsSync(targetSessionPath)) return null;

		let allEntries = ctx?.sessionManager?.getEntries?.() || [];
		if (allEntries.length === 0) {
			allEntries = readSessionEntriesSync(sourceSessionPath);
		}
		let branchEntries = lastBranchEntries.length > 0 ? lastBranchEntries : ctx?.sessionManager?.getBranch?.() || [];
		if (branchEntries.length === 0 && allEntries.length > 0) {
			branchEntries = allEntries.filter((entry: any) => entry?.type !== "session");
		}
		const branchMessageEntries = extractBranchMessageEntries(branchEntries);
		if (branchMessageEntries.length === 0) return null;

		const messageModels = branchMessageEntries.map((entry: any) => entry.message as AgentMessage);
		const safeMessageStartIndex = alignCursorToToolCallPairs(
			messageModels,
			Math.min(getObservationCursor(state), branchMessageEntries.length),
		);
		const sessionName = pending.sessionName ||
			resolveSessionLabel(ctx) ||
			sanitizeSessionKey(path.basename(sourceSessionPath, path.extname(sourceSessionPath)));
		const rolloverReason = pending.reason || reason;
		const bundle = buildHotSessionBundle({
			cwd: process.cwd(),
			sessionName,
			token,
			reason: rolloverReason,
			sourceSessionPath,
			targetHotSessionPath: targetSessionPath,
			allEntries,
			branchEntries,
			branchMessageEntries,
			safeMessageStartIndex,
			state,
			config,
		});
		savePendingSwitch(bundle.pendingRecord, process.cwd());
		pendingSessionSwitchToken = token;
		lastPendingSwitchRefreshBytes = currentBytes;
		lastSessionFileSizeBytes = currentBytes;
		lastProjectedHotSessionBytes = bundle.projectedHotBytes;
		lastRolloverReason = rolloverReason;
		writeJsonFileAtomic(getRecoveryReportPath(sessionName, process.cwd()), {
			type: "rollover",
			createdAt: new Date().toISOString(),
			sourceSessionPath,
			targetHotSessionPath: targetSessionPath,
			currentBytes,
			projectedHotBytes: bundle.projectedHotBytes,
			coveredEntryIds: bundle.coveredEntryIds,
			trimmedEntryIds: bundle.trimmedEntryIds,
			archiveChunks: bundle.archiveChunks,
			reason: rolloverReason,
		});
		appendDiagnostic("info", "rollover", "Refreshed pending OM hot-session rollover", {
			token,
			reason,
			sessionName,
			currentBytes,
			projectedHotBytes: bundle.projectedHotBytes,
			coveredEntries: bundle.coveredEntryIds.length,
			trimmedEntries: bundle.trimmedEntryIds.length,
			targetHotSessionPath: targetSessionPath,
		});
		return bundle.pendingRecord;
	}

	async function runPendingSessionSwitch(ctx: any, explicitToken?: string): Promise<boolean> {
		const resolved = resolvePendingSwitchRecord(ctx, explicitToken);
		const requestedToken = resolveLatestPendingSwitchToken(ctx, explicitToken) || String(explicitToken || "").trim();
		if (!resolved) {
			const detail = requestedToken
				? `No pending OM session switch token found for ${requestedToken}.`
				: "No pending OM hot-session switch is ready. Run /om rollover first if needed.";
			await ctx.ui.notify(detail, "warning");
			return false;
		}
		const { token } = resolved;
		let pending = resolved.pending as PendingSessionSwitchRecord;
		setTransientActivityStatus(styleStatus("warning", "⟳ OM switching session"));
		const previousState = state;
		try {
			await ctx.waitForIdle();
			pending = refreshPendingHotSession(ctx, pending, "switch", true) || pending;
			if (!fs.existsSync(pending.targetSessionPath)) {
				await ctx.ui.notify(`Target hot session is missing: ${pending.targetSessionPath}`, "error");
				clearTransientActivityStatus();
				return false;
			}
			const hasNextState = Boolean(pending?.nextState && typeof pending.nextState === "object");
			if (hasNextState) {
				saveStateToFile(getStatePath(), pending.nextState as ObservationState);
			}
			const result = await ctx.switchSession(pending.targetSessionPath);
			if (result?.cancelled) {
				if (hasNextState) {
					saveStateToFile(getStatePath(), previousState);
				}
				appendDiagnostic("warning", "rollover", "OM session switch was cancelled", {
					token,
					targetSessionPath: pending.targetSessionPath,
				});
				clearTransientActivityStatus();
				await ctx.ui.notify("OM session switch was cancelled.", "warning");
				return false;
			}
			return true;
		} catch (error) {
			if (pending?.nextState && typeof pending.nextState === "object") {
				saveStateToFile(getStatePath(), previousState);
			}
			setOmError(describeAsyncError(error), "rollover", { notify: true });
			appendDiagnostic("error", "rollover", "OM session switch command failed", {
				token,
				targetSessionPath: pending.targetSessionPath,
				error: describeAsyncError(error),
			});
			clearTransientActivityStatus();
			return false;
		}
	}

	function finalizePendingSessionArchive(ctx: any): void {
		const currentSessionFile = String(ctx?.sessionManager?.getSessionFile?.() || "");
		if (!currentSessionFile) return;
		const entries = ctx?.sessionManager?.getEntries?.() || [];
		const latestRollover = [...entries].reverse().find((entry: any) => entry?.customType === ROLLOVER_ENTRY_TYPE)?.data;
		if (!latestRollover?.token) return;
		const pending = loadPendingSwitch(String(latestRollover.token), process.cwd());
		if (!pending) return;
		if (path.resolve(String(pending.targetSessionPath || "")) !== path.resolve(currentSessionFile)) return;

		try {
			let archivedOriginalPath: string | undefined;
			if (
				pending.cleanupOriginalSessionPath &&
				path.resolve(pending.cleanupOriginalSessionPath) !== path.resolve(currentSessionFile) &&
				fs.existsSync(pending.cleanupOriginalSessionPath)
			) {
				archivedOriginalPath = cleanupArchivedOriginalSource(
					pending.cleanupOriginalSessionPath,
					pending.sessionName,
					process.cwd(),
				);
			}
			deletePendingSwitch(String(pending.token), process.cwd());
			pendingSessionSwitchToken = null;
			appendDiagnostic("info", "rollover", "Finalized OM session rollover cleanup", {
				token: pending.token,
				currentSessionFile,
				archivedOriginalPath,
			});
		} catch (error) {
			appendDiagnostic("warning", "rollover", "Failed to finalize OM session rollover cleanup", {
				token: pending.token,
				currentSessionFile,
				error: describeAsyncError(error),
			});
		}
	}

	function refreshSessionFileMetrics(ctx: any): void {
		const sessionFilePath = String(ctx?.sessionManager?.getSessionFile?.() || "");
		if (!sessionFilePath || !fs.existsSync(sessionFilePath)) {
			lastSessionFileSizeBytes = 0;
			return;
		}
		try {
			lastSessionFileSizeBytes = fs.statSync(sessionFilePath).size;
		} catch {
			lastSessionFileSizeBytes = 0;
		}
	}

	async function maybeStageSessionRollover(ctx: any, reason: string, force = false): Promise<void> {
		rememberContext(ctx);
		if (!config.sessionRollover.enabled || shuttingDown || sessionRolloverInFlight || pendingSessionSwitchToken) {
			return;
		}
		const sessionFilePath = String(ctx?.sessionManager?.getSessionFile?.() || "");
		if (!sessionFilePath || !fs.existsSync(sessionFilePath)) return;

		refreshSessionFileMetrics(ctx);
		const currentBytes = lastSessionFileSizeBytes;
		if (currentBytes <= 0) return;

		const branchEntries = lastBranchEntries.length > 0 ? lastBranchEntries : ctx?.sessionManager?.getBranch?.() || [];
		const branchMessageEntries = extractBranchMessageEntries(branchEntries);
		if (branchMessageEntries.length === 0) return;

		const messageModels = branchMessageEntries.map((entry: any) => entry.message as AgentMessage);
		const safeMessageStartIndex = alignCursorToToolCallPairs(
			messageModels,
			Math.min(getObservationCursor(state), branchMessageEntries.length),
		);
		const savings = estimateArchiveableSavingsBytes(branchEntries, safeMessageStartIndex, config);
		const decision = evaluateRolloverDecision({
			config: config.sessionRollover,
			currentBytes,
			projectedSavingsBytes: savings.coveredBytes + savings.oversizedRetainedBytes,
			hasArchiveableCoverage: safeMessageStartIndex > 0,
			hasOversizedEntries: savings.hasOversizedEntries,
			force,
		});
		if (!decision.shouldStage) {
			if (decision.shouldWarn) {
				setTransientActivityStatus(styleStatus("warning", `⟳ OM hot session ${(currentBytes / 1024 / 1024).toFixed(1)}MiB`));
			} else if (!sessionRolloverInFlight && !pendingSessionSwitchToken) {
				clearTransientActivityStatus();
			}
			return;
		}

		sessionRolloverInFlight = true;
		setTransientActivityStatus(styleStatus("warning", "⟳ OM archiving hot session"));
		try {
			const allEntries = ctx?.sessionManager?.getEntries?.() || [];
			const sessionName = resolveSessionLabel(ctx) || sanitizeSessionKey(path.basename(sessionFilePath, path.extname(sessionFilePath)));
			const token = createPendingSwitchToken();
			const targetHotSessionPath = createHotSessionPath(sessionFilePath);
			const bundle = buildHotSessionBundle({
				cwd: process.cwd(),
				sessionName,
				token,
				reason: decision.reason || reason,
				sourceSessionPath: sessionFilePath,
				targetHotSessionPath,
				allEntries,
				branchEntries,
				branchMessageEntries,
				safeMessageStartIndex,
				state,
				config,
			});
			lastProjectedHotSessionBytes = bundle.projectedHotBytes;
			lastRolloverReason = decision.reason || reason;
			savePendingSwitch(bundle.pendingRecord, process.cwd());
			pendingSessionSwitchToken = token;
			lastPendingSwitchRefreshBytes = currentBytes;

			// Experience generation now happens immediately after observation writes,
			// not during rollover/archive handling.

			writeJsonFileAtomic(getRecoveryReportPath(sessionName, process.cwd()), {
				type: "rollover",
				createdAt: new Date().toISOString(),
				sourceSessionPath: sessionFilePath,
				targetHotSessionPath,
				currentBytes,
				projectedHotBytes: bundle.projectedHotBytes,
				coveredEntryIds: bundle.coveredEntryIds,
				trimmedEntryIds: bundle.trimmedEntryIds,
				archiveChunks: bundle.archiveChunks,
				reason: decision.reason || reason,
			});

			appendDiagnostic("info", "rollover", "Prepared OM hot-session rollover", {
				token,
				reason: decision.reason || reason,
				sessionName,
				currentBytes,
				projectedHotBytes: bundle.projectedHotBytes,
				coveredEntries: bundle.coveredEntryIds.length,
				trimmedEntries: bundle.trimmedEntryIds.length,
				targetHotSessionPath,
			});
			setTransientActivityStatus(styleStatus("warning", "⟳ OM switch ready · /om switch"));
			notifyOm(
				`OM prepared a hot-session rollover for ${sessionName}. Run /om switch to continue in the compact session.`,
				"warning",
				true,
			);
		} catch (error) {
			pendingSessionSwitchToken = null;
			appendDiagnostic("error", "rollover", "Failed to prepare OM hot-session rollover", {
				sourceSessionPath: sessionFilePath,
				error: describeAsyncError(error),
			});
			setOmError(describeAsyncError(error), "rollover", { notify: true });
			clearTransientActivityStatus();
		} finally {
			sessionRolloverInFlight = false;
			if (!pendingSessionSwitchToken) {
				clearTransientActivityStatus();
			}
		}
	}

	async function handleStartupSessionRollover(ctx: any): Promise<void> {
		refreshSessionFileMetrics(ctx);
		finalizePendingSessionArchive(ctx);
		const existingPending = resolvePendingSwitchRecord(ctx);
		if (existingPending) {
			showPendingSwitchHint(ctx, existingPending, "session_start");
			return;
		}
		await maybeStageSessionRollover(ctx, "session_start", false);
	}

	function resetFooterRenderScheduler(resetKey = false): void {
		if (footerRenderTimer) {
			clearTimeout(footerRenderTimer);
			footerRenderTimer = null;
		}
		footerRenderQueued = false;
		if (resetKey) {
			footerLastRenderAt = 0;
			footerLastRenderKey = "";
		}
	}

	function buildFooterRenderKey(): string {
		return [
			footerBranchName,
			footerState.modelName,
			footerState.thinkingLevel,
			footerState.thinkingLength,
			footerState.sessionLabel,
			String(footerState.contextPercent ?? ""),
			String(footerState.contextWindow),
			String(footerState.contextTokens ?? ""),
			String(footerState.systemPromptTokens),
			String(footerState.toolDefinitionTokens),
			String(footerState.observationTokens),
			String(footerState.reflectionTokens),
			String(footerState.rawMessageTokens),
			footerState.omStatus,
			footerState.omError,
			String(footerState.mcpServerCount),
			String(footerState.diffAdded),
			String(footerState.diffRemoved),
			footerState.isWorktree ? "1" : "0",
		].join("|");
	}

	function flushFooterRender(force = false): void {
		if (!footerRequestRender || shuttingDown) return;
		const key = buildFooterRenderKey();
		if (!force && key === footerLastRenderKey) {
			return;
		}
		try {
			footerRequestRender();
			footerLastRenderAt = Date.now();
			footerLastRenderKey = key;
		} catch {
			// best-effort UI refresh only
		}
	}

	function requestFooterRender(force = false): void {
		if (!footerRequestRender || shuttingDown) return;
		const throttleMs = Math.max(50, config.footerRenderThrottleMs);
		const now = Date.now();
		const elapsed = now - footerLastRenderAt;
		if (force || elapsed >= throttleMs) {
			resetFooterRenderScheduler(false);
			flushFooterRender(force);
			return;
		}
		if (footerRenderQueued) {
			return;
		}
		const waitMs = Math.max(1, throttleMs - elapsed);
		footerRenderQueued = true;
		footerRenderTimer = setTimeout(() => {
			footerRenderTimer = null;
			footerRenderQueued = false;
			flushFooterRender(false);
		}, waitMs);
	}

	function applyCodexQuotaSnapshot(snapshot: CodexQuotaFooterSnapshot): void {
		let changed = false;
		if (snapshot.accountName && footerState.codexAccountName !== snapshot.accountName) {
			footerState.codexAccountName = snapshot.accountName;
			changed = true;
		}
		if (snapshot.planType && footerState.codexPlanType !== snapshot.planType) {
			footerState.codexPlanType = snapshot.planType;
			changed = true;
		}
		if (typeof snapshot.remaining5hPercent === "number" && footerState.codex5hRemainingPercent !== snapshot.remaining5hPercent) {
			footerState.codex5hRemainingPercent = snapshot.remaining5hPercent;
			changed = true;
		}
		if (typeof snapshot.remaining7dPercent === "number" && footerState.codex7dRemainingPercent !== snapshot.remaining7dPercent) {
			footerState.codex7dRemainingPercent = snapshot.remaining7dPercent;
			changed = true;
		}
		if (typeof snapshot.reset5hAtMs === "number" && footerState.codex5hResetAtMs !== snapshot.reset5hAtMs) {
			footerState.codex5hResetAtMs = snapshot.reset5hAtMs;
			changed = true;
		}
		if (typeof snapshot.reset7dAtMs === "number" && footerState.codex7dResetAtMs !== snapshot.reset7dAtMs) {
			footerState.codex7dResetAtMs = snapshot.reset7dAtMs;
			changed = true;
		}
		if (changed) {
			requestFooterRender();
			updateOmUi();
		}
	}

	function clearCodexQuotaFooterState(): void {
		let changed = false;
		if (footerState.codexAccountName) {
			footerState.codexAccountName = "";
			changed = true;
		}
		if (footerState.codexPlanType) {
			footerState.codexPlanType = "";
			changed = true;
		}
		if (footerState.codex5hRemainingPercent !== null) {
			footerState.codex5hRemainingPercent = null;
			changed = true;
		}
		if (footerState.codex7dRemainingPercent !== null) {
			footerState.codex7dRemainingPercent = null;
			changed = true;
		}
		if (footerState.codex5hResetAtMs !== null) {
			footerState.codex5hResetAtMs = null;
			changed = true;
		}
		if (footerState.codex7dResetAtMs !== null) {
			footerState.codex7dResetAtMs = null;
			changed = true;
		}
		if (changed) {
			requestFooterRender();
			updateOmUi();
		}
	}

	function refreshCodexQuotaFooterState(forceProbe = false): void {
		refreshSettingsSnapshot();
		const defaultProvider = resolveDefaultProviderFromSettings();
		const runtimeProvider = (activeProviderName || "").trim();
		const modelName = (footerState.modelName || "").trim().toLowerCase();
		const modelLooksCodex = modelName.includes("codex");
		const configuredProvider = (defaultProvider || config.observerModel.provider || "openai-codex").trim();
		const preferredProvider = (runtimeProvider || configuredProvider).trim();

		if (runtimeProvider && !isCodexProviderName(runtimeProvider)) {
			codexQuotaCachedSnapshot = null;
			codexQuotaLastSource = "";
			clearCodexQuotaFooterState();
			return;
		}
		if (!runtimeProvider && modelName && !modelLooksCodex) {
			codexQuotaCachedSnapshot = null;
			codexQuotaLastSource = "";
			clearCodexQuotaFooterState();
			return;
		}

		const providerForQuota = isCodexProviderName(preferredProvider)
			? preferredProvider
			: modelLooksCodex
				? "openai-codex"
				: "";
		if (!providerForQuota) {
			codexQuotaCachedSnapshot = null;
			codexQuotaLastSource = "";
			clearCodexQuotaFooterState();
			return;
		}

		const fromFiles = loadCodexQuotaFooterSnapshot(providerForQuota);
		const footerQuota = extractCodexQuotaFromFooterData(footerDataProviderRef, providerForQuota, modelName);
		const fromFooterData = footerQuota.snapshot;
		const fromExtensionStatuses = extractCodexQuotaFromExtensionStatuses(footerDataProviderRef);
		const previousCached = codexQuotaCachedSnapshot;
		const observedAccountName = (
			fromExtensionStatuses?.accountName ||
			fromFooterData?.accountName ||
			fromFiles.accountName ||
			""
		).trim();
		const accountSwitched = Boolean(
			observedAccountName &&
			previousCached?.accountName &&
			normalizeAccountKey(observedAccountName) !== normalizeAccountKey(previousCached.accountName),
		);
		if (accountSwitched) {
			codexQuotaCachedSnapshot = null;
		}

		const baseSnapshot = codexQuotaCachedSnapshot ?? createEmptyCodexQuotaSnapshot();
		let merged = mergeCodexSnapshots(fromFiles, baseSnapshot);
		merged = mergeCodexSnapshots(merged, fromFooterData);
		merged = mergeCodexSnapshots(merged, fromExtensionStatuses);
		if (merged.accountName || hasCodexUsage(merged)) {
			codexQuotaCachedSnapshot = merged;
		}
		applyCodexQuotaSnapshot(merged);
		if (hasCodexUsage(fromExtensionStatuses)) {
			codexQuotaLastSource = "multicodex-status";
		} else if (hasCodexUsage(fromFooterData)) {
			codexQuotaLastSource = "footer-data";
		} else if (hasCodexUsage(fromFiles)) {
			codexQuotaLastSource = "file-snapshot";
		}
		if (shuttingDown || !forceProbe || codexQuotaProbeInFlight) {
			return;
		}

		const expectedAccountKey = normalizeAccountKey(observedAccountName || merged.accountName || "");
		const hasLiveFooterUsage = hasCodexUsage(fromExtensionStatuses) || hasCodexUsage(fromFooterData);
		codexQuotaProbeInFlight = (async () => {
			let resolvedSnapshot = merged;
			let resolvedFooterPatch: Partial<CodexQuotaFooterSnapshot> | null = null;

			if (footerQuota.asyncPayloadPromises.length > 0) {
				const asyncValues = (await Promise.all(footerQuota.asyncPayloadPromises)).filter((value) => value != null);
				resolvedFooterPatch = mergeParsedQuotaPayloads(asyncValues);
				if (resolvedFooterPatch) {
					resolvedSnapshot = mergeCodexSnapshots(resolvedSnapshot, resolvedFooterPatch);
					resolvedSnapshot = mergeCodexSnapshots(resolvedSnapshot, fromExtensionStatuses);
					codexQuotaCachedSnapshot = resolvedSnapshot;
					if (hasCodexUsage(fromExtensionStatuses)) {
						codexQuotaLastSource = "multicodex-status";
					} else if (hasCodexUsage(resolvedFooterPatch)) {
						codexQuotaLastSource = "footer-data";
					}
					applyCodexQuotaSnapshot(resolvedSnapshot);
				}
			}

			if (hasLiveFooterUsage || hasCodexUsage(resolvedFooterPatch)) {
				return;
			}

			const probePatch = await probeCodexQuotaViaBackendUsageApi(providerForQuota);
			if (!probePatch || shuttingDown) return;
			if (
				expectedAccountKey &&
				typeof probePatch.accountName === "string" &&
				probePatch.accountName.trim() &&
				normalizeAccountKey(probePatch.accountName) !== expectedAccountKey
			) {
				return;
			}
			codexQuotaCachedSnapshot = mergeCodexSnapshots(resolvedSnapshot, probePatch);
			if (hasCodexUsage(codexQuotaCachedSnapshot)) {
				codexQuotaLastSource = "backend-usage-api";
			}
			applyCodexQuotaSnapshot(codexQuotaCachedSnapshot);
		})()
			.catch(() => {
				// silent best-effort probe
			})
			.finally(() => {
				codexQuotaProbeInFlight = null;
			});
	}

	function stopFooterUsagePolling(): void {
		if (footerUsagePollTimer) {
			clearInterval(footerUsagePollTimer);
			footerUsagePollTimer = null;
		}
	}

	function startFooterUsagePolling(): void {
		stopFooterUsagePolling();
		const intervalMs = Math.floor(config.footerUsagePollIntervalMs || 0);
		if (intervalMs <= 0) {
			return;
		}
		footerUsagePollTimer = setInterval(() => {
			if (shuttingDown) return;
			refreshCodexQuotaFooterState(true);
		}, intervalMs);
	}

	function normalizeThinkingLevel(value: unknown): string {
		if (typeof value !== "string") return "off";
		const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
		if (!compact) return "off";
		if (compact === "off" || compact === "none") return "off";
		if (compact === "minimum" || compact === "minimal" || compact === "min") return "• low";
		if (compact === "low") return "low";
		if (compact === "medium" || compact === "med") return "• medium";
		if (compact === "high") return "high";
		if (compact === "xhigh" || compact === "xh" || compact === "ultra") return "• xhigh";
		return value.trim().toLowerCase();
	}

	function normalizeThinkingLength(value: unknown): string {
		if (typeof value !== "string") return "";
		const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
		if (!compact) return "";
		if (compact === "minimum" || compact === "minimal" || compact === "min") return "minimum";
		if (compact === "short") return "short";
		if (compact === "medium" || compact === "med") return "medium";
		if (compact === "long") return "long";
		if (compact === "xlong" || compact === "xhigh" || compact === "max") return "x long";
		if (compact === "auto" || compact === "default") return "auto";
		return value.trim().toLowerCase();
	}

	function refreshSettingsSnapshot(): boolean {
		const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		const projectSettingsPath = path.join(process.cwd(), ".pi", "settings.json");
		const globalSettings = readJsonFile(globalSettingsPath);
		const projectSettings = readJsonFile(projectSettingsPath);
		const sources = [projectSettings, globalSettings].filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"));

		const firstByPaths = (paths: string[]): unknown => {
			for (const source of sources) {
				const value = getByPaths(source, paths);
				if (typeof value !== "undefined") return value;
			}
			return undefined;
		};

		const nextThinkingLength = normalizeThinkingLength(firstByPaths([
			"thinkingLength",
			"defaultThinkingLength",
			"reasoningLength",
			"defaultReasoningLength",
			"thinking.length",
			"reasoning.length",
		]));
		const provider = firstByPaths(["defaultProvider", "provider"]);
		const nextDefaultProvider = typeof provider === "string" ? provider.trim() : "";

		const changed = cachedThinkingLength !== nextThinkingLength || cachedDefaultProvider !== nextDefaultProvider;
		cachedThinkingLength = nextThinkingLength;
		cachedDefaultProvider = nextDefaultProvider;
		return changed;
	}

	function resolveThinkingLength(ctx: any, explicitModel?: any): string {
		const sources = [explicitModel, ctx?.model, ctx];
		for (const source of sources) {
			if (!source || typeof source !== "object") continue;
			const candidate = getByPaths(source, [
				"thinkingLength",
				"thinking.length",
				"thinking.lengthMode",
				"thinking.mode",
				"reasoningLength",
				"reasoning.length",
				"reasoning.effort",
				"reasoningEffort",
			]);
			const normalized = normalizeThinkingLength(candidate);
			if (normalized) return normalized;
		}
		return cachedThinkingLength;
	}

	function resolveDefaultProviderFromSettings(): string {
		return cachedDefaultProvider;
	}

	function syncThinkingState(ctx: any, explicitModel?: any): boolean {
		let changed = false;
		refreshSettingsSnapshot();
		const nextThinkingLevel = normalizeThinkingLevel(pi.getThinkingLevel() || "off");
		if (footerState.thinkingLevel !== nextThinkingLevel) {
			footerState.thinkingLevel = nextThinkingLevel;
			changed = true;
		}

		const nextThinkingLength = resolveThinkingLength(ctx, explicitModel);
		if (footerState.thinkingLength !== nextThinkingLength) {
			footerState.thinkingLength = nextThinkingLength;
			changed = true;
		}

		if (changed) {
			requestFooterRender();
		}
		return changed;
	}

	function normalizeContextWindowCandidate(value: unknown): number | null {
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		if (value <= 0) return null;
		return Math.floor(value);
	}

	function resolveActiveContextWindow(
		ctx: any,
		explicitModel?: { contextWindow?: number },
	): { contextWindow: number; source: ContextWindowSource } {
		const explicitWindow = normalizeContextWindowCandidate(explicitModel?.contextWindow);
		if (explicitWindow) {
			return { contextWindow: explicitWindow, source: "model" };
		}

		const modelWindow = normalizeContextWindowCandidate(ctx?.model?.contextWindow);
		if (modelWindow) {
			return { contextWindow: modelWindow, source: "model" };
		}

		const usageWindow = normalizeContextWindowCandidate(ctx?.getContextUsage?.()?.contextWindow);
		if (usageWindow) {
			return { contextWindow: usageWindow, source: "usage" };
		}

		return {
			contextWindow: normalizeContextWindowCandidate(config.contextWindowSize) ?? 0,
			source: "config-fallback",
		};
	}

	function syncActiveModelContext(ctx: any, explicitModel?: { id?: string; contextWindow?: number; provider?: string }): boolean {
		let changed = false;
		const modelName = explicitModel?.id || ctx?.model?.id || "";
		if (modelName && footerState.modelName !== modelName) {
			footerState.modelName = modelName;
			changed = true;
		}

		let providerName = explicitModel?.provider || ctx?.model?.provider || "";
		if (!providerName && modelName.includes("/")) {
			providerName = modelName.split("/")[0] || "";
		}
		if (providerName && activeProviderName !== providerName) {
			activeProviderName = providerName;
			changed = true;
		}

		const windowResolution = resolveActiveContextWindow(ctx, explicitModel);
		if (activeContextWindow !== windowResolution.contextWindow) {
			activeContextWindow = windowResolution.contextWindow;
			footerState.contextWindow = windowResolution.contextWindow;
			changed = true;
		}
		if (contextWindowSource !== windowResolution.source) {
			contextWindowSource = windowResolution.source;
			changed = true;
		}

		if (changed) {
			requestFooterRender();
		}
		return changed;
	}

	function syncCodexQuotaVisibilityForActiveModel(): void {
		const runtimeProvider = (activeProviderName || "").trim();
		const modelName = (footerState.modelName || "").trim().toLowerCase();
		const modelLooksCodex = modelName.includes("codex");
		if ((runtimeProvider && !isCodexProviderName(runtimeProvider)) || (!runtimeProvider && modelName && !modelLooksCodex)) {
			codexQuotaCachedSnapshot = null;
			codexQuotaLastSource = "";
			clearCodexQuotaFooterState();
		}
	}

	function refreshMcpServerCount(allTools?: Array<{ name: string }>): void {
		let nextCount = extractConnectedMcpCountFromExtensionStatuses(footerDataProviderRef);

		if (nextCount === null) {
			try {
				const resolvedTools = allTools || pi.getAllTools();
				const mcpPrefixes = loadMcpServerPrefixes();
				nextCount = countMcpServers(resolvedTools, mcpPrefixes);
			} catch {
				nextCount = null;
			}
		}

		if (typeof nextCount !== "number" || !Number.isFinite(nextCount)) return;
		const normalized = Math.max(0, Math.floor(nextCount));
		if (footerState.mcpServerCount === normalized) return;
		footerState.mcpServerCount = normalized;
		requestFooterRender();
	}

	function syncRuntimeUiState(ctx: any, explicitModel?: { id?: string; contextWindow?: number; provider?: string }): void {
		const modelChanged = syncActiveModelContext(ctx, explicitModel);
		const thinkingChanged = syncThinkingState(ctx, explicitModel);
		refreshMcpServerCount();
		if (modelChanged) {
			syncCodexQuotaVisibilityForActiveModel();
		}
		if (modelChanged || thinkingChanged) {
			updateOmUi();
		}
	}

	function getCompressionStrategy(): "reflector" | "reobserve" {
		return config.compressionStrategy === "reobserve" ? "reobserve" : "reflector";
	}

	function getReflectionAuthGetter(): (() => Promise<RequestAuth>) | null {
		return getCompressionStrategy() === "reobserve" ? observerAuthGetter : reflectorAuthGetter;
	}

	function getEffectiveContextWindow(): number {
		return activeContextWindow || config.contextWindowSize || 0;
	}

	function getContextThresholds(): OmContextThresholds {
		return computeOmContextThresholds({
			config,
			contextWindow: getEffectiveContextWindow(),
		});
	}

	function clearObservationBatch(): void {
		lastObservationBatchMessages = [];
		lastObservationBatchTokens = 0;
		lastObservationBatchStartIndex = 0;
		lastObservationBatchEndIndex = 0;
	}

	function hasObservationBatch(): boolean {
		return (
			lastObservationBatchMessages.length > 0 &&
			lastObservationBatchEndIndex > getObservationCursor(state)
		);
	}

	function alignCursorToToolCallPairs(messages: AgentMessage[], candidateIndex: number): number {
		return alignObservationCursorToToolPairs(messages, candidateIndex);
	}

	type ObservationBatchPolicy = {
		scopePercent?: number;
		minMessages?: number;
		preserveRecentMessages?: number;
	};

	function computeSafeObservationBatchFromCursor(
		messages: AgentMessage[],
		cursorIndex: number,
		policy?: ObservationBatchPolicy,
	): { messages: AgentMessage[]; startIndex: number; endIndex: number; tokens: number } | null {
		if (messages.length === 0) return null;
		const safeCursorIndex = alignCursorToToolCallPairs(messages, cursorIndex);
		return selectOldestRawMessageBatch({
			messages,
			cursor: safeCursorIndex,
			contextWindow: getEffectiveContextWindow(),
			oldestScopePercent: policy?.scopePercent ?? config.rawMessages.oldestScopePercent,
			preserveRecentMessages: policy?.preserveRecentMessages ?? config.preserveRecentMessages,
			minMessages: policy?.minMessages ?? config.minObservationMessages,
			alignIndex: (nextIndex) => alignCursorToToolCallPairs(messages, nextIndex),
		});
	}

	function computeContextPercent(tokens: number, contextWindow: number): number | null {
		return computeObservationContextPercent(tokens, contextWindow);
	}

	function refreshPendingContextSlice(messages: AgentMessage[]): { cursorIndex: number } {
		lastFullMessages = messages;
		lastFullMessageCount = messages.length;

		const previousCursorIndex = getObservationCursor(state);
		const slice = planPendingObservationSlice({
			state,
			messages,
			contextWindow: getEffectiveContextWindow(),
			config: {
				rawMessages: config.rawMessages,
				preserveRecentMessages: config.preserveRecentMessages,
				minObservationMessages: config.minObservationMessages,
			},
		});
		if (slice.cursorWasClamped) {
			state.rawMessageCursor = slice.rawCursorIndex;
			state.lastObservedMessageIndex = slice.rawCursorIndex;
			appendDiagnostic(
				"warning",
				"observe",
				"Clamped OM cursor to current context size",
				{ fromIndex: previousCursorIndex, toIndex: slice.rawCursorIndex, messageCount: messages.length },
			);
		}

		if (slice.cursorWasRealigned) {
			state.rawMessageCursor = slice.cursorIndex;
			state.lastObservedMessageIndex = slice.cursorIndex;
			appendDiagnostic(
				"warning",
				"observe",
				"Adjusted OM cursor to keep tool call/result pairs intact",
				{ fromIndex: slice.rawCursorIndex, toIndex: slice.cursorIndex },
			);
		}

		lastUnobservedMessages = slice.unobservedMessages;
		lastUnobservedTokens = slice.unobservedTokens;
		lastForwardedUnobservedMessageTokens = slice.unobservedTokens;

		if (slice.batch) {
			lastObservationBatchMessages = slice.batch.messages;
			lastObservationBatchTokens = slice.batch.tokens;
			lastObservationBatchStartIndex = slice.batch.startIndex;
			lastObservationBatchEndIndex = slice.batch.endIndex;
		} else {
			clearObservationBatch();
		}

		return { cursorIndex: slice.cursorIndex };
	}

	function refreshContextPressureSnapshot(ctx: any): void {
		const contextUsage = ctx?.getContextUsage?.();
		const pressure = computeOmContextPressure({
			runtimeContextPercent: contextUsage?.percent,
			runtimeContextTokens: contextUsage?.tokens,
			unobservedTokens: lastUnobservedTokens,
			contextWindow: getEffectiveContextWindow(),
		});

		lastRuntimeContextPercent = pressure.runtimePercent;
		lastEstimatedContextPercent = pressure.estimatedPercent;
		lastContextPercent = pressure.effectivePercent;
		footerState.contextTokens = pressure.contextTokens;
		// Footer display should prefer runtime usage when available to avoid
		// oscillating between backlog-estimate pressure and forwarded-slice values.
		footerState.contextPercent = pressure.runtimePercent ?? pressure.estimatedPercent;
	}

	function trimMessagesToTokenBudget(
		messages: AgentMessage[],
		targetTokens: number,
	): { messages: AgentMessage[]; tokens: number } | null {
		return trimMessagesToTokenBudgetKeepingPairs(messages, targetTokens);
	}

	function isContextLengthExceededError(errorMessage: unknown): boolean {
		if (typeof errorMessage !== "string") return false;
		const text = errorMessage.toLowerCase();
		if (text.includes("context_length_exceeded")) return true;
		if (text.includes("context window") && text.includes("exceed")) return true;
		if (text.includes("context length") && text.includes("exceed")) return true;
		if (text.includes("auto-compaction cancelled")) return true;
		return false;
	}

	function markContextOverflowRecovery(errorMessage: string): void {
		contextOverflowRecoveryPending = true;
		contextOverflowLastError = truncateInline(errorMessage, 220);
		contextOverflowLastAt = Date.now();
	}

	function clearContextOverflowRecovery(): void {
		contextOverflowRecoveryPending = false;
		contextOverflowLastError = "";
		contextOverflowLastAt = 0;
	}

	function shouldRunContextOverflowRecovery(): boolean {
		if (!contextOverflowRecoveryPending) return false;
		if (Date.now() - contextOverflowLastAt > CONTEXT_OVERFLOW_RECOVERY_WINDOW_MS) {
			clearContextOverflowRecovery();
			return false;
		}
		return true;
	}

	function primeEmergencyObservationBatch(scopePercent = EMERGENCY_OBSERVE_SCOPE_PERCENT): boolean {
		const fullMessages = lastFullMessages.length > 0 ? lastFullMessages : lastUnobservedMessages;
		if (fullMessages.length === 0) return false;
		const rawCursorIndex = Math.min(getObservationCursor(state), fullMessages.length);
		const cursorIndex = alignCursorToToolCallPairs(fullMessages, rawCursorIndex);
		const emergencyBatch = computeSafeObservationBatchFromCursor(fullMessages, cursorIndex, {
			scopePercent: Math.max(scopePercent, config.rawMessages.oldestScopePercent),
			minMessages: Math.max(1, config.minObservationMessages),
		});
		if (!emergencyBatch) return false;
		lastObservationBatchMessages = emergencyBatch.messages;
		lastObservationBatchTokens = emergencyBatch.tokens;
		lastObservationBatchStartIndex = emergencyBatch.startIndex;
		lastObservationBatchEndIndex = emergencyBatch.endIndex;
		return true;
	}

	function describeError(error: unknown): string {
		return describeAsyncError(error);
	}

	function createAuthGetter(
		label: string,
		getModelConfig: () => { provider: string; modelId: string },
	): () => Promise<RequestAuth> {
		return async () => {
			const modelRegistry = currentCtx?.modelRegistry as CompatibleModelRegistry | undefined;
			if (!modelRegistry || typeof modelRegistry.find !== "function") {
				throw new Error(`[OM] ${label} auth unavailable: model registry is not ready`);
			}
			const modelConfig = getModelConfig();
			const provider = String(modelConfig?.provider || "").trim();
			const modelId = String(modelConfig?.modelId || "").trim();
			if (!provider || !modelId) {
				throw new Error(`[OM] Invalid ${label} model configuration`);
			}
			return requireModelAuth(modelRegistry, provider, modelId, label);
		};
	}

	function createBackgroundController(): AbortController {
		const controller = new AbortController();
		backgroundControllers.add(controller);
		controller.signal.addEventListener(
			"abort",
			() => {
				backgroundControllers.delete(controller);
			},
			{ once: true },
		);
		return controller;
	}

	function releaseBackgroundController(controller: AbortController): void {
		backgroundControllers.delete(controller);
	}

	function appendDiagnostic(
		level: ObservationDiagnosticEntry["level"],
		phase: ObservationDiagnosticEntry["phase"],
		message: string,
		details?: Record<string, unknown>,
	): void {
		try {
			const entry = createDiagnosticEntry(level, phase, message, details);
			const cwd = currentCtx?.cwd || process.cwd();
			const payload = {
				...entry,
				sessionLabel: footerState.sessionLabel || resolveSessionLabel(currentCtx) || "",
				sessionFile: String(currentCtx?.sessionManager?.getSessionFile?.() || ""),
			};
			fs.appendFileSync(getDiagnosticLogPath(cwd), `${JSON.stringify(payload)}\n`, "utf-8");
		} catch {
			// best-effort only
		}
	}

	function styleStatus(color: "error" | "warning" | "accent" | "success" | "dim", text: string): string {
		try {
			if (currentCtx?.hasUI) {
				return currentCtx.ui.theme.fg(color, text);
			}
		} catch {
			// fall through to plain text
		}
		return text;
	}

	function buildThinkingStatus(): string {
		const level = footerState.thinkingLevel || "off";
		const length = footerState.thinkingLength ? `/${footerState.thinkingLength}` : "";
		return `${level}${length}`;
	}

	function publishExtensionStatus(activityStatus?: string): void {
		if (!currentCtx?.hasUI) return;
		const thinkingStatus = buildThinkingStatus();
		const statusText = activityStatus
			? `${activityStatus} · ${thinkingStatus}`
			: thinkingStatus;
		if (statusText === lastFooterStatusText) {
			return;
		}
		try {
			currentCtx.ui.setStatus("observational-memory", statusText as any);
		} catch {
			try {
				currentCtx.ui.setStatus(statusText || "");
			} catch {
				// ignore UI update failures
			}
		}
		lastFooterStatusText = statusText;
	}

	function updateOmUi(): void {
		const nextOmError = lastOmError ? truncateInline(lastOmError, 72) : "";
		let nextOmStatus = "";
		if (sessionRolloverInFlight || pendingSessionSwitchToken) {
			nextOmStatus = pendingSessionSwitchToken ? "switch-ready" : "rollover";
		} else if (reflectionInFlight && reflectionAttemptState) {
			nextOmStatus = `reflect ${reflectionAttemptState.attempt}/${reflectionAttemptState.maxAttempts}`;
		} else if (observationInFlight && observationAttemptState) {
			nextOmStatus = observationAttemptState.attempt > 1
				? `observe retry ${observationAttemptState.attempt}/${observationAttemptState.maxAttempts}`
				: `observe ${observationAttemptState.attempt}/${observationAttemptState.maxAttempts}`;
		} else if (lastOmError) {
			nextOmStatus = lastOmErrorPhase || "error";
		}

		const omChanged = footerState.omError !== nextOmError || footerState.omStatus !== nextOmStatus;
		footerState.omError = nextOmError;
		footerState.omStatus = nextOmStatus;

		let activityStatus: string | undefined;
		if (currentActivityStatus) {
			activityStatus = currentActivityStatus;
		} else if (reflectionInFlight && reflectionAttemptState) {
			activityStatus = styleStatus(
				"warning",
				`⟳ OM reflecting ${reflectionAttemptState.attempt}/${reflectionAttemptState.maxAttempts}`,
			);
		} else if (observationInFlight && observationAttemptState) {
			activityStatus = styleStatus(
				"warning",
				`⟳ OM observing ${observationAttemptState.attempt}/${observationAttemptState.maxAttempts}`,
			);
		} else if (lastOmError) {
			activityStatus = styleStatus(
				"error",
				`⚠ OM ${truncateInline(lastOmError, 100)}`,
			);
		}

		publishExtensionStatus(activityStatus);
		if (omChanged) {
			requestFooterRender();
		}
	}

	function notifyOm(message: string, level: "info" | "warning" | "error" = "error", force = false): void {
		if (!currentCtx?.hasUI || shuttingDown) return;
		const now = Date.now();
		if (!force && level !== "info" && now - lastUiErrorNotificationAt < config.errorNotifyCooldownMs) {
			return;
		}
		if (level !== "info") {
			lastUiErrorNotificationAt = now;
		}
		try {
			currentCtx.ui.notify(message, level);
		} catch {
			// ignore UI notify failures
		}
	}

	function setOmError(
		message: string,
		phase: ObservationDiagnosticEntry["phase"],
		options?: {
			level?: ObservationDiagnosticEntry["level"];
			notify?: boolean;
			details?: Record<string, unknown>;
		},
	): void {
		lastOmError = message;
		lastOmErrorPhase = phase;
		lastOmErrorAt = new Date().toISOString();
		appendDiagnostic(options?.level || "error", phase, message, options?.details);
		updateOmUi();
		if (options?.notify !== false) {
			notifyOm(`Observational memory ${phase}: ${truncateInline(message, 200)}`, options?.level === "warning" ? "warning" : "error");
		}
	}

	function clearOmError(): void {
		lastOmError = null;
		lastOmErrorPhase = "";
		lastOmErrorAt = "";
		updateOmUi();
	}

	async function reflectIfNeeded(
		parentSignal?: AbortSignal,
		options?: { force?: boolean; full?: boolean; source?: ObservationDiagnosticEntry["phase"] },
	): Promise<boolean> {
		const strategy = getCompressionStrategy();
		const reflectionAuth = getReflectionAuthGetter();
		if (!reflectionAuth || (!hasObservationItems(state) && !hasReflectionItems(state))) {
			return false;
		}

		const plan = planReflectionRun({
			config,
			state,
			strategy,
			force: options?.force,
			contextWindow: getEffectiveContextWindow(),
			completedTurnCount,
			lastReflectionCheckpointTurn,
			lastReflectionCheckpointAtMs,
		});
		if (!plan) {
			return false;
		}

		const {
			thresholds: {
				reflectionTriggerTokens,
				reflectionTriggerPercent,
				reflectionTargetTokens,
				reflectionTargetPercent,
				reflectionRefreshTriggerTokens,
				reflectionRefreshTriggerPercent,
				contextWindow,
			},
			observationTokens,
			reflectionTokens,
			mode,
			maxAttempts,
		} = plan;
		const controller = parentSignal ? null : createBackgroundController();
		const signal = parentSignal || controller!.signal;
		reflectionInFlight = true;
		appendDiagnostic("info", "reflect", "Reflection started", {
			strategy,
			observationTokens,
			reflectionTokens,
			reflectionTriggerTokens,
			reflectionTriggerPercent,
			reflectionTargetTokens,
			reflectionTargetPercent,
			reflectionRefreshTriggerTokens,
			reflectionRefreshTriggerPercent,
			contextWindow,
			fullCompaction: Boolean(options?.full),
			source: options?.source || "reflect",
			mode,
		});
		updateOmUi();

		try {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				reflectionAttemptState = { attempt, maxAttempts };
				updateOmUi();

				try {
					await executeReflectionPlan({
						config,
						state,
						getAuth: reflectionAuth,
						plan,
						signal,
						cwd: process.cwd(),
						sessionName: resolveSessionLabel(currentCtx) || "session",
					});
					footerState.observationTokens = state.totalObservationTokens;
					footerState.experienceTokens = state.totalExperienceTokens;
					footerState.reflectionTokens = getReflectionTokenTotal(state);
					persistState(pi, state, mode === "reflections" ? "reflection_refresh" : "reflection");
					clearOmError();
					lastReflectionCheckpointTurn = completedTurnCount;
					lastReflectionCheckpointAtMs = Date.now();
					appendDiagnostic("info", mode === "observations" ? "reflect_success" : "reflect_refresh", "Reflection succeeded", {
						strategy,
						attempt,
						generationCount: state.generationCount,
						reflectionTokens: getReflectionTokenTotal(state),
						remainingActiveObservationTokens: state.totalObservationTokens,
					});
					return true;
				} catch (error) {
					if (signal.aborted && shuttingDown) {
						return false;
					}

					const retryable = !signal.aborted && !shuttingDown && attempt < maxAttempts && isRetryableOmError(error);
					const delayMs = retryable
						? backoffDelayMs(attempt, config.retryBaseDelayMs, config.retryMaxDelayMs)
						: 0;

					setOmError(describeError(error), retryable ? "reflect_retry" : "reflect", {
						level: retryable ? "warning" : "error",
						notify: attempt === 1 || !retryable,
						details: {
							attempt,
							maxAttempts,
							retryable,
							delayMs,
							source: options?.source || "reflect",
						},
					});

					if (!retryable) {
						throw error;
					}

					appendDiagnostic(
						"warning",
						"reflect_retry",
						`Reflection attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`,
						{ attempt, maxAttempts, delayMs, error: describeError(error) },
					);
					await sleep(delayMs, signal);
				}
			}
			return false;
		} finally {
			reflectionAttemptState = null;
			reflectionInFlight = false;
			if (controller) {
				releaseBackgroundController(controller);
			}
			updateOmUi();
		}
	}

	async function observePendingMessages(force = false): Promise<boolean> {
		if (!observerAuthGetter) return false;

		const fullMessages = lastFullMessages.length > 0 ? lastFullMessages : lastUnobservedMessages;
		const plan = planObservationRun({
			config,
			state,
			fullMessages,
			lastFullMessageCount,
			lastUnobservedMessages,
			force,
			forceObservationOnNextTurn,
			hasObservationBatch: hasObservationBatch(),
			observationBatch: hasObservationBatch()
				? {
					messages: lastObservationBatchMessages,
					startIndex: lastObservationBatchStartIndex,
					endIndex: lastObservationBatchEndIndex,
					tokens: lastObservationBatchTokens,
				}
				: null,
			contextWindow: getEffectiveContextWindow(),
		});
		if (!plan) {
			return false;
		}

		const controller = createBackgroundController();
		appendDiagnostic("info", "observe", "Observation started", {
			force,
			cursorIndex: plan.cursorIndex,
			batchStartIndex: plan.batch.startIndex,
			batchEndIndex: plan.batch.endIndex,
			batchMessages: plan.batch.messages.length,
			batchTokens: plan.observationBatchTokens,
			remainingMessages: lastUnobservedMessages.length,
			remainingTokens: lastUnobservedTokens,
			contextPercent: lastContextPercent,
		});

		try {
			for (let attempt = 1; attempt <= plan.maxAttempts; attempt++) {
				observationAttemptState = { attempt, maxAttempts: plan.maxAttempts };
				updateOmUi();

				try {
					const result = await executeObservationPlan({
						config,
						state,
						plan,
						getAuth: observerAuthGetter,
						timezone,
						cwd: process.cwd(),
						sessionName: resolveSessionLabel(currentCtx) || "session",
						sessionPath: String(currentCtx?.sessionManager?.getSessionFile?.() || "") || undefined,
						signal: controller.signal,
					});
					footerState.observationTokens = state.totalObservationTokens;
					footerState.experienceTokens = state.totalExperienceTokens;
					footerState.reflectionTokens = getReflectionTokenTotal(state);
					syncReflectionArmedState();
					persistState(pi, state, "observation");
					forceObservationOnNextTurn = computeObservationRearmDecision({
						contextTokens: typeof footerState.contextTokens === "number" ? footerState.contextTokens : null,
						contextWindow: footerState.contextWindow,
						observationBatchTokens: plan.observationBatchTokens,
						observationDeltaTokens: result.observationDeltaTokens,
						thresholds: getContextThresholds(),
					});
					clearObservationBatch();
					clearOmError();

					if (result.derivedExperienceCount > 0) {
						appendDiagnostic("info", "experience", "Derived experiences from observation batch", {
							count: result.derivedExperienceCount,
							messageStartIndex: plan.batch.startIndex,
							messageEndIndex: plan.batch.endIndex,
						});
					}

					appendDiagnostic(
						"info",
						"observe_success",
						result.observationText
							? `Observation succeeded in ${result.chunkCount} chunk(s)`
							: `Observation processed ${plan.batch.messages.length} message(s) with no new memory`,
						{
							attempt,
							chunkCount: result.chunkCount,
							cursor: getObservationCursor(state),
							batchStartIndex: plan.batch.startIndex,
							batchEndIndex: plan.batch.endIndex,
							observationTokens: state.totalObservationTokens,
						},
					);

					// Keep reflection (observation compaction) manual via `/om compact`.
					return true;
				} catch (error) {
					if (controller.signal.aborted && shuttingDown) {
						return false;
					}

					const retryable = !controller.signal.aborted && !shuttingDown && attempt < plan.maxAttempts && isRetryableOmError(error);
					const delayMs = retryable
						? backoffDelayMs(attempt, config.retryBaseDelayMs, config.retryMaxDelayMs)
						: 0;

					setOmError(describeError(error), retryable ? "observe_retry" : "observe", {
						level: retryable ? "warning" : "error",
						notify: attempt === 1 || !retryable,
						details: {
							attempt,
							maxAttempts: plan.maxAttempts,
							retryable,
							delayMs,
							force,
							batchStartIndex: plan.batch.startIndex,
							batchEndIndex: plan.batch.endIndex,
							batchMessages: plan.batch.messages.length,
							batchTokens: plan.observationBatchTokens,
							remainingMessages: lastUnobservedMessages.length,
							remainingTokens: lastUnobservedTokens,
						},
					});

					if (!retryable) {
						return false;
					}

					appendDiagnostic(
						"warning",
						"observe_retry",
						`Observation attempt ${attempt}/${plan.maxAttempts} failed, retrying in ${delayMs}ms`,
						{ attempt, maxAttempts: plan.maxAttempts, delayMs, error: describeError(error) },
					);
					await sleep(delayMs, controller.signal);
				}
			}
			return false;
		} finally {
			observationAttemptState = null;
			releaseBackgroundController(controller);
			updateOmUi();
		}
	}

	function syncReflectionArmedState(thresholds = getContextThresholds()): void {
		forceReflectionOnNextTurn = shouldArmReflection({
			currentArmed: forceReflectionOnNextTurn,
			state,
			thresholds,
		});
	}

	function scheduleReflection(force = false, fullCompaction = false): Promise<boolean> | null {
		if (reflectionRunInFlight) {
			return reflectionRunInFlight;
		}
		if (!getReflectionAuthGetter() || (!hasObservationItems(state) && !hasReflectionItems(state))) {
			forceReflectionOnNextTurn = false;
			return null;
		}

		const thresholds = getContextThresholds();
		syncReflectionArmedState(thresholds);
		const shouldForceRun = Boolean(force);
		if (
			!shouldForceRun &&
			!forceReflectionOnNextTurn &&
			state.totalObservationTokens < thresholds.reflectionTriggerTokens &&
			getReflectionTokenTotal(state) < thresholds.reflectionRefreshTriggerTokens
		) {
			return null;
		}

		reflectionRunInFlight = reflectIfNeeded(undefined, {
			force: shouldForceRun,
			full: fullCompaction,
			source: "reflect",
		})
			.catch((error) => {
				if (!shuttingDown) {
					setOmError(describeError(error), "reflect", { notify: true });
				}
				return false;
			})
			.finally(() => {
				reflectionRunInFlight = null;
				syncReflectionArmedState();
				updateOmUi();
			});
		updateOmUi();
		return reflectionRunInFlight;
	}

	function scheduleObservation(force = false): Promise<boolean> | null {
		if (observationInFlight) {
			return observationInFlight;
		}
		if (lastFullMessageCount === 0 || lastUnobservedMessages.length === 0) {
			return null;
		}
		if (!force && !forceObservationOnNextTurn) {
			return null;
		}
		if (!force && !hasObservationBatch()) {
			return null;
		}

		observationInFlight = observePendingMessages(force)
			.catch((error) => {
				if (!shuttingDown) {
					setOmError(describeError(error), "observe", { notify: true });
				}
				return false;
			})
			.finally(() => {
				observationInFlight = null;
				updateOmUi();
			});
		updateOmUi();
		return observationInFlight;
	}

	// ─── HOOK: session_start — Restore state ──────────────────────────────────
	pi.on("session_start", async (_event: any, ctx: any) => {
		shuttingDown = false;
		stopFooterUsagePolling();
		rememberContext(ctx);
		ensureProjectConfigBootstrap(ctx?.cwd);
		reloadRuntimeConfig(ctx?.cwd);
		for (const controller of Array.from(backgroundControllers)) {
			if (!controller.signal.aborted) {
				controller.abort(new Error("Session restarted"));
			}
		}
		backgroundControllers.clear();
		Object.assign(footerState, createFooterState());
		resetFooterRenderScheduler(true);
		footerBranchName = "";
		footerDataProviderRef = null;
		footerDataMethodNames = "";
		activeProviderName = "";
		lastFooterStatusText = undefined;
		cachedSessionFilePath = "";
		cachedSessionLabel = "";
		syncSessionLabel(ctx);
		state = createInitialState();
		lastFullMessageCount = 0;
		lastFullMessages = [];
		lastUnobservedMessages = [];
		lastUnobservedTokens = 0;
		codexQuotaProbeInFlight = null;
		codexQuotaLastSource = "";
		codexQuotaCachedSnapshot = null;
		cachedThinkingLength = "";
		cachedDefaultProvider = "";
		lastUiErrorNotificationAt = 0;
		observerAuthGetter = createAuthGetter("observer", () => config.observerModel);
		reflectorAuthGetter = createAuthGetter("reflector", () => config.reflectorModel);
		observationInFlight = null;
		reflectionInFlight = false;
		reflectionRunInFlight = null;
		observationAttemptState = null;
		reflectionAttemptState = null;
		forceObservationOnNextTurn = false;
		forceReflectionOnNextTurn = false;
		lastContextPercent = null;
		lastRuntimeContextPercent = null;
		lastEstimatedContextPercent = null;
		contextWindowSource = "config-fallback";
		activeContextWindow = config.contextWindowSize;
		lastObservationPromptSuffix = "";
		completedTurnCount = 0;
		lastReflectionCheckpointTurn = 0;
		lastReflectionCheckpointAtMs = 0;
		lastBranchEntries = [];
		lastBranchMessageEntries = [];
		sessionRolloverInFlight = false;
		pendingSessionSwitchToken = null;
		lastPendingSwitchRefreshBytes = 0;
		lastSessionFileSizeBytes = 0;
		lastProjectedHotSessionBytes = 0;
		lastRolloverReason = "";
		completedTurnCount = 0;
		lastReflectionCheckpointTurn = 0;
		lastReflectionCheckpointAtMs = 0;
		currentActivityStatus = "";
		pendingExperienceContext = null;
		clearObservationBatch();
		clearContextOverflowRecovery();
		clearOmError();

		const entries = ctx.sessionManager.getEntries();
		const loaded = loadPersistedState({ cwd: process.cwd(), entries });
		if (loaded) {
			state = loaded;
		}
		state.rawMessageCursor = getObservationCursor(state);
		computeQueueTokenTotals(state);

		let bootstrapMessages = getMessageEntries(entries)
			.map((entry) => entry.message as AgentMessage)
			.filter((message) => Boolean(message));

		if (bootstrapMessages.length === 0) {
			const sessionFilePath = String(ctx?.sessionManager?.getSessionFile?.() || "");
			if (sessionFilePath && fs.existsSync(sessionFilePath)) {
				try {
					bootstrapMessages = readSessionEntriesSync(sessionFilePath)
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message as AgentMessage)
						.filter((message) => Boolean(message));
				} catch {
					bootstrapMessages = [];
				}
			}
		}

		if (bootstrapMessages.length > 0) {
			syncRawMessageTokenEstimate(bootstrapMessages);
			lastFullMessages = bootstrapMessages;
			lastFullMessageCount = bootstrapMessages.length;
		}

		footerState.isWorktree = detectWorktree();
		let allTools: Array<{ name: string }> | undefined;
		try {
			allTools = pi.getAllTools();
			footerState.toolDefinitionTokens = estimateStringTokens(JSON.stringify(allTools));
		} catch {
			// May not be available yet
		}
		refreshMcpServerCount(allTools);
		footerState.observationTokens = state.totalObservationTokens;
		footerState.experienceTokens = state.totalExperienceTokens;
		footerState.reflectionTokens = getReflectionTokenTotal(state);
		syncReflectionArmedState();

		for (const entry of entries) {
			if ((entry as any).type === "message" && (entry as any).message?.role === "assistant") {
				const usage = (entry as any).message.usage;
				if (usage) {
					footerState.totalInput += usage.input || 0;
					footerState.totalOutput += usage.output || 0;
					footerState.totalCost += usage.cost?.total || 0;
				}
			}
		}

		refreshSessionFileMetrics(ctx);
		getProjectOmDir(process.cwd());
		getPendingSwitchDir(process.cwd());
		syncRuntimeUiState(ctx);
		refreshContextPressureSnapshot(ctx);
		syncSystemPromptTokenEstimate(ctx);

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			footerDataProviderRef = footerData;
			try {
				const ownMethods = Object.keys(footerData || {}).filter((key) => typeof (footerData as any)?.[key] === "function");
				const proto = Object.getPrototypeOf(footerData);
				const protoMethods = proto
					? Object.getOwnPropertyNames(proto).filter((key) => key !== "constructor" && typeof (footerData as any)?.[key] === "function")
					: [];
				footerDataMethodNames = Array.from(new Set([...ownMethods, ...protoMethods])).sort().join(", ");
			} catch {
				footerDataMethodNames = "";
			}
			refreshCodexQuotaFooterState(true);
			footerRequestRender = () => tui.requestRender();
			footerBranchName = footerData.getGitBranch() || "";
			footerLastRenderKey = "";
			const component = createCustomFooter(tui, theme, footerData, footerState);
			const unsubscribe = footerData.onBranchChange(() => {
				const nextBranch = footerData.getGitBranch() || "";
				if (nextBranch === footerBranchName) {
					return;
				}
				footerBranchName = nextBranch;
				requestFooterRender();
			});
			return {
				dispose: () => {
					unsubscribe();
					resetFooterRenderScheduler(false);
					footerRequestRender = null;
					footerDataProviderRef = null;
					footerDataMethodNames = "";
					component.dispose();
				},
				invalidate() {},
				render: (width: number) => component.render(width),
			};
		});
		requestFooterRender(true);
		refreshSettingsSnapshot();
		syncRuntimeUiState(ctx);
		updateOmUi();
		startFooterUsagePolling();
		await handleStartupSessionRollover(ctx);
	});

	// ─── HOOK: before_agent_start — Inject observations into system prompt ────
	pi.on("before_agent_start", (event: any, ctx: any) => {
		rememberContext(ctx);
		syncRuntimeUiState(ctx);
		const observationPromptSuffix = buildObservationPromptSuffix();
		lastObservationPromptSuffix = observationPromptSuffix;
		syncSystemPromptTokenEstimate(undefined, event.systemPrompt);

		if (!observationPromptSuffix) return undefined;
		return { systemPrompt: event.systemPrompt + observationPromptSuffix };
	});

	// ─── HOOK: context — Remove summarized prefixes + plan next oldest slice ───
	pi.on("context", async (event: any, ctx: any) => {
		rememberContext(ctx);
		const messages = event.messages;
		syncRuntimeUiState(ctx);

		let { cursorIndex } = refreshPendingContextSlice(messages);
		const thresholds = getContextThresholds();
		let outputMessages = lastUnobservedMessages;
		let outputMessagesTokens = lastUnobservedTokens;
		refreshContextPressureSnapshot(ctx);

		forceObservationOnNextTurn = shouldArmObservation({
			currentArmed: forceObservationOnNextTurn,
			effectiveContextPercent: lastContextPercent,
			thresholds,
		});
		syncReflectionArmedState(thresholds);

		const preflightObservationScheduled = false;
		const preflightObservationCompleted = false;

		syncReflectionArmedState();

		const forwarded = planForwardedContextSlice({
			unobservedMessages: lastUnobservedMessages,
			unobservedTokens: lastUnobservedTokens,
			shouldTrim:
				lastContextPercent !== null &&
				lastContextPercent > thresholds.observationTargetPercent,
			observationTargetTokens: thresholds.observationTargetTokens,
		});

		outputMessages = forwarded.messages;
		outputMessagesTokens = forwarded.messageTokens;
		if (forwarded.trimmed || forwarded.forceObservationOnNextTurn) {
			forceObservationOnNextTurn = true;

			// Footer-only UI correction: show the context slice actually forwarded this turn.
			// Keep scheduling logic based on lastContextPercent unchanged.
			footerState.contextTokens = outputMessagesTokens;
			footerState.contextPercent = computeContextPercent(outputMessagesTokens, getEffectiveContextWindow());

			appendDiagnostic(
				"warning",
				"observe",
				"Applied emergency context guardrail slice to stay under observation target",
				{
					cursorIndex,
					originalMessages: lastUnobservedMessages.length,
					originalTokens: lastUnobservedTokens,
					trimmedMessages: outputMessages.length,
					trimmedTokens: outputMessagesTokens,
					targetTokens: thresholds.observationTargetTokens,
					runtimePercent: lastRuntimeContextPercent,
					estimatedPercent: lastEstimatedContextPercent,
					effectivePercent: lastContextPercent,
					preflightObservationScheduled,
					preflightObservationCompleted,
				},
			);
		}

		lastForwardedUnobservedMessageTokens = outputMessagesTokens;
		syncRawMessageTokenEstimate(outputMessagesTokens);
		footerState.observationTokens = state.totalObservationTokens;
		footerState.experienceTokens = state.totalExperienceTokens;
		footerState.reflectionTokens = getReflectionTokenTotal(state);
		syncSystemPromptTokenEstimate(ctx);
		updateOmUi();

		if (cursorIndex === 0 && outputMessages.length === messages.length) {
			return undefined;
		}

		return { messages: outputMessages };
	});

	function kickObservation(_source: string): Promise<boolean> | null {
		return scheduleObservation(forceObservationOnNextTurn);
	}

	function kickReflection(_source: string): Promise<boolean> | null {
		syncReflectionArmedState();
		return scheduleReflection(false);
	}

	// ─── HOOK: agent_end — Observe after completed work unit (non-blocking) ───
	pi.on("agent_end", (_event: any, ctx: any) => {
		rememberContext(ctx);
		syncRuntimeUiState(ctx);
		refreshSessionFileMetrics(ctx);
		refreshCodexQuotaFooterState(true);
		void (async () => {
			const diff = await readGitDiffShortstatAsync(3000);
			if (diff) {
				const { added, removed } = diff;
				if (footerState.diffAdded !== added || footerState.diffRemoved !== removed) {
					footerState.diffAdded = added;
					footerState.diffRemoved = removed;
					requestFooterRender();
				}
			}

			if (pendingExperienceContext) {
				const appliedIds = Array.from(pendingExperienceContext.appliedIds);
				if (pendingExperienceContext.sawAssistantError && appliedIds.length > 0) {
					registerExperienceOutcome(
						pendingExperienceContext.injected.map((entry) => entry.id),
						"hurt",
						appliedIds,
						process.cwd(),
					);
				} else if (appliedIds.length > 0) {
					registerExperienceOutcome(
						pendingExperienceContext.injected.map((entry) => entry.id),
						"helped",
						appliedIds,
						process.cwd(),
					);
				} else {
					registerExperienceOutcome(
						pendingExperienceContext.injected.map((entry) => entry.id),
						"ignored",
						[],
						process.cwd(),
					);
				}
				pendingExperienceContext = null;
			}

			const observationRun = kickObservation("agent_end");
			if (observationRun) {
				try {
					await observationRun;
				} catch {
					// observation errors are already surfaced elsewhere
				}
			}

			const reflectionRun = kickReflection("agent_end");
			if (reflectionRun) {
				try {
					await reflectionRun;
				} catch {
					// reflection errors are already surfaced elsewhere
				}
			}

			const pendingSwitch = resolvePendingSwitchRecord(ctx);
			// ponytail: event ctx cannot switch sessions; keep the staged target fresh instead.
			if (pendingSwitch) {
				try {
					refreshPendingHotSession(ctx, pendingSwitch.pending, "agent_end");
				} catch (error) {
					appendDiagnostic("warning", "rollover", "Failed to refresh pending OM hot-session rollover", {
						token: pendingSwitch.token,
						error: describeAsyncError(error),
					});
				}
			} else {
				await maybeStageSessionRollover(ctx, "agent_end", false);
			}
		})();
	});

	// ─── HOOK: turn_end — second chance after long turns / multi-step loops ────
	pi.on("turn_end", (_event: any, ctx: any) => {
		rememberContext(ctx);
		syncRuntimeUiState(ctx);
		refreshSessionFileMetrics(ctx);
		completedTurnCount += 1;
		kickObservation("turn_end");
		kickReflection("turn_end");
	});

	pi.on("turn_start", (_event: any, ctx: any) => {
		rememberContext(ctx);
		syncRuntimeUiState(ctx);
	});

	// ─── HOOK: model_select — update footer/thresholds on model change ─────────
	pi.on("model_select", (event: any, ctx: any) => {
		rememberContext(ctx);
		reloadRuntimeConfig(ctx?.cwd);
		syncRuntimeUiState(ctx, event.model);
	});

	// ─── HOOK: session_before_compact — final interception before compaction ───
	pi.on("session_before_compact", async (_event: any, ctx: any) => {
		rememberContext(ctx);
		const emergencyRecovery = shouldRunContextOverflowRecovery();
		appendDiagnostic("info", "session_before_compact", "session_before_compact reached", {
			observationInFlight: Boolean(observationInFlight),
			observationCount: state.observations.length,
			reflectionCount: state.reflections.length,
			emergencyRecovery,
			contextOverflowLastError: emergencyRecovery ? contextOverflowLastError : undefined,
		});

		if (observationInFlight) {
			await observationInFlight;
		}

		if (emergencyRecovery) {
			primeEmergencyObservationBatch(EMERGENCY_OBSERVE_SCOPE_PERCENT);
		}

		let observationScheduled = false;
		let observationCompleted = false;
		const forcedObservation = scheduleObservation(true);
		if (forcedObservation) {
			observationScheduled = true;
			observationCompleted = await forcedObservation;
		}

		let reflectionScheduled = false;
		let reflectionCompleted = false;
		const forcedReflection = scheduleReflection(forceReflectionOnNextTurn);
		if (forcedReflection) {
			reflectionScheduled = true;
			reflectionCompleted = await forcedReflection;
		}

		appendDiagnostic(
			"warning",
			"session_before_compact",
			"Blocked native auto-compaction; OM requires manual compaction",
			{
				emergencyRecovery,
				observationScheduled,
				observationCompleted,
				reflectionScheduled,
				reflectionCompleted,
				cursor: getObservationCursor(state),
				batchStartIndex: lastObservationBatchStartIndex,
				batchEndIndex: lastObservationBatchEndIndex,
				contextOverflowLastError: emergencyRecovery ? contextOverflowLastError : undefined,
			},
		);

		if (emergencyRecovery) {
			clearContextOverflowRecovery();
		}

		if (observationCompleted) {
			notifyOm(
				"Auto-compaction blocked by OM. Observation finished. Retry your last request. Use /om compact for manual compaction.",
				"info",
				true,
			);
		} else if (observationScheduled) {
			notifyOm(
				"Auto-compaction blocked by OM. Observation ran but produced no new memory. Retry your last request or run /om observe.",
				"warning",
				true,
			);
		} else {
			notifyOm(
				"Auto-compaction blocked by OM. No observation batch was available. Run /om observe (or /om reset), then retry.",
				"warning",
				true,
			);
		}

		return { cancel: true };
	});

	// ─── HOOK: message_end — Update footer stats after each assistant message ──
	pi.on("message_end", (event: any, ctx: any) => {
		rememberContext(ctx);
		const msg = event.message;
		if (msg.role === "assistant" && (msg as any).usage) {
			const usage = (msg as any).usage;
			footerState.totalInput += usage.input || 0;
			footerState.totalOutput += usage.output || 0;
			footerState.totalCost += usage.cost?.total || 0;
		}

		if (msg.role === "assistant") {
			if (pendingExperienceContext) {
				const toolNames = Array.isArray(msg.content)
					? msg.content
						.filter((part: any) => part?.type === "toolCall" && typeof part?.name === "string")
						.map((part: any) => String(part.name).trim().toLowerCase())
					: [];
				for (const injected of pendingExperienceContext.injected) {
					if (injected.toolNames.some((toolName) => toolNames.includes(toolName))) {
						pendingExperienceContext.appliedIds.add(injected.id);
					}
				}
			}

			if ((msg as any).stopReason === "error") {
				if (pendingExperienceContext) {
					pendingExperienceContext.sawAssistantError = true;
				}
				const errorMessage = String((msg as any).errorMessage || "");
				if (isContextLengthExceededError(errorMessage)) {
					markContextOverflowRecovery(errorMessage);
					forceObservationOnNextTurn = true;
					const primed = primeEmergencyObservationBatch(EMERGENCY_OBSERVE_SCOPE_PERCENT);
					appendDiagnostic(
						"warning",
						"observe",
						"Detected context overflow; triggering emergency oldest-first observation",
						{
							error: truncateInline(errorMessage, 240),
							emergencyScopePercent: Math.max(EMERGENCY_OBSERVE_SCOPE_PERCENT, config.rawMessages.oldestScopePercent),
							primedBatch: primed,
							batchStartIndex: lastObservationBatchStartIndex,
							batchEndIndex: lastObservationBatchEndIndex,
							batchMessages: lastObservationBatchMessages.length,
							batchTokens: lastObservationBatchTokens,
						},
					);
					notifyOm(
						"Context window exceeded — OM is summarizing the oldest history now. Auto-compaction stays blocked; retry after observation.",
						"warning",
						true,
					);
					void scheduleObservation(true);
				}
			}
		}

		syncRuntimeUiState(ctx);
		refreshContextPressureSnapshot(ctx);
		syncRawMessageTokenEstimate(lastForwardedUnobservedMessageTokens);
		footerState.observationTokens = state.totalObservationTokens;
		footerState.experienceTokens = state.totalExperienceTokens;
		footerState.reflectionTokens = getReflectionTokenTotal(state);
		syncReflectionArmedState();
		syncSystemPromptTokenEstimate(ctx);
		updateOmUi();
	});

	// ─── HOOK: session_shutdown — abort background work and clear UI ───────────
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		rememberContext(ctx);
		shuttingDown = true;
		stopFooterUsagePolling();
		appendDiagnostic("info", "session_shutdown", "Session shutting down; aborting background OM work");
		for (const controller of Array.from(backgroundControllers)) {
			if (!controller.signal.aborted) {
				controller.abort(new Error("Session shutting down"));
			}
		}
		backgroundControllers.clear();
		observationInFlight = null;
		reflectionInFlight = false;
		reflectionRunInFlight = null;
		observationAttemptState = null;
		reflectionAttemptState = null;
		forceObservationOnNextTurn = false;
		forceReflectionOnNextTurn = false;
		lastContextPercent = null;
		lastRuntimeContextPercent = null;
		lastEstimatedContextPercent = null;
		contextWindowSource = "config-fallback";
		activeContextWindow = config.contextWindowSize;
		lastObservationPromptSuffix = "";
		completedTurnCount = 0;
		lastReflectionCheckpointTurn = 0;
		lastReflectionCheckpointAtMs = 0;
		lastBranchEntries = [];
		lastBranchMessageEntries = [];
		pendingExperienceContext = null;
		pendingSessionSwitchToken = null;
		lastPendingSwitchRefreshBytes = 0;
		currentActivityStatus = "";
		lastFullMessages = [];
		codexQuotaProbeInFlight = null;
		codexQuotaLastSource = "";
		clearContextOverflowRecovery();
		clearObservationBatch();
		resetFooterRenderScheduler(true);
		footerRequestRender = null;
		footerDataProviderRef = null;
		footerDataMethodNames = "";
		footerBranchName = "";
		activeProviderName = "";
		cachedThinkingLength = "";
		cachedDefaultProvider = "";
		updateOmUi();
		try {
			ctx.ui.setStatus("observational-memory", undefined as any);
		} catch {
			try {
				ctx.ui.setStatus("");
			} catch {
				// ignore
			}
		}
		lastFooterStatusText = undefined;
		currentCtx = null;
	});

	// ─── COMMANDS: /om ──────────────────────────────────────────────────────────
	pi.registerCommand("om", {
		description: "Inspect or manage observational memory. Usage: /om [status|show|observe|reset|compact|rollover|switch|replay|experiences|compare]",
		handler: async (args: any, ctx: any) => {
			rememberContext(ctx);
			const commandArgs = String(args || "").trim();
			const [sub = "status", ...restArgs] = commandArgs ? commandArgs.split(/\s+/) : ["status"];
			const switchTokenArg = restArgs[0] || "";

			if (sub === "status") {
				const pendingSwitch = resolvePendingSwitchRecord(ctx);
				try {
					const sessionFilePath = String(ctx?.sessionManager?.getSessionFile?.() || "");
					if (sessionFilePath && fs.existsSync(sessionFilePath)) {
						lastSessionFileSizeBytes = fs.statSync(sessionFilePath).size;
					}
				} catch {
					// ignore size refresh failures
				}
				syncRuntimeUiState(ctx);
				refreshContextPressureSnapshot(ctx);
				const thresholds = getContextThresholds();
				const contextSource =
					contextWindowSource === "model"
						? "model metadata"
						: contextWindowSource === "usage"
							? "runtime usage"
							: "config fallback";
				const liveSystemPrompt = typeof ctx?.getSystemPrompt === "function"
					? String(ctx.getSystemPrompt() || "")
					: "";
				const baseSystemPrompt = stripObservationPromptSuffix(liveSystemPrompt);
				const baseSystemPromptTokens = estimateStringTokens(baseSystemPrompt);
				const omPromptSuffix = buildObservationPromptSuffix();
				const omInjectedPromptTokens = estimateStringTokens(omPromptSuffix);
				const effectiveSystemPromptTokens = baseSystemPromptTokens + omInjectedPromptTokens;
				await ctx.ui.notify(
					[
						"Observational Memory Status",
						`  Enabled: ${config.enabled}`,
						`  Compression strategy: ${getCompressionStrategy()}`,
						`  Cache optimization: ${config.cacheOptimization.enabled ? "on" : "off"} (cap ${config.cacheOptimization.maxPromptContextPercent}%, snapshot ${config.cacheOptimization.snapshotTokenBudget} tok, active tail ${config.cacheOptimization.activeTailTokenBudget} tok)`,
						`  Active model: ${footerState.modelName || "unknown"}`,
						`  Active provider: ${(activeProviderName || resolveDefaultProviderFromSettings() || config.observerModel.provider || "unknown")}`,
						`  Thinking: ${footerState.thinkingLevel}${footerState.thinkingLength ? `/${footerState.thinkingLength}` : ""}`,
						`  Usage account: ${footerState.codexAccountName || "unknown"}`,
						`  Usage source: ${codexQuotaLastSource || "none"}`,
						`  FooterData methods: ${footerDataMethodNames ? truncateInline(footerDataMethodNames, 120) : "unknown"}`,
						`  Extension statuses: ${truncateInline(summarizeExtensionStatuses(footerDataProviderRef) || "none", 140)}`,
						`  Usage windows: 5h=${typeof footerState.codex5hRemainingPercent === "number" ? `${Math.round(footerState.codex5hRemainingPercent)}%` : "--"}${footerState.codex5hResetAtMs ? ` (${formatResetCountdown(footerState.codex5hResetAtMs)})` : ""}, 7d=${typeof footerState.codex7dRemainingPercent === "number" ? `${Math.round(footerState.codex7dRemainingPercent)}%` : "--"}${footerState.codex7dResetAtMs ? ` (${formatResetCountdown(footerState.codex7dResetAtMs)})` : ""}`,
						`  Footer usage poll interval: ${config.footerUsagePollIntervalMs > 0 ? `${config.footerUsagePollIntervalMs}ms` : "disabled"}`,
						`  Context window source: ${contextSource}`,
						`  System prompt tokens (base): ~${baseSystemPromptTokens}`,
						`  OM injected prompt tokens: ~${omInjectedPromptTokens}`,
						`  Effective system prompt tokens (base+OM): ~${effectiveSystemPromptTokens}`,
						`  Footer composition buckets: sys=~${footerState.systemPromptTokens}, tools=~${footerState.toolDefinitionTokens}, obs=~${footerState.observationTokens}, exp=~${footerState.experienceTokens}, ref=~${footerState.reflectionTokens}, raw=~${footerState.rawMessageTokens}`,
						`  Generation: ${state.generationCount}`,
						`  Observations: ${state.observations.length} item(s) / ~${state.totalObservationTokens} tokens`,
						`  Reflections: ${state.reflections.length} item(s) / ~${getReflectionTokenTotal(state)} tokens`,
						`  Experiences: ${state.experiences.length} in state / ${listExperienceRecords(process.cwd()).length} banked`,
						`  Cursor: message index ${state.rawMessageCursor}`,
						`  Full session messages: ${lastFullMessageCount}`,
						`  Remaining messages (after cursor): ${lastUnobservedMessages.length}`,
						`  Remaining tokens (estimate): ~${lastUnobservedTokens}`,
						`  Pending observation batch: ${hasObservationBatch() ? `${lastObservationBatchMessages.length} msg / ~${lastObservationBatchTokens} tok (${lastObservationBatchStartIndex}→${lastObservationBatchEndIndex})` : "none"}`,
						`  Context usage runtime: ${lastRuntimeContextPercent !== null ? `${Math.round(lastRuntimeContextPercent)}%` : "unknown"}`,
						`  Context usage estimate: ${lastEstimatedContextPercent !== null ? `${Math.round(lastEstimatedContextPercent)}%` : "unknown"}`,
						`  Context usage effective: ${lastContextPercent !== null ? `${Math.round(lastContextPercent)}%` : "unknown"}`,
						`  Observation in flight: ${observationInFlight ? "yes" : "no"}`,
						`  Reflection in flight: ${reflectionInFlight ? "yes" : "no"}`,
						`  Observe armed: ${forceObservationOnNextTurn ? "yes" : "no"}`,
						`  Reflect armed: ${forceReflectionOnNextTurn ? "yes" : "no"}`,
						`  Reflection checkpoint cadence: ${config.cacheOptimization.minCheckpointTurns} turns / ${config.cacheOptimization.minCheckpointMs}ms`,
						`  Turns since checkpoint: ${Math.max(0, completedTurnCount - lastReflectionCheckpointTurn)}`,
						`  Last observed: ${state.lastObservedTimestamp || "never"}`,
						`  Observe trigger: ${thresholds.observationTriggerPercent}% (~${thresholds.observationTriggerTokens} tokens)`,
						`  Observe target: ${thresholds.observationTargetPercent}% (~${thresholds.observationTargetTokens} tokens)`,
						`  Hot session bytes: ${lastSessionFileSizeBytes || 0}`,
						`  OM state file: ${getStatePath()}`,
						`  OM diagnostic log: ${getDiagnosticLogPath(process.cwd())}`,
						`  Projected hot bytes after rollover: ${lastProjectedHotSessionBytes || 0}`,
						`  Last rollover reason: ${lastRolloverReason || "none"}`,
						`  Pending session switch token: ${pendingSessionSwitchToken || pendingSwitch?.token || "none"}`,
						`  Pending hot session target: ${pendingSwitch?.pending?.targetSessionPath || "none"}`,
						`  Pending switch action: ${pendingSwitch ? "/om switch" : "none"}`,
						`  Session rollover warn/target/hard: ${config.sessionRollover.warnBytes}/${config.sessionRollover.targetBytes}/${config.sessionRollover.hardBytes}`,
						`  Oversized entry limit: ${config.oversizedEntries.entryBytes} bytes`,
						`  Archive chunk target/max: ${config.archive.targetChunkBytes}/${config.archive.maxChunkBytes}`,
						`  Experience bank enabled: ${config.experienceBank.enabled}`,
						`  Experience records: ${listExperienceRecords(process.cwd()).length}`,
						`  Observe scope: oldest ~${config.rawMessages.oldestScopePercent}% of context window from raw messages`,
						`  Preserve recent messages: ${config.preserveRecentMessages}`,
						`  Min observation batch: ${config.minObservationMessages} messages`,
						`  Observation→reflection trigger: observations >= ${thresholds.reflectionTriggerPercent}% (~${thresholds.reflectionTriggerTokens} tokens)`,
						`  Reflection refresh trigger: reflections >= ${thresholds.reflectionRefreshTriggerPercent}% (~${thresholds.reflectionRefreshTriggerTokens} tokens)`,
						`  Reflection archive to MEMORY.md: ${config.reflections.archiveOldToMemoryMd ? `on (${config.reflections.memoryMdPath})` : "off"}`,
						`  Reflection archive threshold/placeholders: ${config.reflections.archiveThresholdPercent}% / ${config.reflections.archivePlaceholderTokenBudget} tokens`,
						`  Observer prompt limit: ${config.observerPromptTokenLimit} tokens`,
						`  Reflector prompt limit: ${config.reflectorPromptTokenLimit} tokens`,
						`  Observer timeout: ${config.observerTimeoutMs}ms`,
						`  Reflector timeout: ${config.reflectorTimeoutMs}ms`,
						`  Observer attempts: ${config.observerMaxAttempts}`,
						`  Reflector attempts: ${config.reflectorMaxAttempts}`,
						`  Last OM error: ${lastOmError || "none"}`,
						`  Last OM error phase: ${lastOmErrorPhase || "none"}`,
						`  Last OM error at: ${lastOmErrorAt || "never"}`,
						`  Context-overflow recovery pending: ${contextOverflowRecoveryPending ? "yes" : "no"}`,
						`  Last overflow error: ${contextOverflowLastError || "none"}`,
					].join("\n"),
				);
			} else if (sub === "show") {
				const output: string[] = [];
				const reflectionText = getReflectionText(state);
				const observationText = getObservationText(state);
				if (reflectionText) {
					output.push("=== REFLECTIONS ===", reflectionText, "");
				}
				if (observationText) {
					output.push("=== OBSERVATIONS ===", observationText, "");
				}
				if (state.experiences.length > 0) {
					output.push("=== EXPERIENCES ===", state.experiences.map((item) => `- [${item.id}] ${item.text}`).join("\n"));
				}
				await ctx.ui.notify(output.length > 0 ? output.join("\n") : "(no observations yet)");
			} else if (sub === "observe") {
				if (observationInFlight) {
					await ctx.ui.notify("Observation already running — waiting for current run to finish...", "info");
					const ok = await observationInFlight;
					if (ok) {
						await ctx.ui.notify("Observation run complete.", "info");
					} else {
						await ctx.ui.notify("Observation run finished without new memory.", "warning");
					}
					return;
				}

				const fullMessages = lastFullMessages.length > 0 ? lastFullMessages : lastUnobservedMessages;
				if (fullMessages.length === 0 || lastUnobservedMessages.length === 0) {
					await ctx.ui.notify(
						"No pending message slice is available yet. Ask one more turn, then run /om observe again.",
						"warning",
					);
					return;
				}

				const rawCursorIndex = Math.min(getObservationCursor(state), fullMessages.length);
				const cursorIndex = alignCursorToToolCallPairs(fullMessages, rawCursorIndex);
				const manualBatch = computeSafeObservationBatchFromCursor(fullMessages, cursorIndex);
				if (manualBatch) {
					lastObservationBatchMessages = manualBatch.messages;
					lastObservationBatchTokens = manualBatch.tokens;
					lastObservationBatchStartIndex = manualBatch.startIndex;
					lastObservationBatchEndIndex = manualBatch.endIndex;
				}

				forceObservationOnNextTurn = true;
				const batchLabel = hasObservationBatch()
					? `${lastObservationBatchMessages.length} msg / ~${lastObservationBatchTokens} tok (${lastObservationBatchStartIndex}→${lastObservationBatchEndIndex})`
					: "computed on demand";
				await ctx.ui.notify(`Triggering manual observation for oldest pending slice (${batchLabel})...`, "info");

				const run = scheduleObservation(true);
				if (!run) {
					await ctx.ui.notify("Observation could not be scheduled right now.", "warning");
					return;
				}

				const ok = await run;
				if (!ok) {
					await ctx.ui.notify("Observation completed with no new memory output.", "warning");
					return;
				}

				await ctx.ui.notify(
					[
						"Manual observation complete.",
						`  Cursor: ${state.rawMessageCursor}`,
						`  Observation items/tokens: ${state.observations.length} / ~${state.totalObservationTokens}`,
						`  Reflection items/tokens: ${state.reflections.length} / ~${getReflectionTokenTotal(state)}`,
					].join("\n"),
					"info",
				);
			} else if (sub === "reset") {
				for (const controller of Array.from(backgroundControllers)) {
					if (!controller.signal.aborted) {
						controller.abort(new Error("Observational memory reset"));
					}
				}
				backgroundControllers.clear();
				state = createInitialState();
				try {
					fs.rmSync(path.join(getProjectOmDir(process.cwd()), "experiences"), { recursive: true, force: true });
				} catch {
					// ignore best-effort cleanup
				}
				lastFullMessageCount = 0;
				lastFullMessages = [];
				lastUnobservedMessages = [];
				lastUnobservedTokens = 0;
				codexQuotaProbeInFlight = null;
				codexQuotaLastSource = "";
				codexQuotaCachedSnapshot = null;
				clearContextOverflowRecovery();
				observationInFlight = null;
				reflectionInFlight = false;
				reflectionRunInFlight = null;
				observationAttemptState = null;
				reflectionAttemptState = null;
				forceObservationOnNextTurn = false;
				forceReflectionOnNextTurn = false;
				lastContextPercent = null;
				lastRuntimeContextPercent = null;
				lastEstimatedContextPercent = null;
				contextWindowSource = "config-fallback";
				activeContextWindow = config.contextWindowSize;
				lastObservationPromptSuffix = "";
				completedTurnCount = 0;
				lastReflectionCheckpointTurn = 0;
				lastReflectionCheckpointAtMs = 0;
				clearObservationBatch();
				footerState.contextPercent = null;
				footerState.contextTokens = null;
				footerState.contextWindow = activeContextWindow;
				footerState.observationTokens = 0;
				footerState.experienceTokens = 0;
				footerState.reflectionTokens = 0;
				resetFooterRenderScheduler(true);
				clearOmError();
				requestFooterRender(true);
				persistState(pi, state, "manual_reset");
				appendDiagnostic("info", "manual_reset", "Observational memory reset by user");
				await ctx.ui.notify("Observational memory reset.", "info");
			} else if (sub === "switch") {
				await runPendingSessionSwitch(ctx, switchTokenArg);
			} else if (sub === "compact") {
				if (!hasObservationItems(state) && !hasReflectionItems(state)) {
					await ctx.ui.notify("Nothing to compact — no observations or reflections.");
					return;
				}
				await ctx.ui.notify(`Compacting observations/reflections (~${state.totalObservationTokens + getReflectionTokenTotal(state)} tokens)...`);
				try {
					const reflectionRun = scheduleReflection(true, true);
					const compacted = reflectionRun ? await reflectionRun : false;
					if (!compacted) {
						await ctx.ui.notify("Compaction skipped — no reflection was needed.", "info");
						return;
					}
					await ctx.ui.notify(
						[
							"Compaction complete.",
							`  Generation: ${state.generationCount}`,
							`  Reflections: ${state.reflections.length} / ~${getReflectionTokenTotal(state)}`,
							`  Observations: ${state.observations.length} / ~${state.totalObservationTokens}`,
						].join("\n"),
					);
				} catch (err) {
					setOmError(describeError(err), "reflect", { notify: false });
					await ctx.ui.notify(`Compaction failed: ${err instanceof Error ? err.message : err}`, "error");
				}
			} else if (sub === "rollover") {
				await maybeStageSessionRollover(ctx, "manual", true);
				if (pendingSessionSwitchToken) {
					await ctx.ui.notify("Prepared hot-session rollover. Run /om switch to continue in the compact session.", "info");
				} else {
					await ctx.ui.notify("OM rollover was not needed or could not be prepared.", "warning");
				}
			} else if (sub === "replay") {
				if (typeof ctx?.waitForIdle === "function") {
					await ctx.waitForIdle();
				}
				const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || [];
				await openOmReplayOverlay(ctx, entries, {
					sessionName: resolveSessionLabel(ctx),
					sessionFilePath: String(ctx?.sessionManager?.getSessionFile?.() || ""),
					contextUsage: ctx?.getContextUsage?.() || undefined,
					omMessageStartIndex: getObservationCursor(state),
				});
			} else if (sub === "experiences") {
				const experiences = listExperienceRecords(process.cwd())
					.sort((a, b) => b.score - a.score)
					.slice(0, 25);
				if (experiences.length === 0) {
					await ctx.ui.notify("No OM experiences have been recorded yet.", "info");
					return;
				}
				await ctx.ui.notify(
					[
						"OM Experiences",
						...experiences.map((record) => `  ${record.id} [${record.status}/${record.rank}] score=${record.score} :: ${truncateInline(record.text, 120)}`),
					].join("\n"),
					"info",
				);
			} else if (sub === "compare") {
				if (!reflectorAuthGetter) {
					await ctx.ui.notify("OM compare unavailable: reflector auth is not initialized yet. Restart session and retry.", "error");
					return;
				}

				const rawArgs = commandArgs.slice(sub.length).trim();
				let compareArgs;
				try {
					const fallbackSessionPath = String(ctx?.sessionManager?.getSessionFile?.() || "");
					compareArgs = parseOmCompareArgs(rawArgs, fallbackSessionPath);
				} catch (error) {
					await ctx.ui.notify(`Compare argument error: ${error instanceof Error ? error.message : String(error)}`, "error");
					await ctx.ui.notify("Usage: /om compare [--session <path>] [--samples <n>] [--min-tokens <n>] [--timeout-ms <n>] [--prompt-limit <n>] [--report <path>]", "info");
					return;
				}

				await ctx.ui.notify(
					`Running OM comparison on real session data (${compareArgs.sampleCount} samples, min ${compareArgs.minInputTokens} tokens, timeout ${compareArgs.timeoutMs || Math.max(config.reflectorTimeoutMs, 120000)}ms)...`,
					"info",
				);
				try {
					const report = await runCompressionComparisonOnSession({
						sessionPath: compareArgs.sessionPath,
						config,
						getAuth: reflectorAuthGetter,
						getObserverAuth: observerAuthGetter || reflectorAuthGetter,
						sampleCount: compareArgs.sampleCount,
						minInputTokens: compareArgs.minInputTokens,
						timeoutMs: compareArgs.timeoutMs,
						promptTokenLimit: compareArgs.promptTokenLimit,
						onProgress: (message) => {
							currentActivityStatus = message;
							updateOmUi();
						},
					});
					const output = writeComparisonReport(report, {
						cwd: process.cwd(),
						reportPath: compareArgs.reportPath,
					});
					currentActivityStatus = "";
					updateOmUi();

					const reflectorAgg = report.aggregate.reflector;
					const cavemanAgg = report.aggregate.caveman;
					const reobserveAgg = report.aggregate.reobserve;
					await ctx.ui.notify(
						[
							"OM Compression Comparison Complete",
							`  Samples: ${report.samples.length}`,
							`  Reflector median reduction/lossiness: ${reflectorAgg.medianTokenReductionPercent.toFixed(1)}% / ${reflectorAgg.medianLossinessPercentEstimate.toFixed(1)}%`,
							`  Caveman median reduction/lossiness: ${cavemanAgg.medianTokenReductionPercent.toFixed(1)}% / ${cavemanAgg.medianLossinessPercentEstimate.toFixed(1)}%`,
							`  Re-observe median reduction/lossiness: ${reobserveAgg.medianTokenReductionPercent.toFixed(1)}% / ${reobserveAgg.medianLossinessPercentEstimate.toFixed(1)}%`,
							`  Recommendation: ${report.decisionMatrix.recommendation}`,
							`  Reason: ${report.decisionMatrix.reason}`,
							`  JSON report: ${output.jsonPath}`,
							`  Markdown matrix: ${output.markdownPath}`,
						].join("\n"),
						"info",
					);
				} catch (error) {
					currentActivityStatus = "";
					updateOmUi();
					await ctx.ui.notify(`OM compare failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} else {
				await ctx.ui.notify("Usage: /om [status|show|observe|reset|compact|rollover|switch|replay|experiences|compare]");
			}
		},
	});
}

// =============================================================================
// Helpers
// =============================================================================

function persistState(
	_pi: ExtensionAPI,
	state: ObservationState,
	_eventType: ObservationStateEntry["eventType"],
): void {
	computeQueueTokenTotals(state);
	saveStateToFile(getStatePath(), state);
}
