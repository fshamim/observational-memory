import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../types";
import { appendObservationResult, appendReflectionFromObservations, createInitialOmState } from "../memory-queues";
import { executeReflectionPlan, planReflectionRun } from "../reflection-pipeline";

const okValidation = {
	ok: true,
	reason: "ok",
	inputTokens: 10,
	outputTokens: 5,
	compressionRatio: 0.5,
	keywordOverlap: 0.8,
} as const;

describe("reflection pipeline", () => {
	test("plans observation reflection before reflection refresh", () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		appendReflectionFromObservations({ state, reflectionText: "reflection one", consumedObservationIds: [] });
		state.totalObservationTokens = 500;
		state.totalReflectionTokens = 300;
		const plan = planReflectionRun({
			config: DEFAULT_CONFIG,
			state,
			strategy: "reflector",
			contextWindow: 1000,
			completedTurnCount: 8,
			lastReflectionCheckpointTurn: 0,
			lastReflectionCheckpointAtMs: 0,
			nowMs: 50_000,
		});
		expect(plan).not.toBeNull();
		expect(plan!.mode).toBe("observations");
		expect(plan!.maxAttempts).toBe(DEFAULT_CONFIG.reflectorMaxAttempts);
	});

	test("blocks reobserve runs until checkpoint cadence is satisfied", () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		state.totalObservationTokens = 500;
		const plan = planReflectionRun({
			config: {
				...DEFAULT_CONFIG,
				compressionStrategy: "reobserve",
				cacheOptimization: {
					...DEFAULT_CONFIG.cacheOptimization,
					enabled: true,
					minCheckpointTurns: 5,
					minCheckpointMs: 60_000,
				},
			},
			state,
			strategy: "reobserve",
			contextWindow: 1000,
			completedTurnCount: 3,
			lastReflectionCheckpointTurn: 1,
			lastReflectionCheckpointAtMs: 10_000,
			nowMs: 20_000,
		});
		expect(plan).toBeNull();
	});

	test("executes an observation reflection pass through injected adapters", async () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		state.totalObservationTokens = 500;
		const plan = planReflectionRun({
			config: DEFAULT_CONFIG,
			state,
			strategy: "reflector",
			contextWindow: 1000,
			completedTurnCount: 8,
			lastReflectionCheckpointTurn: 0,
			lastReflectionCheckpointAtMs: 0,
			nowMs: 50_000,
		});
		expect(plan).not.toBeNull();
		const applied = await executeReflectionPlan({
			config: DEFAULT_CONFIG,
			state,
			plan: plan!,
			getAuth: async () => ({}) as any,
			cwd: process.cwd(),
			sessionName: "session",
			deps: {
				runReflector: async () => ({
					compactedObservations: "condensed observation",
					compressed: true,
					degenerate: false,
					chunkCount: 1,
				}),
				validateReflectedObservations: () => okValidation,
			},
		});
		expect(applied).toBe(true);
		expect(state.observations).toHaveLength(0);
		expect(state.reflections).toHaveLength(1);
		expect(state.reflections[0]!.text).toContain("condensed observation");
	});

	test("executes a reflection refresh pass and keeps a prompt-visible archive placeholder", async () => {
		const state = createInitialOmState();
		appendReflectionFromObservations({ state, reflectionText: "reflection one", consumedObservationIds: [] });
		state.totalReflectionTokens = 300;
		const plan = planReflectionRun({
			config: DEFAULT_CONFIG,
			state,
			strategy: "reflector",
			force: true,
			contextWindow: 1000,
			completedTurnCount: 8,
			lastReflectionCheckpointTurn: 0,
			lastReflectionCheckpointAtMs: 0,
			nowMs: 50_000,
		});
		expect(plan).not.toBeNull();
		const applied = await executeReflectionPlan({
			config: {
				...DEFAULT_CONFIG,
				reflections: {
					...DEFAULT_CONFIG.reflections,
					archiveOldToMemoryMd: true,
					archiveThresholdPercent: 10,
					archivePlaceholderTokenBudget: 256,
				},
			},
			state,
			plan: { ...plan!, mode: "reflections" },
			getAuth: async () => ({}) as any,
			cwd: process.cwd(),
			sessionName: "session",
			deps: {
				runReflector: async () => ({
					compactedObservations: "refreshed reflection",
					compressed: true,
					degenerate: false,
					chunkCount: 1,
				}),
				appendReflectionsToMemoryMd: async () => ({ path: "MEMORY.md", hash: "hash-123", appended: true }),
				validateReflectedObservations: () => okValidation,
			},
		});
		expect(applied).toBe(true);
		expect(state.reflections).toHaveLength(2);
		expect(state.reflections[0]!.placeholder).toBe(true);
		expect(state.reflections[0]!.text).toContain("OM_REFLECTION_ARCHIVE");
		expect(state.reflections[0]!.archivedToMemoryMdHash).toBe("hash-123");
		expect(state.reflections[1]!.text).toContain("refreshed reflection");
	});
});
