import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	applyExperienceOps,
	deriveExperiencesAfterObservation,
	extractToolTrajectoryEvidence,
	qualifiesAsExperience,
} from "../experience-miner";
import { DEFAULT_CONFIG, type OmExperienceItem, type OmObservationItem } from "../types";

const now = new Date().toISOString();

function observation(id: string, text: string): OmObservationItem {
	return {
		id,
		text,
		tokenCount: 10,
		createdAt: now,
		source: { messageStartIndex: 0, messageEndIndex: 3 },
	};
}

describe("experience miner", () => {
	test("derives a general python fallback experience from observed tool trajectory", async () => {
		const rawMessages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "python script.py" } }] },
			{ role: "toolResult", toolName: "bash", content: "python: command not found" },
			{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "python3 script.py" } }] },
		] as any as AgentMessage[];
		const result = await deriveExperiencesAfterObservation({
			rawMessages,
			observationItems: [observation("O000001", "Command retried with python3 after python was unavailable.")],
			existingExperiences: [],
			config: DEFAULT_CONFIG,
			rawMessageRange: { messageStartIndex: 0, messageEndIndex: 3 },
		});
		expect(result.ops).toHaveLength(1);
		expect(result.nextExperiences[0]?.text).toContain("python3");
	});

	test("rejects project-specific facts as experiences", () => {
		const evidence = extractToolTrajectoryEvidence([], [observation("O000001", "Saw a fallback.")]);
		expect(qualifiesAsExperience("When editing ghostclaw/src/index.ts, use rg first.", evidence, DEFAULT_CONFIG)).toBeFalse();
		expect(qualifiesAsExperience("When tests fail with stack traces, run the failing command first, then use stack frames to search before editing.", evidence, DEFAULT_CONFIG)).toBeTrue();
	});

	test("modify ops update existing experience text in place", () => {
		const existing: OmExperienceItem[] = [{
			id: "E000001",
			text: "When bash cannot find python, switch tools.",
			createdAt: now,
			updatedAt: now,
			sourceObservationIds: ["O000000"],
		}];
		const next = applyExperienceOps({
			existingExperiences: existing,
			ops: [{ option: "modify", modifiedFrom: "E000001", experience: "When a bash command fails because python is unavailable, retry with python3 before changing the script logic." }],
			evidence: extractToolTrajectoryEvidence([], [observation("O000001", "Retry with python3.")]),
			observationItems: [observation("O000001", "Retry with python3.")],
			config: DEFAULT_CONFIG,
			rawMessageRange: { messageStartIndex: 0, messageEndIndex: 1 },
		});
		expect(next).toHaveLength(1);
		expect(next[0]?.id).toBe("E000001");
		expect(next[0]?.text).toContain("python3");
	});
});
