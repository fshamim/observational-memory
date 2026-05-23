import * as fs from "node:fs";
import type { ArchiveChunkManifest } from "../types";
import { getArchiveChunkPath, getRawArchiveDir, getArchivedOriginalSessionPath } from "./om-paths";
import { getEntryApproxBytes, type SessionEntryLike } from "./session-jsonl";

export interface ArchiveWriteResult {
	chunks: ArchiveChunkManifest[];
	archivedOriginalPath?: string;
}

export function writeArchiveChunks(params: {
	cwd: string;
	sessionKey: string;
	entries: SessionEntryLike[];
	targetChunkBytes: number;
	maxChunkBytes: number;
}): ArchiveWriteResult {
	const { cwd, sessionKey, entries } = params;
	const targetChunkBytes = Math.max(1024, params.targetChunkBytes);
	const maxChunkBytes = Math.max(targetChunkBytes, params.maxChunkBytes);
	getRawArchiveDir(sessionKey, cwd);

	if (entries.length === 0) {
		return { chunks: [] };
	}

	const manifests: ArchiveChunkManifest[] = [];
	let chunkIndex = 1;
	let currentChunk: SessionEntryLike[] = [];
	let currentBytes = 0;

	const flush = () => {
		if (currentChunk.length === 0) return;
		const filePath = getArchiveChunkPath(sessionKey, chunkIndex++, cwd);
		const payload = currentChunk.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		fs.writeFileSync(filePath, payload, "utf-8");
		manifests.push({
			path: filePath,
			entryCount: currentChunk.length,
			approxBytes: Buffer.byteLength(payload),
			entryIdStart: String(currentChunk[0]?.id || ""),
			entryIdEnd: String(currentChunk[currentChunk.length - 1]?.id || ""),
		});
		currentChunk = [];
		currentBytes = 0;
	};

	for (const entry of entries) {
		const entryBytes = getEntryApproxBytes(entry);
		const wouldOverflow = currentChunk.length > 0 && currentBytes + entryBytes > targetChunkBytes;
		const mustIsolate = entryBytes >= maxChunkBytes;
		if (wouldOverflow) {
			flush();
		}
		if (mustIsolate) {
			currentChunk = [entry];
			currentBytes = entryBytes;
			flush();
			continue;
		}
		currentChunk.push(entry);
		currentBytes += entryBytes;
	}

	flush();
	return { chunks: manifests };
}

export function archiveOriginalSessionFile(params: {
	cwd: string;
	sessionKey: string;
	sourceSessionPath: string;
}): string | undefined {
	const { cwd, sessionKey, sourceSessionPath } = params;
	if (!sourceSessionPath || !fs.existsSync(sourceSessionPath)) return undefined;
	const targetPath = getArchivedOriginalSessionPath(sessionKey, sourceSessionPath, cwd);
	if (sourceSessionPath === targetPath) return targetPath;
	let resolvedTarget = targetPath;
	let counter = 1;
	while (fs.existsSync(resolvedTarget)) {
		resolvedTarget = `${targetPath}.${counter++}`;
	}
	fs.renameSync(sourceSessionPath, resolvedTarget);
	return resolvedTarget;
}
