import { describe, expect, test } from "bun:test";
import { evaluateRolloverDecision } from "../lib/rollover-policy";
import { DEFAULT_CONFIG } from "../types";

describe("rollover policy", () => {
	test("warns before hard threshold and stages once target threshold is reached", () => {
		const config = {
			...DEFAULT_CONFIG.sessionRollover,
			warnBytes: 100,
			targetBytes: 200,
			hardBytes: 300,
			minProjectedSavingsBytes: 20,
		};
		const warnOnly = evaluateRolloverDecision({
			config,
			currentBytes: 150,
			projectedSavingsBytes: 10,
			hasArchiveableCoverage: true,
			hasOversizedEntries: false,
		});
		expect(warnOnly.shouldWarn).toBe(true);
		expect(warnOnly.shouldStage).toBe(false);

		const target = evaluateRolloverDecision({
			config,
			currentBytes: 240,
			projectedSavingsBytes: 40,
			hasArchiveableCoverage: true,
			hasOversizedEntries: false,
		});
		expect(target.shouldStage).toBe(true);
		expect(target.shouldForce).toBe(false);
		expect(target.reason).toBe("target-threshold");

		const hard = evaluateRolloverDecision({
			config,
			currentBytes: 340,
			projectedSavingsBytes: 40,
			hasArchiveableCoverage: true,
			hasOversizedEntries: false,
		});
		expect(hard.shouldForce).toBe(true);
		expect(hard.reason).toBe("hard-threshold");
	});
});
