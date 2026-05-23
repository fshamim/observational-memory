export type ParsedCodexQuotaStatus = {
	accountName?: string;
	remaining5hPercent?: number | null;
	remaining7dPercent?: number | null;
	reset5hAtMs?: number | null;
	reset7dAtMs?: number | null;
};

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const STATUS_SEPARATOR_RE = /\s*[·|]\s*/;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function normalizePercent(value: string, mode?: string): number | null {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return null;
	const clamped = Math.max(0, Math.min(100, parsed));
	if (mode?.trim().toLowerCase() === "used") {
		return 100 - clamped;
	}
	return clamped;
}

function parseDurationMs(text: string): number | null {
	let totalMs = 0;
	let matched = false;
	for (const match of text.matchAll(/(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)(?=\s|\d|$)/gi)) {
		const value = Number.parseInt(match[1], 10);
		if (!Number.isFinite(value)) continue;
		const unit = match[2].toLowerCase();
		matched = true;
		if (unit.startsWith("d")) totalMs += value * 24 * 60 * 60 * 1000;
		else if (unit.startsWith("h")) totalMs += value * 60 * 60 * 1000;
		else if (unit.startsWith("m")) totalMs += value * 60 * 1000;
		else totalMs += value * 1000;
	}
	return matched ? totalMs : null;
}

function parseResetAtMs(text: string | undefined, now: number): number | null {
	if (!text) return null;
	const durationMs = parseDurationMs(text.replace(/^\s*↺\s*/u, "").trim());
	return typeof durationMs === "number" ? now + durationMs : null;
}

function parseWindow(
	text: string,
	label: "5h" | "7d",
	now: number,
): { remainingPercent?: number | null; resetAtMs?: number | null } | null {
	const match = text.match(new RegExp(`\\b${label}\\s*[:=]\\s*([0-9]{1,3})\\s*%\\s*(left|used)?(?:\\s*\\(([^)]*)\\))?`, "i"));
	if (!match) return null;
	return {
		remainingPercent: normalizePercent(match[1], match[2]),
		resetAtMs: parseResetAtMs(match[3], now),
	};
}

export function parseCodexQuotaStatusText(text: string, now = Date.now()): ParsedCodexQuotaStatus | null {
	const normalized = stripAnsi(text).replace(/\s+/g, " ").trim();
	if (!normalized || !/\bCodex\b/i.test(normalized)) return null;

	const patch: ParsedCodexQuotaStatus = {};
	const accountMatch = normalized.match(/\bCodex\b\s*[·|]\s*([^·|]+?)\s*[·|]\s*(?:5h|7d)\s*[:=]/i);
	if (accountMatch?.[1]?.trim()) {
		patch.accountName = accountMatch[1].trim();
	}

	const fiveHour = parseWindow(normalized, "5h", now);
	if (fiveHour) {
		patch.remaining5hPercent = fiveHour.remainingPercent ?? null;
		patch.reset5hAtMs = fiveHour.resetAtMs ?? null;
	}

	const sevenDay = parseWindow(normalized, "7d", now);
	if (sevenDay) {
		patch.remaining7dPercent = sevenDay.remainingPercent ?? null;
		patch.reset7dAtMs = sevenDay.resetAtMs ?? null;
	}

	if (!patch.accountName) {
		const segments = normalized.split(STATUS_SEPARATOR_RE).map((segment) => segment.trim()).filter(Boolean);
		const codexIndex = segments.findIndex((segment) => /^Codex$/i.test(segment));
		if (codexIndex >= 0) {
			const candidate = segments[codexIndex + 1];
			if (candidate && !/^([57]d|[57]h)\s*[:=]/i.test(candidate)) {
				patch.accountName = candidate;
			}
		}
	}

	const hasUsage =
		typeof patch.remaining5hPercent === "number" ||
		typeof patch.remaining7dPercent === "number";
	return hasUsage || patch.accountName ? patch : null;
}
