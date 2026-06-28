/**
 * Custom 2-3 line footer for pi-coding-agent with context visualization,
 * git info, observational memory awareness, and pass-through extension statuses.
 *
 * Line 1: model + context meter + context composition legend (sys/tools/exp/obs/ref/msg)
 * Line 2: cwd/branch/diff + OM status
 * Line 3: other extension statuses (when present)
 *
 * Uses Nerd Font icons — ensure your terminal font supports them.
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

// =============================================================================
// Footer State — mutated by index.ts hooks, read by render()
// =============================================================================

export interface FooterState {
	// Token & cost accumulators (kept for compatibility with existing hooks)
	totalInput: number;
	totalOutput: number;
	totalCost: number;

	// Model
	modelName: string;
	thinkingLevel: string;
	thinkingLength: string;

	// Context
	contextPercent: number | null;
	contextWindow: number;
	contextTokens: number | null;
	sessionLabel: string;

	// System prompt estimate
	systemPromptTokens: number;

	// Tool/skill definition tokens in context
	toolDefinitionTokens: number;

	// OM tokens (from ObservationState)
	observationTokens: number;
	experienceTokens: number;
	reflectionTokens: number;
	// Non-observed raw message tail used in current context batch.
	rawMessageTokens: number;
	omStatus: string;
	omError: string;

	// Codex account/limits status (optional; populated from external state)
	codexAccountName: string;
	codexPlanType: string;
	codex5hRemainingPercent: number | null;
	codex7dRemainingPercent: number | null;
	codex5hResetAtMs: number | null;
	codex7dResetAtMs: number | null;

	// MCP
	mcpServerCount: number;

	// Git diff
	diffAdded: number;
	diffRemoved: number;

	// Worktree
	isWorktree: boolean;
}

export function createFooterState(): FooterState {
	return {
		totalInput: 0,
		totalOutput: 0,
		totalCost: 0,
		modelName: "",
		thinkingLevel: "off",
		thinkingLength: "",
		contextPercent: null,
		contextWindow: 0,
		contextTokens: null,
		sessionLabel: "",
		systemPromptTokens: 0,
		toolDefinitionTokens: 0,
		observationTokens: 0,
		experienceTokens: 0,
		reflectionTokens: 0,
		rawMessageTokens: 0,
		omStatus: "",
		omError: "",
		codexAccountName: "",
		codexPlanType: "",
		codex5hRemainingPercent: null,
		codex7dRemainingPercent: null,
		codex5hResetAtMs: null,
		codex7dResetAtMs: null,
		mcpServerCount: 0,
		diffAdded: 0,
		diffRemoved: 0,
		isWorktree: false,
	};
}

// =============================================================================
// Nerd Font Icons
// =============================================================================

const ICON = {
	model: "\uf1b2",      //  — cube (model)
	branch: "\ue725",     //  — git branch
	folder: "\uf07b",     //  — folder
	network: "\uf0ac",    //  — globe (MCP)
	memory: "\uf085",     //  — cogs (observations)
	diff: "\uf040",       //  — pencil
};

// =============================================================================
// ANSI 256-color helper
// =============================================================================

function fg256(color: number, text: string): string {
	return `\x1b[38;5;${color}m${text}\x1b[39m`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\x00-\x1F\x7F]/g, "")
		.replace(/ +/g, " ")
		.trim();
}

// =============================================================================
// Formatting helpers
// =============================================================================

interface Composition {
	sys: number;
	tools: number;
	exp: number;
	obs: number;
	ref: number;
	msg: number;
	total: number;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
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

function compactInline(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

function shortenModel(modelId: string, max = 24): string {
	const clean = modelId.trim();
	if (!clean) return "?";
	if (clean.length <= max) return clean;
	const keep = Math.max(4, Math.floor((max - 1) / 2));
	return `${clean.slice(0, keep)}…${clean.slice(-keep)}`;
}

function fitSegmentsWithOverflow(
	segments: string[],
	separator: string,
	budget: number,
	overflowSegment: (omitted: number) => string,
): string {
	if (budget <= 0 || segments.length === 0) return "";
	let out = "";

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const candidate = out ? `${out}${separator}${seg}` : seg;

		if (visibleWidth(candidate) <= budget) {
			out = candidate;
			continue;
		}

		const omitted = segments.length - i;
		const overflow = overflowSegment(omitted);
		if (!out) return visibleWidth(overflow) <= budget ? overflow : "";

		const withOverflow = `${out}${separator}${overflow}`;
		if (visibleWidth(withOverflow) <= budget) return withOverflow;
		return out;
	}

	return out;
}

function deriveComposition(state: FooterState): Composition {
	const rawSys = Math.max(0, state.systemPromptTokens);
	const rawTools = Math.max(0, state.toolDefinitionTokens);
	const rawExp = Math.max(0, state.experienceTokens);
	const rawObs = Math.max(0, state.observationTokens);
	const rawRef = Math.max(0, state.reflectionTokens);
	const rawMsg = Math.max(0, state.rawMessageTokens);
	const known = rawSys + rawTools + rawExp + rawObs + rawRef + rawMsg;

	const targetTotal = state.contextTokens ?? known;
	if (targetTotal <= 0) {
		return { sys: rawSys, tools: rawTools, exp: rawExp, obs: rawObs, ref: rawRef, msg: rawMsg, total: 0 };
	}

	// If known buckets exceed measured context usage, scale down proportionally.
	if (known > targetTotal && known > 0) {
		let sys = Math.max(0, Math.round(rawSys * (targetTotal / known)));
		let tools = Math.max(0, Math.round(rawTools * (targetTotal / known)));
		let exp = Math.max(0, Math.round(rawExp * (targetTotal / known)));
		let obs = Math.max(0, Math.round(rawObs * (targetTotal / known)));
		let ref = Math.max(0, Math.round(rawRef * (targetTotal / known)));
		let msg = Math.max(0, Math.round(rawMsg * (targetTotal / known)));

		let delta = targetTotal - (sys + tools + exp + obs + ref + msg);
		const order: Array<"ref" | "obs" | "exp" | "tools" | "sys" | "msg"> = ["ref", "obs", "exp", "tools", "sys", "msg"];
		let guard = 0;
		while (delta !== 0 && guard < 1000) {
			guard++;
			for (const key of order) {
				if (delta === 0) break;
				if (delta > 0) {
					if (key === "sys") sys++;
					else if (key === "tools") tools++;
					else if (key === "exp") exp++;
					else if (key === "obs") obs++;
					else if (key === "ref") ref++;
					else msg++;
					delta--;
				} else {
					if (key === "sys" && sys > 0) {
						sys--;
						delta++;
					} else if (key === "tools" && tools > 0) {
						tools--;
						delta++;
					} else if (key === "exp" && exp > 0) {
						exp--;
						delta++;
					} else if (key === "obs" && obs > 0) {
						obs--;
						delta++;
					} else if (key === "ref" && ref > 0) {
						ref--;
						delta++;
					} else if (key === "msg" && msg > 0) {
						msg--;
						delta++;
					}
				}
			}
		}

		return { sys, tools, exp, obs, ref, msg, total: targetTotal };
	}

	return {
		sys: rawSys,
		tools: rawTools,
		exp: rawExp,
		obs: rawObs,
		ref: rawRef,
		msg: rawMsg,
		total: targetTotal,
	};
}

function colorizeMeterSegment(theme: Theme, token: "dim" | "accent" | "warning" | "success" | "exp" | "ref", width: number): string {
	if (width <= 0) return "";
	if (token === "exp") return fg256(37, "█".repeat(width));
	if (token === "ref") return fg256(135, "█".repeat(width));
	return theme.fg(token, "█".repeat(width));
}

function allocateMeterUnits(composition: Composition, filledUnits: number): Composition {
	if (filledUnits <= 0 || composition.total <= 0) {
		return { sys: 0, tools: 0, exp: 0, obs: 0, ref: 0, msg: 0, total: 0 };
	}

	const raw = {
		sys: (composition.sys / composition.total) * filledUnits,
		tools: (composition.tools / composition.total) * filledUnits,
		exp: (composition.exp / composition.total) * filledUnits,
		obs: (composition.obs / composition.total) * filledUnits,
		ref: (composition.ref / composition.total) * filledUnits,
		msg: (composition.msg / composition.total) * filledUnits,
	};
	const units: Composition = {
		sys: Math.floor(raw.sys),
		tools: Math.floor(raw.tools),
		exp: Math.floor(raw.exp),
		obs: Math.floor(raw.obs),
		ref: Math.floor(raw.ref),
		msg: Math.floor(raw.msg),
		total: filledUnits,
	};

	let assigned = units.sys + units.tools + units.exp + units.obs + units.ref + units.msg;
	const remainders: Array<{ key: Exclude<keyof Composition, "total">; value: number }> = [
		{ key: "sys", value: raw.sys - units.sys },
		{ key: "tools", value: raw.tools - units.tools },
		{ key: "exp", value: raw.exp - units.exp },
		{ key: "obs", value: raw.obs - units.obs },
		{ key: "ref", value: raw.ref - units.ref },
		{ key: "msg", value: raw.msg - units.msg },
	].sort((a, b) => b.value - a.value);

	let index = 0;
	while (assigned < filledUnits && remainders.length > 0) {
		const key = remainders[index % remainders.length].key;
		units[key] += 1;
		assigned += 1;
		index += 1;
	}

	return units;
}

function buildContextMeter(theme: Theme, pctNum: number | null, composition: Composition): string {
	const meterWidth = 12;
	const filledUnits = clamp(Math.round(((pctNum ?? 0) / 100) * meterWidth), 0, meterWidth);
	const emptyUnits = Math.max(0, meterWidth - filledUnits);
	const units = allocateMeterUnits(composition, filledUnits);

	const filled = composition.total > 0
		? [
			colorizeMeterSegment(theme, "dim", units.sys),
			colorizeMeterSegment(theme, "accent", units.tools),
			colorizeMeterSegment(theme, "exp", units.exp),
			colorizeMeterSegment(theme, "warning", units.obs),
			colorizeMeterSegment(theme, "ref", units.ref),
			colorizeMeterSegment(theme, "success", units.msg),
		].join("")
		: colorizeMeterSegment(theme, "accent", filledUnits);
	const empty = emptyUnits > 0 ? theme.fg("dim", "─".repeat(emptyUnits)) : "";
	return theme.fg("dim", "[") + filled + empty + theme.fg("dim", "]");
}

const EMPTY_COMPOSITION: Composition = {
	sys: 0,
	tools: 0,
	exp: 0,
	obs: 0,
	ref: 0,
	msg: 0,
	total: 0,
};

// =============================================================================
// Custom Footer Component
// =============================================================================

class CustomFooterComponent implements Component {
	private cachedRenderKey = "";
	private cachedRenderLines: string[] = ["", ""];
	private cachedCompositionKey = "";
	private cachedComposition: Composition = { ...EMPTY_COMPOSITION };

	constructor(
		private _tui: TUI,
		private theme: Theme,
		private footerData: ReadonlyFooterDataProvider,
		private state: FooterState,
	) {}

	dispose(): void {}

	private buildRenderKey(width: number): string {
		const s = this.state;
		const branch = this.footerData.getGitBranch() || "";
		return [
			String(width),
			branch,
			s.modelName,
			s.thinkingLevel,
			s.thinkingLength,
			String(s.contextPercent ?? ""),
			String(s.contextTokens ?? ""),
			String(s.contextWindow),
			s.sessionLabel,
			String(s.systemPromptTokens),
			String(s.toolDefinitionTokens),
			String(s.observationTokens),
			String(s.experienceTokens),
			String(s.reflectionTokens),
			String(s.rawMessageTokens),
			s.omStatus,
			s.omError,
			String(s.mcpServerCount),
			String(s.diffAdded),
			String(s.diffRemoved),
			s.isWorktree ? "1" : "0",
			this.getOtherExtensionStatusText(),
		].join("|");
	}

	private getComposition(): Composition {
		const s = this.state;
		const key = [
			String(s.systemPromptTokens),
			String(s.toolDefinitionTokens),
			String(s.observationTokens),
			String(s.experienceTokens),
			String(s.reflectionTokens),
			String(s.rawMessageTokens),
			String(s.contextTokens ?? ""),
		].join("|");
		if (key === this.cachedCompositionKey) {
			return this.cachedComposition;
		}
		this.cachedCompositionKey = key;
		this.cachedComposition = deriveComposition(s);
		return this.cachedComposition;
	}

	render(width: number): string[] {
		if (width < 20) return [""];
		const key = this.buildRenderKey(width);
		if (key === this.cachedRenderKey) {
			return this.cachedRenderLines;
		}

		const lines = [
			this.renderLine1(width),
			this.renderLine2(width),
		];
		const extensionStatusLine = this.renderExtensionStatusLine(width);
		if (extensionStatusLine) {
			lines.push(extensionStatusLine);
		}
		this.cachedRenderKey = key;
		this.cachedRenderLines = lines;
		return lines;
	}

	// ─── LINE 1: Model + context meter + composition legend ───
	private renderLine1(width: number): string {
		const s = this.state;
		const composition = this.getComposition();

		const model = shortenModel(s.modelName || "?", 28);
		const thinkingLevel = (s.thinkingLevel || "off").trim();

		const pctNum = s.contextPercent !== null ? clamp(Math.round(s.contextPercent), 0, 100) : null;
		const pctLabel = pctNum !== null ? `${pctNum}%` : "?%";

		let pctStr: string;
		if (pctNum !== null && pctNum > 90) {
			pctStr = this.theme.fg("error", pctLabel);
		} else if (pctNum !== null && pctNum > 70) {
			pctStr = this.theme.fg("warning", pctLabel);
		} else {
			pctStr = this.theme.fg("accent", pctLabel);
		}

		const sessionLabel = compactInline((s.sessionLabel || "").trim() || "~ctx", 24);
		const meter =
			buildContextMeter(this.theme, pctNum, composition) +
			this.theme.fg("dim", " ") +
			pctStr +
			this.theme.fg("dim", ` · ${sessionLabel} `) +
			this.theme.fg("accent", formatTokens(composition.total));
		const thinkingStr = this.theme.fg("dim", `${thinkingLevel} `);

		const l1Left =
			this.theme.fg("dim", ` ${ICON.model} ${model} `) +
			thinkingStr +
			meter;

		const legendSegments = [
			this.theme.fg("dim", "▍") + this.theme.fg("dim", "sys ") + this.theme.fg("dim", formatTokens(composition.sys)),
			this.theme.fg("accent", "▍") + this.theme.fg("dim", "tools ") + this.theme.fg("accent", formatTokens(composition.tools)),
			fg256(37, "▍") + this.theme.fg("dim", "exp ") + fg256(37, formatTokens(composition.exp)),
			this.theme.fg("warning", "▍") + this.theme.fg("dim", "obs ") + this.theme.fg("warning", formatTokens(composition.obs)),
			fg256(135, "▍") + this.theme.fg("dim", "ref ") + fg256(135, formatTokens(composition.ref)),
			this.theme.fg("success", "▍") + this.theme.fg("dim", "msg ") + this.theme.fg("success", formatTokens(composition.msg)),
		];

		const rightBudget = Math.max(0, width - visibleWidth(l1Left) - 1);
		const l1Right = fitSegmentsWithOverflow(
			legendSegments,
			this.theme.fg("dim", "  "),
			rightBudget,
			(omitted) => this.theme.fg("dim", `+${omitted}`),
		);

		if (!l1Right) {
			return truncateToWidth(l1Left, width, "");
		}

		const padding = " ".repeat(Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)));
		return truncateToWidth(`${l1Left}${padding}${l1Right}`, width, "");
	}

	// ─── LINE 2: Left (dir, branch, diff) | Right (MCP, OM) ───
	private renderLine2(width: number): string {
		const s = this.state;

		const dirStr = this.theme.fg("dim", ` ${ICON.folder} ${basename(process.cwd())}`);

		const branch = this.footerData.getGitBranch();
		let branchStr = "";
		if (branch) {
			const wt = s.isWorktree ? " (worktree)" : "";
			branchStr = this.theme.fg("accent", ` ${ICON.branch} ${branch}${wt}`);
		}

		let diffStr = "";
		if (s.diffAdded > 0 || s.diffRemoved > 0) {
			const parts: string[] = [];
			if (s.diffAdded > 0) parts.push(this.theme.fg("success", `+${s.diffAdded}`));
			if (s.diffRemoved > 0) parts.push(this.theme.fg("error", `-${s.diffRemoved}`));
			diffStr = ` ${ICON.diff} ${parts.join(" ")}`;
		}

		const leftStr = `${dirStr}${branchStr}${diffStr}`;
		const leftWidth = visibleWidth(leftStr);
		if (leftWidth >= width) {
			return truncateToWidth(leftStr, width, this.theme.fg("dim", "…"));
		}

		const rightBudget = Math.max(0, width - leftWidth - 1);
		let rightStr = this.buildRightStatus(rightBudget);
		rightStr = truncateToWidth(rightStr, rightBudget, "");

		if (!rightStr) {
			return truncateToWidth(leftStr, width, this.theme.fg("dim", "…"));
		}

		const padding = " ".repeat(Math.max(1, width - leftWidth - visibleWidth(rightStr)));
		return truncateToWidth(`${leftStr}${padding}${rightStr}`, width, "");
	}

	private buildRightStatus(budget: number): string {
		if (budget <= 0) return "";

		const sections: string[] = [];
		const omSection = this.buildOmSummary();
		if (omSection) sections.push(omSection);

		return fitSegmentsWithOverflow(
			sections,
			this.theme.fg("dim", "  "),
			budget,
			(omitted) => this.theme.fg("dim", `+${omitted}`),
		);
	}

	private getOtherExtensionStatusText(): string {
		const statuses = this.footerData.getExtensionStatuses();
		if (!statuses || statuses.size <= 0) return "";
		const entries = Array.from(statuses.entries()) as Array<[string, string]>;
		const parts = entries
			.filter(([key, text]) => key !== "observational-memory" && typeof text === "string" && text.trim().length > 0)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		return parts.join(" ").trim();
	}

	private renderExtensionStatusLine(width: number): string {
		const text = this.getOtherExtensionStatusText();
		if (!text) return "";
		return truncateToWidth(text, width, this.theme.fg("dim", "..."));
	}

	private buildOmSummary(): string {
		const s = this.state;
		if (!s.omStatus && !s.omError && s.observationTokens <= 0 && s.experienceTokens <= 0 && s.reflectionTokens <= 0) {
			return "";
		}

		const parts: string[] = [];
		if (s.omStatus) {
			parts.push(this.theme.fg("warning", compactInline(s.omStatus, 18)));
		}
		if (s.omError) {
			parts.push(this.theme.fg("error", compactInline(s.omError, 28)));
		}
		if (s.observationTokens > 0) {
			parts.push(fg256(214, `obs:${formatTokens(s.observationTokens)}`));
		}
		if (s.experienceTokens > 0) {
			parts.push(fg256(37, `exp:${formatTokens(s.experienceTokens)}`));
		}
		if (s.reflectionTokens > 0) {
			parts.push(fg256(135, `ref:${formatTokens(s.reflectionTokens)}`));
		}

		return this.theme.fg("dim", `${ICON.memory} `) + parts.join(" ");
	}
}

// =============================================================================
// Factory — called by ctx.ui.setFooter()
// =============================================================================

export function createCustomFooter(
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	state: FooterState,
): Component & { dispose(): void } {
	return new CustomFooterComponent(tui, theme, footerData, state);
}

// =============================================================================
// Git diff stats helper — called from index.ts hooks
// =============================================================================

export function parseGitDiffShortstat(output: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	const addMatch = output.match(/(\d+)\s+insertion/);
	if (addMatch) added = parseInt(addMatch[1], 10);
	const delMatch = output.match(/(\d+)\s+deletion/);
	if (delMatch) removed = parseInt(delMatch[1], 10);
	return { added, removed };
}

export function detectWorktree(): boolean {
	try {
		const fs = require("fs");
		const path = require("path");
		let dir = process.cwd();
		while (true) {
			const gitPath = path.join(dir, ".git");
			if (fs.existsSync(gitPath)) {
				const stat = fs.statSync(gitPath);
				return stat.isFile(); // .git file = worktree
			}
			const parent = path.dirname(dir);
			if (parent === dir) return false;
			dir = parent;
		}
	} catch {
		return false;
	}
}
