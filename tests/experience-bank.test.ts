import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	deriveExperienceCandidatesFromMessages,
	listExperienceRecords,
	registerExperienceOutcome,
	selectRelevantExperiences,
	upsertExperienceCandidate,
} from "../lib/experience-bank";
import { DEFAULT_CONFIG } from "../types";

describe("experience bank", () => {
	test("derives candidates, persists them, and retrieves relevant experiences", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "om-exp-bank-"));
		try {
			const candidates = deriveExperienceCandidatesFromMessages({
				messages: [
					{ role: "user", content: "please use rg instead of grep for this search" } as any,
				],
				sourceSessionName: "ghostclaw-main",
				sourceSessionPath: "/tmp/session.jsonl",
				coveredEntryIds: ["u1"],
				entryIdStart: "u1",
				entryIdEnd: "u1",
			});
			expect(candidates.length).toBeGreaterThan(0);
			for (const candidate of candidates) {
				upsertExperienceCandidate(
					{
						kind: candidate.kind,
						text: candidate.text,
						toolNames: candidate.toolNames,
						triggerPatterns: candidate.triggerPatterns,
						status: candidate.status,
						source: candidate.source,
						supersedes: candidate.supersedes,
					},
					cwd,
				);
			}
			registerExperienceOutcome(listExperienceRecords(cwd).map((record) => record.id), "helped", listExperienceRecords(cwd).map((record) => record.id), cwd);
			const selected = selectRelevantExperiences({
				cwd,
				text: "search the repo with rg instead of grep",
				toolHints: ["rg"],
				config: DEFAULT_CONFIG.experienceBank,
			});
			expect(selected.length).toBeGreaterThan(0);
			expect(selected[0]?.toolNames).toContain("rg");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
