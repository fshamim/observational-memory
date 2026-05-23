import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	buildReplayModel,
	buildVisibleRows,
	type ReplayModel,
	type ReplayVisibleRow,
	type BuildReplayModelOptions,
	type ReplayEntryKind,
} from "./replay-model";

function formatTimestamp(value: string): string {
	if (!value) return "—";
	const trimmed = value.trim();
	if (!trimmed) return "—";
	const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
	const date = new Date(numeric !== null && Number.isFinite(numeric) ? numeric : trimmed);
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderBadge(theme: Theme, label: string): string {
	switch (label) {
		case "USER":
			return theme.bg("selectedBg", theme.fg("success", ` ${label} `));
		case "ASSIST":
			return theme.bg("selectedBg", theme.fg("accent", ` ${label} `));
		case "CALL":
		case "TOOL":
			return theme.bg("selectedBg", theme.fg("warning", ` ${label} `));
		case "OBS":
			return theme.bg("selectedBg", theme.fg("success", ` ${label} `));
		case "THINK":
			return theme.bg("selectedBg", theme.fg("error", ` ${label} `));
		case "EXP":
		case "SKILL":
			return theme.bg("selectedBg", theme.fg("accent", ` ${label} `));
		case "CTX":
			return theme.bg("selectedBg", theme.fg("accent", ` ${label} `));
		default:
			return theme.bg("selectedBg", theme.fg("dim", ` ${label} `));
	}
}

function renderEntryKindBadge(theme: Theme, kind: ReplayEntryKind): string {
	switch (kind) {
		case "user":
			return renderBadge(theme, "USER");
		case "assistant":
			return renderBadge(theme, "ASSIST");
		case "tool-call":
			return renderBadge(theme, "CALL");
		case "tool-result":
			return renderBadge(theme, "TOOL");
		case "observation":
			return renderBadge(theme, "OBS");
		case "thinking":
			return renderBadge(theme, "THINK");
		case "experience":
			return renderBadge(theme, "EXP");
		case "skill":
			return renderBadge(theme, "SKILL");
		case "system":
			return renderBadge(theme, "SYS");
		default:
			return renderBadge(theme, "OTHER");
	}
}

function normalizeRenderableText(value: string): string {
	return String(value || "")
		.replace(/\r/g, "")
		.replace(/\t/g, "    ");
}

function wrapAndClip(text: string, width: number, maxLines: number): string[] {
	const normalized = normalizeRenderableText(text);
	const lines = wrapTextWithAnsi(normalized, Math.max(1, width));
	if (lines.length <= maxLines) return lines;
	return [...lines.slice(0, Math.max(1, maxLines - 1)), truncateToWidth("…", Math.max(1, width), "")];
}

function padRightAnsi(text: string, width: number): string {
	const normalized = normalizeRenderableText(text);
	const clipped = truncateToWidth(normalized, Math.max(1, width), "");
	const pad = Math.max(0, width - visibleWidth(clipped));
	return clipped + " ".repeat(pad);
}

function clampRenderLines(lines: string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	const out: string[] = [];
	for (const line of lines) {
		const normalized = normalizeRenderableText(String(line));
		const parts = normalized.split("\n");
		for (const part of parts) {
			out.push(truncateToWidth(part, safeWidth, ""));
		}
	}
	return out;
}

class OmReplayPanel {
	private expandedGroupIds = new Set<string>();
	private selectedRowIndex = 0;
	private listScrollOffset = 0;
	private contextOnly = false;
	private lastGPressedAt = 0;
	private lastRenderHeight = 24;

	constructor(
		private readonly tui: any,
		private readonly model: ReplayModel,
		private readonly onDone: () => void,
	) {
		this.selectedRowIndex = this.findVisibleRowIndexForGroup(Math.max(0, model.contextStartGroupIndex));
	}

	private get visibleRows(): ReplayVisibleRow[] {
		return buildVisibleRows(this.model, this.expandedGroupIds, this.contextOnly);
	}

	private get selectedRow(): ReplayVisibleRow | null {
		const rows = this.visibleRows;
		return rows[this.selectedRowIndex] || null;
	}

	private clampSelection(): void {
		const rows = this.visibleRows;
		if (rows.length === 0) {
			this.selectedRowIndex = 0;
			return;
		}
		this.selectedRowIndex = Math.max(0, Math.min(rows.length - 1, this.selectedRowIndex));
	}

	private findVisibleRowIndexForGroup(groupIndex: number): number {
		const rows = this.visibleRows;
		const index = rows.findIndex((row) => row.groupIndex === groupIndex);
		return index >= 0 ? index : 0;
	}

	private setSelectedRowIndex(index: number): void {
		this.selectedRowIndex = index;
		this.clampSelection();
	}

	private moveSelection(delta: number): void {
		this.setSelectedRowIndex(this.selectedRowIndex + delta);
	}

	private pageMove(direction: 1 | -1, height: number, divisor = 1): void {
		const bodyHeight = Math.max(6, height - 7);
		const amount = Math.max(1, Math.floor(bodyHeight / divisor));
		this.moveSelection(direction * amount);
	}

	private toggleCurrentGroup(expand?: boolean): void {
		const row = this.selectedRow;
		if (!row) return;
		const group = this.model.groups[row.groupIndex];
		if (!group) return;
		const next = expand ?? !this.expandedGroupIds.has(group.id);
		if (next) {
			this.expandedGroupIds.add(group.id);
		} else {
			this.expandedGroupIds.delete(group.id);
			if (row.type === "entry") {
				this.setSelectedRowIndex(this.findVisibleRowIndexForGroup(row.groupIndex));
			}
		}
	}

	private collapseOrParent(): void {
		const row = this.selectedRow;
		if (!row) return;
		if (row.type === "entry") {
			this.setSelectedRowIndex(this.findVisibleRowIndexForGroup(row.groupIndex));
			return;
		}
		this.toggleCurrentGroup(false);
	}

	private jumpToTop(): void {
		this.setSelectedRowIndex(0);
	}

	private jumpToBottom(): void {
		this.setSelectedRowIndex(this.visibleRows.length - 1);
	}

	private jumpToContextStart(): void {
		this.setSelectedRowIndex(this.findVisibleRowIndexForGroup(this.model.contextStartGroupIndex));
	}

	private toggleContextOnly(): void {
		const currentGroupIndex = this.selectedRow?.groupIndex ?? this.model.contextStartGroupIndex;
		this.contextOnly = !this.contextOnly;
		this.clampSelection();
		this.setSelectedRowIndex(this.findVisibleRowIndexForGroup(currentGroupIndex));
		if (this.contextOnly && this.visibleRows.length > 0 && !this.selectedRow?.inContext) {
			this.jumpToContextStart();
		}
	}

	private getRenderHeight(): number {
		const rows = Number(this.tui?.terminal?.rows || 24);
		return Math.max(12, Math.floor(rows * 0.86));
	}

	private ensureVisible(height: number): void {
		const rows = this.visibleRows;
		if (rows.length === 0) {
			this.listScrollOffset = 0;
			return;
		}
		const bodyHeight = Math.max(6, height - 7);
		if (this.selectedRowIndex < this.listScrollOffset) {
			this.listScrollOffset = this.selectedRowIndex;
		} else if (this.selectedRowIndex >= this.listScrollOffset + bodyHeight) {
			this.listScrollOffset = this.selectedRowIndex - bodyHeight + 1;
		}
		this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, Math.max(0, rows.length - bodyHeight)));
	}

	handleInput(data: string, tui: any): void {
		const height = this.lastRenderHeight;
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.moveSelection(1);
		} else if (matchesKey(data, "g")) {
			const now = Date.now();
			if (now - this.lastGPressedAt < 700) {
				this.jumpToTop();
				this.lastGPressedAt = 0;
			} else {
				this.jumpToTop();
				this.lastGPressedAt = now;
			}
		} else if (data === "G" || matchesKey(data, Key.shift("g"))) {
			this.jumpToBottom();
		} else if (matchesKey(data, "d")) {
			this.pageMove(1, height, 2);
		} else if (matchesKey(data, "u")) {
			this.pageMove(-1, height, 2);
		} else if (matchesKey(data, "f")) {
			this.pageMove(1, height, 1);
		} else if (matchesKey(data, "b")) {
			this.pageMove(-1, height, 1);
		} else if (matchesKey(data, "c")) {
			this.jumpToContextStart();
		} else if (data === "C" || matchesKey(data, Key.shift("c"))) {
			this.toggleContextOnly();
		} else if (matchesKey(data, "h")) {
			this.collapseOrParent();
		} else if (matchesKey(data, "l") || matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, "o")) {
			this.toggleCurrentGroup(true);
		} else if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.onDone();
			return;
		} else {
			return;
		}
		this.clampSelection();
		this.ensureVisible(height);
		tui.requestRender();
	}

	private renderHeader(width: number, theme: Theme): string[] {
		const contextTokens = typeof this.model.contextUsage.tokens === "number" ? Math.round(this.model.contextUsage.tokens) : null;
		const contextWindow = typeof this.model.contextUsage.contextWindow === "number" ? Math.round(this.model.contextUsage.contextWindow) : null;
		const contextPercent = typeof this.model.contextUsage.percent === "number" ? Math.round(this.model.contextUsage.percent) : null;
		const rows = this.visibleRows;
		const contextMode = this.contextOnly ? renderBadge(theme, "CTX") + theme.fg("accent", " context-only") : theme.fg("dim", "all-groups");
		const title = `${theme.bold("OM Replay")} ${theme.fg("dim", "·")} ${truncateToWidth(this.model.sessionName || "(unnamed)", Math.max(10, width - 30), "")}`;
		const stats = [
			`${this.model.groups.length} groups`,
			`${rows.length} rows`,
			contextTokens !== null && contextWindow !== null ? `ctx ~${contextTokens}/${contextWindow}` : "ctx unknown",
			contextPercent !== null ? `${contextPercent}%` : null,
		].filter(Boolean).join(theme.fg("dim", " · "));
		return [
			truncateToWidth(`${theme.fg("accent", title)} ${theme.fg("dim", "| ")}${contextMode}`, width, ""),
			truncateToWidth(theme.fg("dim", stats), width, ""),
		];
	}

	private renderListLine(row: ReplayVisibleRow, listWidth: number, theme: Theme, isSelected: boolean): string {
		const group = this.model.groups[row.groupIndex];
		if (row.type === "group") {
			const expanded = this.expandedGroupIds.has(group.id);
			const prefix = isSelected ? theme.fg("accent", "❯") : theme.fg("dim", " ");
			const disclosure = expanded ? theme.fg("accent", "▾") : theme.fg("dim", "▸");
			const time = group.timestamp ? theme.fg("dim", formatTimestamp(group.timestamp)) : theme.fg("dim", "--:--");
			const badges = [
				...(group.isContextStart ? [renderBadge(theme, "CTX")] : []),
				...group.badges.map((badge) => renderBadge(theme, badge)),
			].join(" ");
			const groupTitle = normalizeRenderableText(group.title);
			const groupSummary = normalizeRenderableText(group.summary);
			const summary = group.kind === "turn"
				? `${groupTitle} ${theme.fg("dim", "·")} ${groupSummary}`
				: `${groupTitle} ${theme.fg("dim", "·")} ${groupSummary}`;
			const base = `${prefix} ${disclosure} ${time} ${badges} ${summary}`;
			return isSelected
				? theme.bg("selectedBg", truncateToWidth(base, listWidth, ""))
				: truncateToWidth(base, listWidth, "");
		}

		const entry = group.entries[row.entryIndex];
		const prefix = isSelected ? theme.fg("accent", "❯") : theme.fg("dim", " ");
		const badge = renderEntryKindBadge(theme, entry.kind);
		const entrySummary = normalizeRenderableText(entry.summary);
		const summary = truncateToWidth(`${prefix}   ${badge} ${entrySummary}`, listWidth, "");
		return isSelected ? theme.bg("selectedBg", summary) : summary;
	}

	private renderDetailPane(width: number, height: number, theme: Theme): string[] {
		const row = this.selectedRow;
		if (!row) {
			return [theme.fg("dim", "No replay rows available.")];
		}
		const group = this.model.groups[row.groupIndex];
		const lines: string[] = [];
		const groupBadges = group.badges.map((badge) => renderBadge(theme, badge)).join(" ");
		lines.push(theme.bold(normalizeRenderableText(`${group.title}`)));
		lines.push(theme.fg("dim", `${group.timestamp ? formatTimestamp(group.timestamp) : "--:--"} · ${group.entries.length} clustered item(s)`));
		lines.push(groupBadges || theme.fg("dim", "(no labels)"));
		if (group.isContextStart) {
			lines.push(theme.fg("accent", "Current context starts in this group."));
		} else if (group.inContext) {
			lines.push(theme.fg("accent", "This group is inside the estimated current context window."));
		}
		lines.push("");

		if (row.type === "group") {
			lines.push(theme.bold("Cluster overview"));
			for (const [index, entry] of group.entries.entries()) {
				lines.push(`${renderEntryKindBadge(theme, entry.kind)} ${index + 1}. ${normalizeRenderableText(entry.summary)}`);
			}
			lines.push("");
			lines.push(theme.fg("dim", "Tip: press l/o/Enter to expand this cluster in the left pane, then inspect a child row."));
		} else {
			const entry = group.entries[row.entryIndex];
			lines.push(theme.bold(`${entry.label} detail`));
			lines.push(theme.fg("dim", `${entry.timestamp ? formatTimestamp(entry.timestamp) : "--:--"} · raw ${entry.rawEntryId}`));
			lines.push("");
			lines.push(...wrapAndClip(entry.detail || entry.summary, Math.max(1, width), Math.max(6, height - 9)));
		}

		const wrapped = lines.flatMap((line) => wrapTextWithAnsi(normalizeRenderableText(String(line)), Math.max(1, width)));
		return wrapped.slice(0, Math.max(1, height - 1));
	}

	render(width: number, theme: Theme): string[] {
		const terminalWidthValue = Number(this.tui?.terminal?.columns ?? this.tui?.terminal?.cols ?? width);
		const terminalWidth = Number.isFinite(terminalWidthValue) && terminalWidthValue > 0
			? Math.floor(terminalWidthValue)
			: Math.max(1, Math.floor(width));
		const safeWidth = Math.max(1, Math.min(Math.max(1, Math.floor(width)), terminalWidth));
		const height = this.getRenderHeight();
		this.lastRenderHeight = height;
		this.clampSelection();
		this.ensureVisible(height);
		const rows = this.visibleRows;
		const header = this.renderHeader(safeWidth, theme);
		const footer = theme.fg(
			"dim",
			"j/k move • g/G top/bottom • d/u half-page • f/b page • l/o open • h collapse • c ctx-start • C ctx-only • q close",
		);
		const bodyHeight = Math.max(8, height - header.length - 2);
		const split = safeWidth >= 100;
		if (!split) {
			const listHeight = Math.max(4, Math.floor(bodyHeight * 0.55));
			const detailHeight = Math.max(4, bodyHeight - listHeight - 1);
			const listLines = rows
				.slice(this.listScrollOffset, this.listScrollOffset + listHeight)
				.map((row, index) => this.renderListLine(row, safeWidth, theme, this.listScrollOffset + index === this.selectedRowIndex));
			const detailLines = this.renderDetailPane(safeWidth, detailHeight, theme);
			const lines = [
				...header,
				...listLines,
				theme.fg("dim", "─".repeat(Math.max(1, safeWidth))),
				...detailLines.map((line) => truncateToWidth(line, safeWidth, "")),
				truncateToWidth(footer, safeWidth, ""),
			];
			return clampRenderLines(lines, safeWidth);
		}

		const separator = theme.fg("dim", " │ ");
		const rawLeftWidth = Math.max(34, Math.floor((safeWidth - 3) * 0.54));
		const leftWidth = Math.max(1, Math.min(rawLeftWidth, safeWidth - 4));
		const rightWidth = Math.max(1, safeWidth - leftWidth - 3);
		const listLines = rows
			.slice(this.listScrollOffset, this.listScrollOffset + bodyHeight)
			.map((row, index) => this.renderListLine(row, leftWidth, theme, this.listScrollOffset + index === this.selectedRowIndex));
		while (listLines.length < bodyHeight) listLines.push("");
		const detailLines = this.renderDetailPane(rightWidth, bodyHeight, theme);
		while (detailLines.length < bodyHeight) detailLines.push("");
		const bodyLines = Array.from({ length: bodyHeight }, (_, index) => {
			return `${padRightAnsi(listLines[index], leftWidth)}${separator}${truncateToWidth(normalizeRenderableText(detailLines[index]), rightWidth, "")}`;
		});
		const lines = [
			...header,
			...bodyLines,
			truncateToWidth(footer, safeWidth, ""),
		];
		return clampRenderLines(lines, safeWidth);
	}
}

export async function openOmReplayOverlay(
	ctx: any,
	branchEntries: any[],
	options: BuildReplayModelOptions = {},
): Promise<void> {
	if (!ctx?.hasUI || typeof ctx?.ui?.custom !== "function") {
		await ctx?.ui?.notify?.("Replay overlay requires UI support.", "warning");
		return;
	}
	const model = buildReplayModel(branchEntries, options);
	if (model.groups.length === 0) {
		await ctx?.ui?.notify?.("Replay has no visible branch entries to display.", "warning");
		return;
	}
	await ctx.ui.custom((tui: any, theme: Theme, _kb: any, done: any) => {
		const component = new OmReplayPanel(tui, model, () => done(undefined));
		return {
			handleInput: (data: string) => component.handleInput(data, tui),
			render: (width: number) => component.render(width, theme),
			invalidate: () => undefined,
		};
	}, {
		overlay: true,
		overlayOptions: { width: "88%", maxHeight: "86%", anchor: "center" },
	});
}
