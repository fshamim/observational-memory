import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { OmReflectionItem } from "./types";
import { formatReflectionItems } from "./memory-queues";
export { buildReflectionArchivePlaceholder, isReflectionArchivePlaceholderText, shortenReflectionArchiveHash } from "./reflection-archive-placeholder";

function expandHome(filePath: string): string {
	if (!filePath.startsWith("~")) return filePath;
	return path.join(os.homedir(), filePath.slice(1));
}

export function resolveMemoryMdPath(cwd: string, configuredPath: string): string {
	const raw = String(configuredPath || "MEMORY.md").trim() || "MEMORY.md";
	const expanded = expandHome(raw);
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
}

export function buildMemoryMdArchiveBlock(args: {
	sessionName: string;
	generation: number;
	reflections: OmReflectionItem[];
	timestamp?: string;
}): { hash: string; text: string } {
	const timestamp = args.timestamp || new Date().toISOString();
	const reflectionText = formatReflectionItems(args.reflections).trim();
	const hash = createHash("sha256")
		.update(JSON.stringify({
			sessionName: args.sessionName,
			generation: args.generation,
			reflectionText,
		}))
		.digest("hex");
	const text = [
		"",
		`<!-- OM_REFLECTION_ARCHIVE hash=${hash} session=${args.sessionName} generation=${args.generation} -->`,
		"",
		`## Observational Memory Reflection Archive — ${timestamp}`,
		"",
		`Session: \`${args.sessionName}\``,
		`Generation: \`${args.generation}\``,
		`Hash: \`${hash}\``,
		"",
		reflectionText,
		"",
		"<!-- /OM_REFLECTION_ARCHIVE -->",
		"",
	].join("\n");
	return { hash, text };
}

export async function appendReflectionsToMemoryMd(args: {
	cwd: string;
	configuredPath: string;
	sessionName: string;
	generation: number;
	reflections: OmReflectionItem[];
	timestamp?: string;
}): Promise<{ path: string; hash: string; appended: boolean }> {
	const filePath = resolveMemoryMdPath(args.cwd, args.configuredPath);
	const { hash, text } = buildMemoryMdArchiveBlock(args);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
	if (existing.includes(`OM_REFLECTION_ARCHIVE hash=${hash} `)) {
		return { path: filePath, hash, appended: false };
	}
	const next = existing ? `${existing.replace(/\s*$/, "")}\n${text}` : `${text.trimStart()}`;
	fs.writeFileSync(filePath, next, "utf-8");
	return { path: filePath, hash, appended: true };
}
