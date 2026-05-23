import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createInitialOmState } from "../memory-queues";
import { computeOmContextThresholds } from "../pipeline-planner";
import {
	computeObservationRearmDecision,
	executeObservationPlan,
	planObservationRun,
} from "../observation-pipeline";
import { DEFAULT_CONFIG } from "../types";

function user(text: string): AgentMessage {
	return { role: "user", content: text } as AgentMessage;
}

describe("observation pipeline", () => {
	test("uses the cached oldest-first batch when present", () => {
		const state = createInitialOmState();
		const fullMessages = [user("older"), user("newer")];
		const plan = planObservationRun({
			config: DEFAULT_CONFIG,
			state,
			fullMessages,
			lastFullMessageCount: fullMessages.length,
			lastUnobservedMessages: fullMessages,
			force: false,
			forceObservationOnNextTurn: true,
			hasObservationBatch: true,
			observationBatch: {
				messages: [fullMessages[0]!],
				startIndex: 0,
				endIndex: 1,
				tokens: 5,
			},
			contextWindow: 1000,
		});
		expect(plan).not.toBeNull();
		expect(plan!.batch.startIndex).toBe(0);
		expect(plan!.batch.endIndex).toBe(1);
		expect(plan!.batch.messages).toHaveLength(1);
	});

	test("forced observation falls back to a computed batch", () => {
		const state = createInitialOmState();
		const fullMessages = [
			user("alpha alpha alpha alpha alpha alpha"),
			user("bravo bravo bravo bravo bravo bravo"),
			user("tail"),
		] as AgentMessage[];
		const plan = planObservationRun({
			config: DEFAULT_CONFIG,
			state,
			fullMessages,
			lastFullMessageCount: fullMessages.length,
			lastUnobservedMessages: fullMessages,
			force: true,
			forceObservationOnNextTurn: false,
			hasObservationBatch: false,
			observationBatch: null,
			contextWindow: 60,
		});
		expect(plan).not.toBeNull();
		expect(plan!.batch.messages.length).toBeGreaterThan(0);
		expect(plan!.batch.endIndex).toBeLessThanOrEqual(fullMessages.length - 1);
	});

	test("executes an observation batch and derives experience candidates through injected adapters", async () => {
		const state = createInitialOmState();
		const fullMessages = [user("use python3 instead of python")];
		const plan = planObservationRun({
			config: DEFAULT_CONFIG,
			state,
			fullMessages,
			lastFullMessageCount: fullMessages.length,
			lastUnobservedMessages: fullMessages,
			force: true,
			forceObservationOnNextTurn: false,
			hasObservationBatch: false,
			observationBatch: null,
			contextWindow: 1000,
		});
		expect(plan).not.toBeNull();

		const candidates: string[] = [];
		const result = await executeObservationPlan({
			config: DEFAULT_CONFIG,
			state,
			plan: plan!,
			getAuth: async () => ({}) as any,
			timezone: "UTC",
			cwd: process.cwd(),
			sessionName: "session",
			sessionPath: "/tmp/session.jsonl",
			deps: {
				runObserver: async () => ({ observations: "Use python3 when python is missing.", chunkCount: 1 }),
				deriveExperiencesAfterObservation: async ({ observationItems }: any) => ({
					ops: [{ option: "add", experience: "When python fails, retry with python3." as const }],
					nextExperiences: [
						{
							id: "E000001",
							text: "When python fails, retry with python3.",
							createdAt: "2024-01-01T00:00:00.000Z",
							updatedAt: "2024-01-01T00:00:00.000Z",
							sourceObservationIds: observationItems.map((item: any) => item.id),
						},
					],
					evidence: { toolNames: ["bash"], rawText: "", observationText: "", hasPythonFallback: true, hasStackTraceTargeting: false, hasProjectPathFact: false },
				}),
				upsertExperienceCandidate: (candidate: any) => {
					candidates.push(candidate.text);
					return null as any;
				},
			},
		});

		expect(result.chunkCount).toBe(1);
		expect(result.derivedExperienceCount).toBe(1);
		expect(state.observations).toHaveLength(1);
		expect(state.experiences).toHaveLength(1);
		expect(candidates).toEqual(["When python fails, retry with python3."]);
	});

	test("computes whether observation should remain armed after compaction", () => {
		const thresholds = computeOmContextThresholds({ config: DEFAULT_CONFIG, contextWindow: 1000 });
		expect(
			computeObservationRearmDecision({
				contextTokens: 700,
				contextWindow: 1000,
				observationBatchTokens: 400,
				observationDeltaTokens: 50,
				thresholds,
			}),
		).toBe(false);
		expect(
			computeObservationRearmDecision({
				contextTokens: 900,
				contextWindow: 1000,
				observationBatchTokens: 100,
				observationDeltaTokens: 20,
				thresholds,
			}),
		).toBe(true);
	});
});
