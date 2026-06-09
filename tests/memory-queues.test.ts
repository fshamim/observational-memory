import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	appendObservationResult,
	appendReflectionFromObservations,
	computeQueueTokenTotals,
	createInitialOmState,
	normalizeOmState,
	replaceReflectionsAfterArchive,
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

	test("reflection archive placeholders stay prompt-visible but out of active reflection totals", () => {
		const state = createInitialOmState();
		appendReflectionFromObservations({
			state,
			reflectionText: "reflection one",
			consumedObservationIds: [],
		});
		replaceReflectionsAfterArchive({
			state,
			reflectionText: "refreshed reflection",
			archivedHash: "hash-1234567890",
			archivedPath: "MEMORY.md",
			placeholderTokenBudget: 256,
		});
		expect(state.reflections).toHaveLength(2);
		expect(state.reflections[0]!.placeholder).toBe(true);
		expect(state.reflections[0]!.text).toContain("OM_REFLECTION_ARCHIVE");
		expect(state.reflections[1]!.text).toBe("refreshed reflection");
		expect(state.totalReflectionTokens).toBe(state.reflections[1]!.tokenCount);
		expect(state.compactedObservations).toBe("refreshed reflection");
	});

	test("serialized state writes canonical queue fields only", () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		appendReflectionFromObservations({
			state,
			reflectionText: "reflection one",
			consumedObservationIds: state.observations.map((item) => item.id),
		});
		replaceReflectionsAfterArchive({
			state,
			reflectionText: "refreshed reflection",
			archivedHash: "hash-1234567890",
			archivedPath: "MEMORY.md",
			placeholderTokenBudget: 256,
		});
		const serialized = serializeOmState(state);
		expect(serialized.schemaVersion).toBe(2);
		expect(serialized.rawMessageCursor).toBe(2);
		expect(serialized).not.toHaveProperty("activeObservations");
		expect(serialized).not.toHaveProperty("compactedObservations");
		expect(serialized).not.toHaveProperty("lastObservedMessageIndex");
		expect(serialized).not.toHaveProperty("totalCompactedTokens");
		expect((serialized.reflections as any[])[0]).toHaveProperty("placeholder", true);
		expect((serialized.reflections as any[])[0]).toHaveProperty("archivedToMemoryMdPath", "MEMORY.md");
	});
});
