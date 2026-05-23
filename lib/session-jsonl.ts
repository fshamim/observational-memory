import * as fs from "node:fs";
import * as readline from "node:readline";

export type SessionEntryLike = Record<string, any>;

export function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

export function readSessionEntriesSync(filePath: string): SessionEntryLike[] {
	const text = fs.readFileSync(filePath, "utf-8");
	const entries: SessionEntryLike[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		entries.push(JSON.parse(trimmed));
	}
	return entries;
}

export async function readSessionEntriesStream(filePath: string): Promise<SessionEntryLike[]> {
	const entries: SessionEntryLike[] = [];
	const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		entries.push(JSON.parse(trimmed));
	}
	return entries;
}

export async function forEachSessionEntry(
	filePath: string,
	onEntry: (entry: SessionEntryLike, rawLine: string, index: number) => Promise<void> | void,
): Promise<void> {
	let index = 0;
	const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const entry = JSON.parse(trimmed) as SessionEntryLike;
		await onEntry(entry, `${trimmed}\n`, index++);
	}
}

export function writeSessionEntries(filePath: string, entries: SessionEntryLike[]): void {
	const dir = fs.existsSync(filePath) ? undefined : fs.mkdirSync(requireDir(filePath), { recursive: true });
	void dir;
	const tmpPath = `${filePath}.tmp`;
	const out = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	fs.writeFileSync(tmpPath, out, "utf-8");
	fs.renameSync(tmpPath, filePath);
}

function requireDir(filePath: string): string {
	const dir = filePath.replace(/[/\\][^/\\]+$/, "");
	return dir || ".";
}

export function isMessageEntry(entry: SessionEntryLike): boolean {
	return entry?.type === "message" && Boolean(entry?.message);
}

export function getMessageEntries(entries: SessionEntryLike[]): SessionEntryLike[] {
	return entries.filter(isMessageEntry);
}

export function findLatestEntry(entries: SessionEntryLike[], predicate: (entry: SessionEntryLike) => boolean): SessionEntryLike | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (predicate(entries[i])) return entries[i];
	}
	return null;
}

export function getEntryApproxBytes(entry: SessionEntryLike): number {
	return Buffer.byteLength(JSON.stringify(entry)) + 1;
}

export function getMessageContentText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && part.type === "text" ? String(part.text || "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function setMessageContentText(message: any, nextText: string): void {
	if (typeof message?.content === "string") {
		message.content = nextText;
		return;
	}
	if (Array.isArray(message?.content)) {
		let replaced = false;
		message.content = message.content.map((part: any) => {
			if (part && typeof part === "object" && part.type === "text" && !replaced) {
				replaced = true;
				return { ...part, text: nextText };
			}
			if (part && typeof part === "object" && part.type === "text") {
				return { ...part, text: "" };
			}
			return part;
		});
		if (!replaced) {
			message.content.unshift({ type: "text", text: nextText });
		}
		return;
	}
	message.content = nextText;
}

export function makeLinearChild(entry: SessionEntryLike, parentId: string | null): SessionEntryLike {
	const next = cloneJson(entry);
	if (parentId) {
		next.parentId = parentId;
	} else {
		delete next.parentId;
	}
	return next;
}
