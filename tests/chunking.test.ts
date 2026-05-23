import { describe, expect, test } from "bun:test";
import { splitTextByTailTokenBudget } from "../chunking";
import { estimateStringTokens } from "../token-estimator";

function buildObservationLines(count: number): string {
	return Array.from({ length: count }, (_, index) => {
		const minute = String(index % 60).padStart(2, "0");
		return `* 🟡 (14:${minute}) Observation ${index} about linkedIn sidepanel queue handling and background port lifecycle state.`;
	}).join("\n");
}

describe("chunking splitTextByTailTokenBudget", () => {
	test("splits oldest prefix from recent tail by token budget", () => {
		const text = buildObservationLines(240);
		const totalTokens = estimateStringTokens(text);
		const tailBudget = Math.floor(totalTokens * 0.35);
		const split = splitTextByTailTokenBudget(text, tailBudget);

		expect(split.headText.length).toBeGreaterThan(0);
		expect(split.tailText.length).toBeGreaterThan(0);
		expect(split.tailTokens).toBeLessThanOrEqual(Math.max(1, tailBudget + 40));
		expect(split.headTokens + split.tailTokens).toBeGreaterThan(Math.floor(totalTokens * 0.85));
	});

	test("keeps full text in tail when budget covers everything", () => {
		const text = buildObservationLines(40);
		const totalTokens = estimateStringTokens(text);
		const split = splitTextByTailTokenBudget(text, totalTokens + 100);

		expect(split.headText).toBe("");
		expect(split.tailText).toContain("Observation 0");
		expect(split.tailText).toContain("Observation 39");
	});
});
