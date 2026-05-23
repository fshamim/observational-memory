import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPendingSwitchToken, deletePendingSwitch, loadPendingSwitch, savePendingSwitch } from "../lib/pending-switch";

describe("pending session switch", () => {
	test("saves, loads, and deletes pending switch records", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "om-pending-switch-"));
		try {
			const token = createPendingSwitchToken();
			savePendingSwitch(
				{
					version: 1,
					token,
					createdAt: new Date().toISOString(),
					reason: "test",
					sessionName: "demo",
					sourceSessionPath: "/tmp/source.jsonl",
					targetSessionPath: "/tmp/target.jsonl",
					coveredEntryIds: ["m1", "m2"],
					trimmedEntryIds: ["m3"],
					archiveChunks: [],
				},
				cwd,
			);
			const loaded = loadPendingSwitch(token, cwd);
			expect(loaded?.targetSessionPath).toBe("/tmp/target.jsonl");
			deletePendingSwitch(token, cwd);
			expect(loadPendingSwitch(token, cwd)).toBeNull();
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
