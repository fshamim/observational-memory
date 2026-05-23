import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { DEFAULT_CONFIG } from "../types";
import {
	alignCursorToToolCallPairs,
	chooseReflectionMode,
	computeOmContextPressure,
	computeOmContextThresholds,
	planPendingObservationSlice,
	shouldArmObservation,
	shouldArmReflection,
	trimMessagesToTokenBudgetKeepingPairs,
} from "../pipeline-planner";
import {
	appendObservationResult,
	appendReflectionFromObservations,
	createInitialOmState,
} from "../memory-queues";

function user(text: string): AgentMessage {
	return { role: "user", content: text } as AgentMessage;
}

describe("pipeline planner", () => {
	test("clamps thresholds against cache prompt cap", () => {
		const thresholds = computeOmContextThresholds({
			config: {
				...DEFAULT_CONFIG,
				rawMessages: { ...DEFAULT_CONFIG.rawMessages, observeThresholdPercent: 90 },
				cacheOptimization: { ...DEFAULT_CONFIG.cacheOptimization, enabled: true, maxPromptContextPercent: 50 },
			},
			contextWindow: 1000,
		});
		expect(thresholds.observationTriggerPercent).toBe(49);
		expect(thresholds.observationTargetPercent).toBe(28);
		expect(thresholds.observationTriggerTokens).toBe(490);
	});

	test("plans the oldest raw slice and realigns cursors to intact tool pairs", () => {
		const state = createInitialOmState();
		state.rawMessageCursor = 1;
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }] },
			{ role: "toolResult", toolName: "bash", toolCallId: "call-1", content: "hi" },
			user("next"),
			user("protected tail"),
		] as any as AgentMessage[];
		const slice = planPendingObservationSlice({
			state,
			messages,
			contextWindow: 100,
			config: {
				rawMessages: { observeThresholdPercent: 70, oldestScopePercent: 25 },
				preserveRecentMessages: 1,
				minObservationMessages: 1,
			},
		});
		expect(slice.cursorWasRealigned).toBe(true);
		expect(slice.cursorIndex).toBe(0);
		expect(slice.batch).not.toBeNull();
		expect(slice.batch!.startIndex).toBe(0);
		expect(slice.batch!.endIndex).toBeLessThanOrEqual(3);
		expect(slice.unobservedMessages).toHaveLength(4);
	});

	test("computes effective context pressure from runtime and estimated tokens", () => {
		const pressure = computeOmContextPressure({
			runtimeContextPercent: 18,
			runtimeContextTokens: 180,
			unobservedTokens: 320,
			contextWindow: 1000,
		});
		expect(pressure.runtimePercent).toBe(18);
		expect(pressure.estimatedPercent).toBe(32);
		expect(pressure.effectivePercent).toBe(32);
		expect(pressure.contextTokens).toBe(180);
	});

	test("observation arming follows hysteresis instead of flapping", () => {
		const thresholds = computeOmContextThresholds({ config: DEFAULT_CONFIG, contextWindow: 1000 });
		expect(shouldArmObservation({ currentArmed: false, effectiveContextPercent: 75, thresholds })).toBe(true);
		expect(shouldArmObservation({ currentArmed: true, effectiveContextPercent: 60, thresholds })).toBe(true);
		expect(shouldArmObservation({ currentArmed: true, effectiveContextPercent: 20, thresholds })).toBe(false);
	});

	test("reflection planning prioritizes observations before reflection refresh", () => {
		const state = createInitialOmState();
		appendObservationResult({ state, observationText: "obs one", messageStartIndex: 0, messageEndIndex: 2 });
		appendReflectionFromObservations({ state, reflectionText: "reflection one", consumedObservationIds: [] });
		state.totalObservationTokens = 500;
		state.totalReflectionTokens = 300;
		const thresholds = {
			...computeOmContextThresholds({ config: DEFAULT_CONFIG, contextWindow: 1000 }),
			reflectionTriggerTokens: 400,
			reflectionRefreshTriggerTokens: 200,
			reflectionTargetTokens: 100,
		};
		expect(chooseReflectionMode({ state, thresholds })).toBe("observations");
		expect(shouldArmReflection({ currentArmed: false, state, thresholds })).toBe(true);
	});

	test("reflection planning refreshes reflections when observation queue is below threshold", () => {
		const state = createInitialOmState();
		appendReflectionFromObservations({ state, reflectionText: "reflection one", consumedObservationIds: [] });
		state.totalObservationTokens = 50;
		state.totalReflectionTokens = 300;
		const thresholds = {
			...computeOmContextThresholds({ config: DEFAULT_CONFIG, contextWindow: 1000 }),
			reflectionTriggerTokens: 400,
			reflectionRefreshTriggerTokens: 200,
			reflectionTargetTokens: 100,
		};
		expect(chooseReflectionMode({ state, thresholds })).toBe("reflections");
	});

	test("tail trimming keeps tool call/result pairs intact", () => {
		const messages = [
			user("older"),
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }] },
			{ role: "toolResult", toolName: "bash", toolCallId: "call-1", content: "hi" },
			user("latest"),
		] as any as AgentMessage[];
		expect(alignCursorToToolCallPairs(messages, 2)).toBe(1);
		const trimmed = trimMessagesToTokenBudgetKeepingPairs(messages, 25);
		expect(trimmed).not.toBeNull();
		expect(trimmed!.messages.some((message: any) => message.role === "assistant")).toBe(true);
		expect(trimmed!.messages.some((message: any) => message.role === "toolResult")).toBe(true);
	});
});
