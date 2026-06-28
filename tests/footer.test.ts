import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("@mariozechner/pi-tui", () => ({
	visibleWidth(text: string): number {
		return text.replace(/\x1B\[[0-9;]*m/g, "").length;
	},
	truncateToWidth(text: string, width: number, ellipsis: string): string {
		if (width <= 0) return "";
		const plain = text.replace(/\x1B\[[0-9;]*m/g, "");
		if (plain.length <= width) return plain;
		if (ellipsis.length >= width) return ellipsis.slice(0, width);
		return `${plain.slice(0, width - ellipsis.length)}${ellipsis}`;
	},
}));

let createCustomFooter!: typeof import("../footer").createCustomFooter;
let createFooterState!: typeof import("../footer").createFooterState;
let parseGitDiffShortstat!: typeof import("../footer").parseGitDiffShortstat;

beforeAll(async () => {
	const footer = await import("../footer");
	createCustomFooter = footer.createCustomFooter;
	createFooterState = footer.createFooterState;
	parseGitDiffShortstat = footer.parseGitDiffShortstat;
});

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-9;]*m/g, "");
}

const identityTheme = {
	fg: (_token: string, text: string) => text,
} as any;

function makeFooterData(branch = "", statuses: Map<string, string> = new Map()) {
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 0,
		onBranchChange: () => () => undefined,
	} as any;
}

function renderFooter(
	state: ReturnType<typeof createFooterState>,
	options?: { width?: number; branch?: string; statuses?: Map<string, string> },
): string[] {
	const footer = createCustomFooter(
		undefined as unknown as never,
		identityTheme,
		makeFooterData(options?.branch, options?.statuses),
		state,
	);
	return footer.render(options?.width ?? 240).map(stripAnsi);
}

function parseBuckets(line1: string): number[] {
	const match = line1.match(/sys (\d+)\s+.*tools (\d+)\s+.*exp (\d+)\s+.*obs (\d+)\s+.*ref (\d+)\s+.*msg (\d+)/);
	expect(match).not.toBeNull();
	return (match ?? []).slice(1).map((value) => Number(value));
}

describe("observational-memory footer", () => {
	test("parseGitDiffShortstat parses git shortstat additions and deletions", () => {
		expect(parseGitDiffShortstat(" 2 files changed, 12 insertions(+), 7 deletions(-)")).toEqual({
			added: 12,
			removed: 7,
		});
		expect(parseGitDiffShortstat("1 file changed, 1 insertion(+), 1 deletion(-)")).toEqual({
			added: 1,
			removed: 1,
		});
		expect(parseGitDiffShortstat("No changes")).toEqual({
			added: 0,
			removed: 0,
		});
	});

	test("line 1 shows exact bucket totals when context budget is above composition", () => {
		const state = createFooterState();
		state.modelName = "gpt-5.4-mini";
		state.contextPercent = 52;
		state.contextTokens = 1000;
		state.systemPromptTokens = 100;
		state.toolDefinitionTokens = 80;
		state.observationTokens = 50;
		state.experienceTokens = 20;
		state.reflectionTokens = 10;
		state.rawMessageTokens = 40;

		const [line1] = renderFooter(state);
		const [sys, tools, exp, obs, ref, msg] = parseBuckets(line1);
		expect([sys, tools, exp, obs, ref, msg]).toEqual([100, 80, 20, 50, 10, 40]);
	});

	test("line 1 scales bucket totals when composition exceeds the context budget", () => {
		const state = createFooterState();
		state.contextPercent = 74;
		state.contextTokens = 200;
		state.systemPromptTokens = 100;
		state.toolDefinitionTokens = 80;
		state.observationTokens = 60;
		state.experienceTokens = 50;
		state.reflectionTokens = 40;
		state.rawMessageTokens = 30;

		const [line1] = renderFooter(state);
		const [sys, tools, exp, obs, ref, msg] = parseBuckets(line1);
		const total = [sys, tools, exp, obs, ref, msg].reduce((sum, v) => sum + v, 0);
		expect(total).toBe(200);
		expect(sys).toBeLessThan(100);
		expect(tools).toBeLessThan(80);
		expect(exp).toBeLessThan(60);
		expect(obs).toBeLessThan(50);
		expect(ref).toBeLessThan(40);
		expect(msg).toBeLessThan(30);
	});

	test("line 2 omission summary omits raw message tokens and renders obs/exp/ref only", () => {
		const state = createFooterState();
		state.modelName = "gpt-5.4-mini";
		state.thinkingLevel = "high";
		state.contextPercent = 44;
		state.contextTokens = 1200;
		state.systemPromptTokens = 500;
		state.toolDefinitionTokens = 250;
		state.observationTokens = 120;
		state.experienceTokens = 80;
		state.reflectionTokens = 30;
		state.rawMessageTokens = 900;
		state.omStatus = "observing";

		const [, line2] = renderFooter(state, { width: 260, branch: "", statuses: new Map() });
		expect(line2).toContain("obs:120");
		expect(line2).toContain("exp:80");
		expect(line2).toContain("ref:30");
		expect(line2).not.toContain("msg:");
	});

	test("third-line extension status excludes observational-memory and sanitizes text", () => {
		const state = createFooterState();
		state.contextTokens = 1200;
		state.contextPercent = 11;
		state.modelName = "gpt-5.4-mini";

		const statuses = new Map<string, string>([
			["observational-memory", "internal only"],
			["zeta", "from\nother"],
			["alpha", "first status"],
		]);

		const lines = renderFooter(state, { width: 240, statuses });
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("alpha first status");
		expect(lines[2]).toContain("zeta other");
		expect(lines[2]).not.toContain("internal only");
		expect(lines[2]).not.toContain("\n");
	});
});
