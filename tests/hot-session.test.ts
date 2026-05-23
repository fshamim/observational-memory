import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildHotSessionBundle, createHotSessionPath, estimateArchiveableSavingsBytes, extractBranchMessageEntries } from "../lib/hot-session";
import { readSessionEntriesSync } from "../lib/session-jsonl";
import { DEFAULT_CONFIG } from "../types";

describe("hot session builder", () => {
	test("createHotSessionPath uses numeric rollover suffixes and normalizes legacy hot chains", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "om-hot-path-"));
		try {
			const sourceSessionPath = path.join(cwd, "ghostclaw-main.hot.hot.hot.jsonl");
			fs.writeFileSync(sourceSessionPath, "");
			fs.writeFileSync(path.join(cwd, "ghostclaw-main.jsonl"), "");
			fs.writeFileSync(path.join(cwd, "ghostclaw-main.hot.jsonl"), "");
			fs.writeFileSync(path.join(cwd, "ghostclaw-main.hot.hot.jsonl"), "");
			fs.writeFileSync(path.join(cwd, "ghostclaw-main.hot.hot.hot.jsonl"), "");
			expect(path.basename(createHotSessionPath(sourceSessionPath))).toBe("ghostclaw-main.hot.004.jsonl");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("preserves session name, resets OM cursor, and stubs oversized entries", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "om-hot-session-"));
		try {
			const sourceSessionPath = path.join(cwd, "source.jsonl");
			const allEntries = [
				{ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd },
				{ type: "session_info", id: "si1", parentId: "s1", timestamp: new Date().toISOString(), name: "ghostclaw-main" },
				{ type: "model_change", id: "mc1", parentId: "si1", timestamp: new Date().toISOString(), provider: "openai-codex", modelId: "gpt-5.3-codex" },
				{ type: "thinking_level_change", id: "th1", parentId: "mc1", timestamp: new Date().toISOString(), thinkingLevel: "xhigh" },
				{ type: "message", id: "m1", parentId: "th1", timestamp: new Date().toISOString(), message: { role: "user", content: "hello" } },
				{ type: "message", id: "m2", parentId: "m1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "grep", arguments: {} }] } },
				{ type: "message", id: "m3", parentId: "m2", timestamp: new Date().toISOString(), message: { role: "toolResult", toolName: "steelman_development", content: "X".repeat(300), details: { state: { workflowId: "wf-1", phase: "manual_test_pending" } } } },
			];
			fs.writeFileSync(sourceSessionPath, allEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			const config = {
				...DEFAULT_CONFIG,
				oversizedEntries: {
					...DEFAULT_CONFIG.oversizedEntries,
					entryBytes: 180,
					stubPreviewChars: 40,
				},
			};
			const branchEntries = allEntries.slice(1);
			const branchMessageEntries = extractBranchMessageEntries(branchEntries as any);
			const savings = estimateArchiveableSavingsBytes(branchEntries as any, 1, config as any);
			expect(savings.coveredBytes).toBeGreaterThan(0);
			const targetHotSessionPath = createHotSessionPath(sourceSessionPath);
			const result = buildHotSessionBundle({
				cwd,
				sessionName: "ghostclaw-main",
				token: "tok1",
				reason: "test",
				sourceSessionPath,
				targetHotSessionPath,
				allEntries: allEntries as any,
				branchEntries: branchEntries as any,
				branchMessageEntries: branchMessageEntries as any,
				safeMessageStartIndex: 1,
				state: {
					activeObservations: "obs",
					compactedObservations: "",
					generationCount: 1,
					lastObservedMessageIndex: 1,
					lastObservedTimestamp: new Date().toISOString(),
					totalObservationTokens: 10,
					totalCompactedTokens: 0,
				},
				config: config as any,
			});
			expect(fs.existsSync(result.hotSessionPath)).toBe(true);
			expect(result.coveredEntryIds).toEqual(["m1"]);
			expect(result.trimmedEntryIds).toContain("m3");
			const rebuilt = readSessionEntriesSync(result.hotSessionPath);
			expect(rebuilt.some((entry) => entry.type === "session_info" && entry.name === "ghostclaw-main")).toBe(true);
			const omState = rebuilt.find((entry) => entry.customType === "om:state");
			expect(omState?.data?.state?.lastObservedMessageIndex).toBe(0);
			const rollover = rebuilt.find((entry) => entry.customType === "om:rollover");
			expect(rollover?.data?.token).toBe("tok1");
			const trimmedToolResult = rebuilt.find((entry) => entry.id === "m3");
			expect(JSON.stringify(trimmedToolResult)).toContain("trimmed in hot session");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
