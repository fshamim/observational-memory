import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

describe("OM recovery scripts", () => {
	test("reports, recovers, and validates a legacy session", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "om-scripts-"));
		try {
			const sessionPath = path.join(cwd, "legacy.jsonl");
			const outputPath = path.join(cwd, "legacy.hot.jsonl");
			const archiveDir = path.join(cwd, ".pi", "om", "raw", "ghostclaw-main");
			const entries = [
				{ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd },
				{ type: "session_info", id: "si1", parentId: "s1", timestamp: new Date().toISOString(), name: "ghostclaw-main" },
				{ type: "message", id: "m1", parentId: "si1", timestamp: new Date().toISOString(), message: { role: "user", content: "older" } },
				{ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString(), message: { role: "assistant", content: "older reply" } },
				{ type: "custom", id: "st1", parentId: "m2", timestamp: new Date().toISOString(), customType: "om:state", data: { state: { activeObservations: "obs", compactedObservations: "", generationCount: 1, lastObservedMessageIndex: 2, lastObservedTimestamp: new Date().toISOString(), totalObservationTokens: 10, totalCompactedTokens: 0 } } },
				{ type: "message", id: "m3", parentId: "st1", timestamp: new Date().toISOString(), message: { role: "user", content: "newer" } },
				{ type: "message", id: "m4", parentId: "m3", timestamp: new Date().toISOString(), message: { role: "assistant", content: "newer reply" } },
			];
			fs.writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

			const report = spawnSync("python3", ["extensions/observational-memory/scripts/session_report.py", sessionPath], { encoding: "utf-8" });
			expect(report.status).toBe(0);
			expect(report.stdout).toContain("Latest OM cursor: 2");

			const recover = spawnSync(
				"python3",
				[
					"extensions/observational-memory/scripts/recover_large_session.py",
					sessionPath,
					"--output",
					outputPath,
					"--archive-dir",
					archiveDir,
					"--name",
					"ghostclaw-main",
				],
				{ encoding: "utf-8" },
			);
			expect(recover.status).toBe(0);
			expect(fs.existsSync(outputPath)).toBe(true);
			expect(fs.readdirSync(archiveDir).some((name) => name.endsWith(".jsonl"))).toBe(true);

			const validate = spawnSync("python3", ["extensions/observational-memory/scripts/validate_hot_session.py", outputPath], { encoding: "utf-8" });
			expect(validate.status).toBe(0);
			expect(validate.stdout).toContain("VALID:");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
