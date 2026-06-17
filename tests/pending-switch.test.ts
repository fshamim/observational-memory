import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PendingSessionSwitchRecord } from "../types";
import { findPendingSwitchBySourceSessionPath, savePendingSwitch } from "../lib/pending-switch";

const tempDirs: string[] = [];

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-pending-switch-test-"));
	tempDirs.push(dir);
	return dir;
}

function makeRecord(overrides: Partial<PendingSessionSwitchRecord> = {}): PendingSessionSwitchRecord {
	return {
		version: 1,
		token: overrides.token || "tok-1",
		createdAt: overrides.createdAt || "2026-06-18T00:00:00.000Z",
		reason: overrides.reason || "target-threshold",
		sessionName: overrides.sessionName || "session",
		sourceSessionPath: overrides.sourceSessionPath || "/tmp/source.jsonl",
		targetSessionPath: overrides.targetSessionPath || "/tmp/source.hot.001.jsonl",
		coveredEntryIds: overrides.coveredEntryIds || ["1"],
		trimmedEntryIds: overrides.trimmedEntryIds || [],
		archiveChunks: overrides.archiveChunks || [],
		nextState: overrides.nextState,
		cleanupOriginalSessionPath: overrides.cleanupOriginalSessionPath,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("pending switch lookup", () => {
	test("finds the newest pending switch for the active source session", () => {
		const cwd = makeTempProject();
		const sessionPath = path.join(cwd, "sessions", "demo.jsonl");
		fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
		fs.writeFileSync(sessionPath, "");
		savePendingSwitch(makeRecord({ token: "old", createdAt: "2026-06-18T00:00:00.000Z", sourceSessionPath: sessionPath }), cwd);
		savePendingSwitch(makeRecord({ token: "new", createdAt: "2026-06-18T01:00:00.000Z", sourceSessionPath: sessionPath }), cwd);
		savePendingSwitch(makeRecord({ token: "other", createdAt: "2026-06-18T02:00:00.000Z", sourceSessionPath: path.join(cwd, "sessions", "other.jsonl") }), cwd);

		const found = findPendingSwitchBySourceSessionPath(sessionPath, cwd);
		expect(found?.token).toBe("new");
		expect(found?.targetSessionPath).toContain("source.hot.001.jsonl");
	});

	test("returns null when there is no pending switch for the source session", () => {
		const cwd = makeTempProject();
		const sessionPath = path.join(cwd, "sessions", "demo.jsonl");
		fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
		fs.writeFileSync(sessionPath, "");

		const found = findPendingSwitchBySourceSessionPath(sessionPath, cwd);
		expect(found).toBeNull();
	});
});
