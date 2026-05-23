import { describe, expect, test } from "bun:test";
import { parseCodexQuotaStatusText } from "../codex-status-parser";

describe("codex status parser", () => {
	test("parses remaining quota percentages and reset countdowns from Multicodex footer text", () => {
		const now = Date.UTC(2026, 4, 11, 12, 0, 0);
		const parsed = parseCodexQuotaStatusText(
			"Codex · mbb · 5h:34% left (↺2h0m) · 7d:80% left (↺6d12h)",
			now,
		);
		expect(parsed).toEqual({
			accountName: "mbb",
			remaining5hPercent: 34,
			remaining7dPercent: 80,
			reset5hAtMs: now + 2 * 60 * 60 * 1000,
			reset7dAtMs: now + ((6 * 24) + 12) * 60 * 60 * 1000,
		});
	});

	test("converts used percentages into remaining percentages", () => {
		const parsed = parseCodexQuotaStatusText("Codex · mbb · 5h:66% used · 7d:20% used");
		expect(parsed).toMatchObject({
			accountName: "mbb",
			remaining5hPercent: 34,
			remaining7dPercent: 80,
		});
	});

	test("strips ansi escapes before parsing", () => {
		const parsed = parseCodexQuotaStatusText("\u001b[36mCodex · user@example.com · 5h:91% left\u001b[0m");
		expect(parsed).toMatchObject({
			accountName: "user@example.com",
			remaining5hPercent: 91,
		});
	});
});
