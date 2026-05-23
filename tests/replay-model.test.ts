import { describe, expect, test } from "bun:test";
import { buildReplayModel, buildVisibleRows } from "../replay-model";

describe("replay model", () => {
	test("groups entries by user turn, creates compact summaries, and marks current context start", () => {
		const branchEntries = [
			{ type: "session_info", id: "si1", timestamp: "2026-04-10T10:00:00.000Z", name: "demo" },
			{ type: "message", id: "u1", timestamp: "2026-04-10T10:00:01.000Z", message: { role: "user", content: "Please search the repo for auth config regressions quickly" } },
			{ type: "message", id: "a1", timestamp: "2026-04-10T10:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "grep", arguments: { pattern: "auth" } }] } },
			{ type: "message", id: "tr1", timestamp: "2026-04-10T10:00:03.000Z", message: { role: "toolResult", toolName: "grep", content: "match one\nmatch two" } },
			{ type: "custom", id: "om1", timestamp: "2026-04-10T10:00:04.000Z", customType: "om:state", data: { state: { generationCount: 1, totalObservationTokens: 120, totalCompactedTokens: 40 } } },
			{ type: "message", id: "u2", timestamp: "2026-04-10T10:00:05.000Z", message: { role: "user", content: "Now summarize the fix in one sentence please" } },
			{ type: "message", id: "a2", timestamp: "2026-04-10T10:00:06.000Z", message: { role: "assistant", content: "The auth config regression comes from a stale provider fallback." } },
			{ type: "thinking_level_change", id: "th1", timestamp: "2026-04-10T10:00:07.000Z", thinkingLevel: "xhigh" },
		];

		const model = buildReplayModel(branchEntries, {
			sessionName: "demo",
			contextUsage: { tokens: 40, contextWindow: 100, percent: 40 },
			omMessageStartIndex: 2,
		});

		expect(model.groups.length).toBeGreaterThanOrEqual(3);
		expect(model.groups[1]?.summary).toContain("Please search the repo for…");
		expect(model.groups[1]?.badges).toContain("CALL");
		expect(model.groups[1]?.badges).toContain("TOOL");
		expect(model.groups[1]?.badges).toContain("OBS");
		expect(model.contextStartGroupIndex).toBeGreaterThanOrEqual(1);
		expect(model.groups[model.contextStartGroupIndex]?.isContextStart).toBe(true);

		const expanded = new Set<string>([model.groups[1]!.id]);
		const visibleRows = buildVisibleRows(model, expanded, false);
		expect(visibleRows.some((row) => row.type === "entry" && row.groupIndex === 1)).toBe(true);

		const contextRows = buildVisibleRows(model, expanded, true);
		expect(contextRows.every((row) => row.inContext)).toBe(true);
	});

	test("normalizes numeric message timestamps into ISO timestamps for replay groups", () => {
		const branchEntries = [
			{ type: "message", id: "u1", timestamp: "2026-04-10T10:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1775815201000 } },
			{ type: "message", id: "a1", timestamp: "2026-04-10T10:00:02.000Z", message: { role: "assistant", content: "world", timestamp: 1775815202000 } },
		];
		const model = buildReplayModel(branchEntries, { sessionName: "demo" });
		expect(model.groups[0]?.timestamp).toBe("2026-04-10T10:00:01.000Z");
		expect(Number.isNaN(new Date(model.groups[0]?.timestamp || "").getTime())).toBe(false);
		expect(Number.isNaN(new Date(model.groups[0]?.entries[0]?.timestamp || "").getTime())).toBe(false);
	});

	test("detects experience and skill themed assistant/system entries", () => {
		const branchEntries = [
			{ type: "message", id: "u1", timestamp: "2026-04-10T10:00:01.000Z", message: { role: "user", content: "help" } },
			{ type: "message", id: "a1", timestamp: "2026-04-10T10:00:02.000Z", message: { role: "assistant", content: "## Relevant Operational Experiences\n- [E1] Prefer rg first" } },
			{ type: "custom_message", id: "cm1", timestamp: "2026-04-10T10:00:03.000Z", body: "SKILL.md promotion candidate" },
		];
		const model = buildReplayModel(branchEntries, { sessionName: "demo" });
		const kinds = model.groups.flatMap((group) => group.entries.map((entry) => entry.kind));
		expect(kinds).toContain("experience");
		expect(kinds).toContain("skill");
	});
});
