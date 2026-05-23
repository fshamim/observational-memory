import { estimateStringTokens } from "./token-estimator";

export function splitTextLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));
}

function splitLongLine(text: string, maxTokens: number): string[] {
	const maxChars = Math.max(256, maxTokens * 4);
	const chunks: string[] = [];
	let remaining = text.trim();

	while (remaining.length > maxChars) {
		let splitAt = remaining.lastIndexOf(" ", maxChars);
		if (splitAt < Math.floor(maxChars * 0.5)) {
			splitAt = maxChars;
		}
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}

	if (remaining) {
		chunks.push(remaining);
	}

	return chunks.length > 0 ? chunks : [text];
}

export function chunkLinesByTokenBudget(lines: string[], maxTokens: number): string[] {
	const normalizedBudget = Math.max(128, Math.floor(maxTokens));
	const chunks: string[] = [];
	let currentLines: string[] = [];
	let currentTokens = 0;

	const flush = () => {
		const text = currentLines.join("\n").trim();
		if (text) {
			chunks.push(text);
		}
		currentLines = [];
		currentTokens = 0;
	};

	for (const rawLine of lines) {
		const line = rawLine ?? "";
		const lineTokens = Math.max(1, estimateStringTokens(line) + 1);

		if (lineTokens > normalizedBudget) {
			flush();
			for (const part of splitLongLine(line, normalizedBudget)) {
				chunks.push(part);
			}
			continue;
		}

		if (currentLines.length > 0 && currentTokens + lineTokens > normalizedBudget) {
			flush();
		}

		currentLines.push(line);
		currentTokens += lineTokens;
	}

	flush();
	return chunks;
}

export function chunkTextByTokenBudget(text: string, maxTokens: number): string[] {
	return chunkLinesByTokenBudget(splitTextLines(text), maxTokens);
}

export function takeTailWithinTokenBudget(
	text: string,
	maxTokens: number,
	truncationMarker = "...[truncated earlier context]",
): string {
	if (!text.trim() || maxTokens <= 0) return "";

	const lines = splitTextLines(text);
	const kept: string[] = [];
	let total = 0;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const lineTokens = Math.max(1, estimateStringTokens(line) + 1);

		if (kept.length > 0 && total + lineTokens > maxTokens) {
			break;
		}

		if (kept.length === 0 && lineTokens > maxTokens) {
			const pieces = splitLongLine(line, maxTokens);
			kept.unshift(pieces[pieces.length - 1]);
			total = estimateStringTokens(kept[0]);
			break;
		}

		kept.unshift(line);
		total += lineTokens;
	}

	if (kept.length === 0) return "";
	const result = kept.join("\n").trim();
	if (kept.length === lines.length) return result;

	const markerTokens = estimateStringTokens(truncationMarker) + 1;
	if (markerTokens >= maxTokens) return result;
	return `${truncationMarker}\n${result}`.trim();
}

export function splitTextByTailTokenBudget(
	text: string,
	tailTokenBudget: number,
): {
	headText: string;
	tailText: string;
	headTokens: number;
	tailTokens: number;
} {
	const normalized = String(text || "").trim();
	if (!normalized) {
		return { headText: "", tailText: "", headTokens: 0, tailTokens: 0 };
	}

	const lines = splitTextLines(normalized);
	if (lines.length === 0) {
		return { headText: "", tailText: "", headTokens: 0, tailTokens: 0 };
	}

	const budget = Math.max(0, Math.floor(tailTokenBudget));
	if (budget <= 0) {
		const headText = lines.join("\n").trim();
		return {
			headText,
			tailText: "",
			headTokens: estimateStringTokens(headText),
			tailTokens: 0,
		};
	}

	const kept: string[] = [];
	let total = 0;

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		const lineTokens = Math.max(1, estimateStringTokens(line) + 1);
		if (kept.length > 0 && total + lineTokens > budget) {
			break;
		}
		kept.unshift(line);
		total += lineTokens;
	}

	if (kept.length >= lines.length) {
		const tailText = lines.join("\n").trim();
		return {
			headText: "",
			tailText,
			headTokens: 0,
			tailTokens: estimateStringTokens(tailText),
		};
	}

	const splitIndex = Math.max(0, lines.length - kept.length);
	const headText = lines.slice(0, splitIndex).join("\n").trim();
	const tailText = lines.slice(splitIndex).join("\n").trim();
	return {
		headText,
		tailText,
		headTokens: estimateStringTokens(headText),
		tailTokens: estimateStringTokens(tailText),
	};
}
