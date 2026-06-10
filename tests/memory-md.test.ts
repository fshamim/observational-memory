import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendReflectionsToMemoryMd,
	buildReflectionArchivePlaceholder,
	isReflectionArchivePlaceholderText,
	resolveMemoryMdPath,
} from "../memory-md";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("memory.md archiving", () => {
	test("builds a stable prompt-visible archive placeholder", () => {
		const text = buildReflectionArchivePlaceholder({ hash: "abcdef1234567890", memoryMdPath: "MEMORY.md" });
		expect(text).toContain("OM_REFLECTION_ARCHIVE abcdef123456");
		expect(text).toContain("MEMORY.md");
		expect(isReflectionArchivePlaceholderText(text)).toBeTrue();
	});

	test("appends a deduplicated reflection archive block", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "om-memory-md-"));
		tempDirs.push(cwd);
		const args = {
			cwd,
			configuredPath: "MEMORY.md",
			sessionName: "session-a",
			generation: 3,
			reflections: [{ id: "R000001", text: "reflection body", tokenCount: 4, createdAt: new Date().toISOString(), generation: 3 }],
		};
		const first = await appendReflectionsToMemoryMd(args);
		const second = await appendReflectionsToMemoryMd(args);
		const filePath = resolveMemoryMdPath(cwd, "MEMORY.md");
		const content = fs.readFileSync(filePath, "utf-8");
		expect(first.appended).toBeTrue();
		expect(second.appended).toBeFalse();
		expect(content.match(/OM_REFLECTION_ARCHIVE/g)?.length).toBe(2);
		expect(content).toContain("reflection body");
	});
});
