import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
	ObservationState,
	ObservationStateEntry,
	ObservationDiagnosticEntry,
	ObservationStateMeta,
} from "./types";
import { CUSTOM_ENTRY_TYPE } from "./types";
import { createInitialOmState, normalizeOmState, serializeOmState } from "./memory-queues";

export const OBSERVATION_STATE_SCHEMA_VERSION = 2;

export function createInitialState(): ObservationState {
	return createInitialOmState();
}

function normalizeMeta(meta: any): ObservationStateMeta | undefined {
	if (!meta || typeof meta !== "object") return undefined;
	return {
		schemaVersion:
			typeof meta.schemaVersion === "number"
				? meta.schemaVersion
				: OBSERVATION_STATE_SCHEMA_VERSION,
		workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : "",
		sessionId: typeof meta.sessionId === "string" ? meta.sessionId : "",
		modelId: typeof meta.modelId === "string" ? meta.modelId : "",
		contextWindow:
			typeof meta.contextWindow === "number" && Number.isFinite(meta.contextWindow)
				? meta.contextWindow
				: 0,
		systemPromptHash: typeof meta.systemPromptHash === "string" ? meta.systemPromptHash : "",
		createdAt: typeof meta.createdAt === "string" ? meta.createdAt : "",
		updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : "",
	};
}

function normalizeState(raw: any): ObservationState | null {
	const normalized = normalizeOmState(raw);
	if (!normalized) return null;
	normalized.meta = normalizeMeta(raw?.meta);
	return normalized;
}

export function getWorkspaceId(cwd?: string): string {
	let dir = cwd || process.cwd();
	try {
		dir = fs.realpathSync(dir);
	} catch {
		dir = path.resolve(dir);
	}
	if (process.platform === "win32") {
		dir = dir.toLowerCase();
	}
	return dir;
}

export function loadStateFromSessionEntries(entries: any[]): ObservationState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.customType === CUSTOM_ENTRY_TYPE && entry?.data?.state) {
			return normalizeState(entry.data.state);
		}
	}
	return null;
}

export function getStatePath(cwd?: string): string {
	const dir = cwd || process.cwd();
	const safePath = `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(os.homedir(), ".pi", "agent", "extensions", "observational-memory", safePath, "state.json");
}

export function loadStateFromFile(filePath: string): ObservationState | null {
	try {
		if (fs.existsSync(filePath)) {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			return normalizeState(raw);
		}
	} catch {
		// ignore malformed backup state
	}
	return null;
}

export function saveStateToFile(filePath: string, state: ObservationState): void {
	try {
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmpPath = filePath + ".tmp";
		fs.writeFileSync(tmpPath, JSON.stringify(serializeOmState(state), null, 2), "utf-8");
		fs.renameSync(tmpPath, filePath);
	} catch {
		// best-effort backup only
	}
}

export function createStateEntry(
	eventType: ObservationStateEntry["eventType"],
	state: ObservationState,
): ObservationStateEntry {
	return {
		version: 1,
		eventType,
		state: serializeOmState(state),
		timestamp: new Date().toISOString(),
	};
}

export function createDiagnosticEntry(
	level: ObservationDiagnosticEntry["level"],
	phase: ObservationDiagnosticEntry["phase"],
	message: string,
	details?: Record<string, unknown>,
): ObservationDiagnosticEntry {
	return {
		version: 1,
		level,
		phase,
		message,
		timestamp: new Date().toISOString(),
		...(details ? { details } : {}),
	};
}
