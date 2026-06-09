import { describe, expect, test } from "bun:test";
import { buildObservationPromptSections } from "../prompt-sections";
import { DEFAULT_CONFIG } from "../types";
import { createInitialOmState } from "../memory-queues";

describe("prompt sections", () => {
	test("orders reflections before experiences before observations", () => {
		const state = createInitialOmState();
		state.reflections.push({ id: "R000001", text: "older reflection", tokenCount: 3, createdAt: new Date().toISOString(), generation: 1 });
		state.reflections.push({ id: "R000002", text: "[OM_REFLECTION_ARCHIVE abc123def456] Archived prior reflection details in MEMORY.md.", tokenCount: 8, createdAt: new Date().toISOString(), generation: 1, placeholder: true, archivedToMemoryMdHash: "abc123def456", archivedToMemoryMdPath: "MEMORY.md" });
		state.observations.push({ id: "O000001", text: "new observation", tokenCount: 3, createdAt: new Date().toISOString(), source: { messageStartIndex: 0, messageEndIndex: 1 } });
		state.activeObservations = "new observation";
		state.compactedObservations = "older reflection";
		const sections = buildObservationPromptSections({
			state,
			config: DEFAULT_CONFIG,
			experiences: [{
				id: "E000001",
				kind: "decision_rule",
				text: "When bash cannot find python, retry with python3 before changing the script.",
				toolNames: ["bash", "python3"],
				triggerPatterns: ["python"],
				status: "active",
				score: 25,
				rank: "medium",
				retrievedCount: 0,
				appliedCount: 0,
				helpedCount: 0,
				hurtCount: 0,
				ignoredCount: 0,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				source: { sourceSessionName: "s", coveredEntryIds: [] },
				supersedes: [],
			}],
		});
		const joined = sections.join("\n");
		expect(joined.indexOf("## Reflections")).toBeLessThan(joined.indexOf("## Actionable Tool-Use Experiences"));
		expect(joined.indexOf("## Actionable Tool-Use Experiences")).toBeLessThan(joined.indexOf("## Active Observations"));
		expect(joined).toContain("OM_REFLECTION_ARCHIVE abc123def456");
	});
});
