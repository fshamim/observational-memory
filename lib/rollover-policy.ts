import type { SessionRolloverConfig } from "../types";

export interface RolloverDecisionInput {
	config: SessionRolloverConfig;
	currentBytes: number;
	projectedSavingsBytes: number;
	hasArchiveableCoverage: boolean;
	hasOversizedEntries: boolean;
	force?: boolean;
}

export interface RolloverDecision {
	shouldWarn: boolean;
	shouldStage: boolean;
	shouldForce: boolean;
	reason: string | null;
	projectedResultBytes: number;
	projectedSavingsBytes: number;
}

export function evaluateRolloverDecision(input: RolloverDecisionInput): RolloverDecision {
	const { config, currentBytes, force = false } = input;
	const projectedSavingsBytes = Math.max(0, Math.floor(input.projectedSavingsBytes));
	const projectedResultBytes = Math.max(0, currentBytes - projectedSavingsBytes);
	const hasWork = input.hasArchiveableCoverage || input.hasOversizedEntries;
	const meaningfulSavings = projectedSavingsBytes >= config.minProjectedSavingsBytes;
	const shouldWarn = currentBytes >= config.warnBytes;
	const shouldForce = force || (currentBytes >= config.hardBytes && hasWork && meaningfulSavings);
	const shouldStage =
		shouldForce ||
		((currentBytes >= config.targetBytes || (shouldWarn && input.hasOversizedEntries)) && hasWork && meaningfulSavings);

	let reason: string | null = null;
	if (force) {
		reason = "forced";
	} else if (currentBytes >= config.hardBytes && hasWork && meaningfulSavings) {
		reason = "hard-threshold";
	} else if (currentBytes >= config.targetBytes && hasWork && meaningfulSavings) {
		reason = "target-threshold";
	} else if (shouldWarn && input.hasOversizedEntries && meaningfulSavings) {
		reason = "oversized-entry";
	}

	return {
		shouldWarn,
		shouldStage,
		shouldForce,
		reason,
		projectedResultBytes,
		projectedSavingsBytes,
	};
}
