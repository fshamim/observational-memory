const PLACEHOLDER_PREFIX = "OM_REFLECTION_ARCHIVE";
const DEFAULT_HASH_LENGTH = 12;

export function shortenReflectionArchiveHash(hash: string, length = DEFAULT_HASH_LENGTH): string {
	const normalized = String(hash || "").trim().toLowerCase();
	if (!normalized) return "unknown";
	return normalized.slice(0, Math.max(6, Math.floor(length)));
}

export function buildReflectionArchivePlaceholder(args: {
	hash: string;
	memoryMdPath: string;
}): string {
	const displayPath = String(args.memoryMdPath || "MEMORY.md").trim() || "MEMORY.md";
	return `[${PLACEHOLDER_PREFIX} ${shortenReflectionArchiveHash(args.hash)}] Archived prior reflection details in ${displayPath}.`;
}

export function isReflectionArchivePlaceholderText(text: string): boolean {
	return /^\[OM_REFLECTION_ARCHIVE\s+[a-z0-9]{6,64}\]/i.test(String(text || "").trim());
}
