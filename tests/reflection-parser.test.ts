import { describe, expect, test } from "bun:test";
import { extractReflectedObservations } from "../reflection-parser";

describe("reflection parser", () => {
	test("selects the best <observations> block instead of blindly taking the first", () => {
		const inputObservations = [
			"Date: Apr 13, 2026",
			"* 🔴 (14:10) User switched from pi-multicodex to pi-multi-pass and requested accurate account-aware footer status.",
			"* 🟡 (14:12) Assistant implemented model/provider sync and account usage rendering updates in observational-memory footer.",
		].join("\n");

		const modelOutput = [
			"<observations>",
			"Date: Dec 4, 2025",
			"* 🔴 (14:30) User prefers direct answers",
			"* 🟡 (14:32) Working on feature X",
			"</observations>",
			"",
			"<current-task>",
			"Primary: keep footer synced to selected account and model",
			"</current-task>",
			"",
			"<observations>",
			"Date: Apr 13, 2026",
			"* 🔴 (14:10) User switched from pi-multicodex to pi-multi-pass and wants current-account usage only.",
			"* 🟡 (14:12) Footer now reads active provider/model directly and updates thinking display in near real time.",
			"</observations>",
		].join("\n");

		const parsed = extractReflectedObservations(modelOutput, inputObservations);
		expect(parsed.candidateCount).toBe(2);
		expect(parsed.selectedIndex).toBe(1);
		expect(parsed.observations).toContain("pi-multi-pass");
		expect(parsed.observations).not.toContain("feature X");
	});

	test("falls back to raw output when no <observations> tags exist", () => {
		const output = "Date: Apr 13, 2026\n* 🔴 (14:30) Kept memory concise and task-focused.";
		const parsed = extractReflectedObservations(output, "irrelevant input");
		expect(parsed.candidateCount).toBe(0);
		expect(parsed.selectedIndex).toBe(-1);
		expect(parsed.observations).toBe(output);
	});
});
