import { describe, expect, test } from "bun:test";
import { validateReflectedObservations } from "../reflection-guard";

function buildLargeInput(lineCount: number): string {
	return Array.from({ length: lineCount }, (_, i) => {
		const minute = String(i % 60).padStart(2, "0");
		return `* 🔴 (14:${minute}) User updated observational-memory footer account sync for pi-multi-pass workspace-${i} and verified provider/model routing for branch-${i % 9}.`;
	}).join("\n");
}

describe("reflection safety guard", () => {
	test("rejects implausibly tiny reflections for large inputs", () => {
		const inputObservations = buildLargeInput(2200);
		const tinyCompacted = [
			"Date: 2025-12-04",
			"* 🔴 (14:30) User prefers direct answers",
			"* 🟡 (14:32) Working on feature X",
		].join("\n");

		const validation = validateReflectedObservations({
			inputObservations,
			existingCompacted: "",
			compactedObservations: tinyCompacted,
		});

		expect(validation.inputTokens).toBeGreaterThan(50000);
		expect(validation.ok).toBe(false);
		expect(validation.reason).toBe("template-artifact-detected");
	});

	test("rejects tiny non-template output for large input", () => {
		const inputObservations = buildLargeInput(2200);
		const tinyCompacted = "* 🔴 (14:30) Footer updated.";

		const validation = validateReflectedObservations({
			inputObservations,
			existingCompacted: "",
			compactedObservations: tinyCompacted,
		});

		expect(validation.ok).toBe(false);
		expect(validation.reason).toBe("output-too-small-for-large-input");
	});

	test("accepts reflections that retain substantial detail and overlap", () => {
		const inputObservations = buildLargeInput(2200);
		const compactedObservations = inputObservations.split("\n").slice(0, 260).join("\n");

		const validation = validateReflectedObservations({
			inputObservations,
			existingCompacted: "",
			compactedObservations,
		});

		expect(validation.ok).toBe(true);
		expect(validation.outputTokens).toBeGreaterThan(220);
		expect(validation.keywordOverlap).toBeGreaterThan(0.08);
	});
});
