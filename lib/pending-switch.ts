import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { PendingSessionSwitchRecord } from "../types";
import { getPendingSwitchPath, writeJsonFileAtomic } from "./om-paths";

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

export function deletePendingSwitch(token: string, cwd = process.cwd()): void {
	const filePath = getPendingSwitchPath(token, cwd);
	try {
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch {
		// ignore cleanup failures
	}
}
