import * as fs from "node:fs";
import * as path from "node:path";

function ensureDir(dirPath: string): string {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
	return dirPath;
}

export function sanitizeSessionKey(value: string): string {
	const trimmed = value.trim();
	const base = trimmed || "session";
	return base
		.replace(/^[/\\]+/, "")
		.replace(/[/\\:]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 120) || "session";
}

export function getProjectOmDir(cwd = process.cwd()): string {
	return ensureDir(path.join(cwd, ".pi", "om"));
}

export function getRawRootDir(cwd = process.cwd()): string {
	return ensureDir(path.join(getProjectOmDir(cwd), "raw"));
}

export function getRawArchiveDir(sessionKey: string, cwd = process.cwd()): string {
	return ensureDir(path.join(getRawRootDir(cwd), sanitizeSessionKey(sessionKey)));
}

export function getPendingSwitchDir(cwd = process.cwd()): string {
	return ensureDir(path.join(getProjectOmDir(cwd), "pending"));
}

export function getExperienceRootDir(cwd = process.cwd()): string {
	return ensureDir(path.join(getProjectOmDir(cwd), "experiences"));
}

export function getExperienceItemsDir(cwd = process.cwd()): string {
	return ensureDir(path.join(getExperienceRootDir(cwd), "items"));
}

export function getExperienceIndexPath(cwd = process.cwd()): string {
	return path.join(getExperienceRootDir(cwd), "index.json");
}

export function getRecoveryReportsDir(cwd = process.cwd()): string {
	return ensureDir(path.join(getProjectOmDir(cwd), "recovery", "reports"));
}

export function getPendingSwitchPath(token: string, cwd = process.cwd()): string {
	return path.join(getPendingSwitchDir(cwd), `${sanitizeSessionKey(token)}.json`);
}

export function getArchiveChunkPath(sessionKey: string, chunkIndex: number, cwd = process.cwd()): string {
	const fileName = `chunk-${String(Math.max(1, chunkIndex)).padStart(6, "0")}.jsonl`;
	return path.join(getRawArchiveDir(sessionKey, cwd), fileName);
}

export function getArchivedOriginalSessionPath(sessionKey: string, originalSessionFile: string, cwd = process.cwd()): string {
	const base = path.basename(originalSessionFile || "session.jsonl");
	return path.join(getRawArchiveDir(sessionKey, cwd), `source-original-${base}`);
}

export function getRecoveryReportPath(sessionKey: string, cwd = process.cwd()): string {
	return path.join(getRecoveryReportsDir(cwd), `${sanitizeSessionKey(sessionKey)}.json`);
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
	ensureDir(path.dirname(filePath));
	const tempPath = `${filePath}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
	fs.renameSync(tempPath, filePath);
}
