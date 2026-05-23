import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	appendObservationResult,
	appendReflectionFromObservations,
	computeQueueTokenTotals,
	createInitialOmState,
	normalizeOmState,
	selectOldestObservationBatch,
	selectOldestRawMessageBatch,
	serializeOmState,
} from "../memory-queues";

function msg(text: string): AgentMessage {
	return { role: "user", content: text } as AgentMessage;
}

describe("memory queues", () => {
	test("normalizes legacy string state into observation and reflection queues", () => {
		const state = normalizeOmState({
			generationCount: 2,
			lastObservedMessageIndex: 7,
			activeObservations: "obs one\n\nobs two",
			compactedObservations: "reflection one",
			totalObservationTokens: 0,
			totalCompactedTokens: 0,
		});
		expect(state).not.toBeNull();
		expect(state!.rawMessageCursor).toBe(7);
		expect(state!.observations).toHaveLength(1);
		expect(state!.reflections).toHaveLength(1);
		expect(state!.activeObservations).toContain("obs one");
		expect(state!.compactedObservations).toContain("reflection one");
		expect(state!.totalObservationTokens).toBeGreaterThan(0);
		expect(state!.totalReflectionTokens).toBeGreaterThan(0);
	});

	test("selects oldest raw-message slice by token budget while preserving recent tail", () => {
		const messages = [
			msg("alpha alpha alpha alpha alpha alpha"),
			msg("bravo bravo bravo bravo bravo bravo"),
			msg("charlie charlie charlie charlie charlie charlie"),
			msg("delta delta delta delta delta delta"),
		] as AgentMessage[];
		const batch = selectOldestRawMessageBatch({
			messages,
			cursor: 0,
			contextWindow: 40,
			oldestScopePercent: 25,
			preserveRecentMessages: 1,
			minMessages: 1,
		});
		expect(batch).not.toBeNull();
		expect(batch!.startIndex).toBe(0);
		expect(batch!.endIndex).toBeLessThanOrEqual(3);
		expect(batch!.messages.length).toBeGreaterThan(0);
		expect(batch!.messages.length).toBeLessThan(4);
	});

	test("observation compaction removes only consumed observations and appends reflections", () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		appendObservationResult({ state, observationText: "obs two", messageStartIndex: 2, messageEndIndex: 4 });
		const batch = selectOldestObservationBatch({ state, contextWindow: 100, oldestScopePercent: 25 });
		appendReflectionFromObservations({
			state,
			reflectionText: "reflection one",
			consumedObservationIds: batch!.items.map((item) => item.id),
		});
		computeQueueTokenTotals(state);
		expect(state.reflections).toHaveLength(1);
		expect(state.compactedObservations).toContain("reflection one");
		expect(state.observations.length).toBe(1);
		expect(state.activeObservations).toContain("obs two");
		expect(state.activeObservations).not.toContain("obs one");
	});

	test("serialized state writes canonical queue fields only", () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		appendReflectionFromObservations({
			state,
			reflectionText: "reflection one",
			consumedObservationIds: state.observations.map((item) => item.id),
		});
		const serialized = serializeOmState(state);
		expect(serialized.schemaVersion).toBe(2);
		expect(serialized.rawMessageCursor).toBe(2);
		expect(serialized).not.toHaveProperty("activeObservations");
		expect(serialized).not.toHaveProperty("compactedObservations");
		expect(serialized).not.toHaveProperty("lastObservedMessageIndex");
		expect(serialized).not.toHaveProperty("totalCompactedTokens");
	});
});
