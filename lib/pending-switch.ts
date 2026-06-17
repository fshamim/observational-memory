import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PendingSessionSwitchRecord } from "../types";
import { getPendingSwitchDir, getPendingSwitchPath, writeJsonFileAtomic } from "./om-paths";

export function createPendingSwitchToken(): string {
	return crypto.randomBytes(12).toString("hex");
}

export function savePendingSwitch(record: PendingSessionSwitchRecord, cwd = process.cwd()): string {
	const filePath = getPendingSwitchPath(record.token, cwd);
	writeJsonFileAtomic(filePath, record);
	return filePath;
}

export function loadPendingSwitch(token: string, cwd = process.cwd()): PendingSessionSwitchRecord | null {
	const filePath = getPendingSwitchPath(token, cwd);
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!raw || typeof raw !== "object") return null;
		return raw as PendingSessionSwitchRecord;
	} catch {
		return null;
	}
}

function normalizeResolvedPath(filePath: string): string {
	const resolved = path.resolve(filePath || "");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function findPendingSwitchBySourceSessionPath(
	sourceSessionPath: string,
	cwd = process.cwd(),
): PendingSessionSwitchRecord | null {
	if (!sourceSessionPath) return null;
	const pendingDir = getPendingSwitchDir(cwd);
	if (!fs.existsSync(pendingDir)) return null;
	const expected = normalizeResolvedPath(sourceSessionPath);
	const matches: PendingSessionSwitchRecord[] = [];
	for (const entry of fs.readdirSync(pendingDir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(pendingDir, entry), "utf-8"));
			if (!raw || typeof raw !== "object") continue;
			const record = raw as PendingSessionSwitchRecord;
			if (normalizeResolvedPath(String(record.sourceSessionPath || "")) !== expected) continue;
			matches.push(record);
		} catch {
			
		}
	}
	if (matches.length === 0) return null;
	matches.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
	return matches[0] || null;
}

export function deletePendingSwitch(token: string, cwd = process.cwd()): void {
	const filePath = getPendingSwitchPath(token, cwd);
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch {
		
	}
}
