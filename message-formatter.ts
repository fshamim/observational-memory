import type { AgentMessage } from "@mariozechner/pi-agent-core";

function formatTimestamp(timestamp: number | undefined, timezone: string): string {
	if (!timestamp) return "";
	try {
		return new Date(timestamp).toLocaleString("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	} catch {
		return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
	}
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "...";
}

export function formatMessagesForObserverLines(messages: AgentMessage[], timezone: string): string[] {
	const lines: string[] = [];

	for (const msg of messages) {
		const ts = formatTimestamp((msg as any).timestamp, timezone);
		const role = (msg as any).role as string;

		if (typeof msg.content === "string") {
			lines.push(`[${ts}] [${role}]: ${msg.content}`);
			continue;
		}

		if (!Array.isArray(msg.content)) continue;

		for (const part of msg.content) {
			if (part.type === "text") {
				lines.push(`[${ts}] [${role}]: ${part.text}`);
			} else if (part.type === "toolCall") {
				const args = truncate(JSON.stringify(part.arguments), 200);
				lines.push(`[${ts}] [assistant tool_call]: ${part.name}(${args})`);
			} else if (part.type === "image") {
				lines.push(`[${ts}] [image attachment]`);
			} else if (part.type === "thinking") {
				// omit internal reasoning from observational memory
			}
		}

		if (role === "toolResult") {
			const toolMsg = msg as any;
			const toolName = toolMsg.toolName || "unknown";
			let resultText = "";
			if (typeof toolMsg.content === "string") {
				resultText = truncate(toolMsg.content, 500);
			} else if (Array.isArray(toolMsg.content)) {
				resultText = toolMsg.content
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text)
					.join("\n");
				resultText = truncate(resultText, 500);
			}
			lines.push(`[${ts}] [tool_result ${toolName}]: ${resultText}`);
		}
	}

	return lines;
}

export function formatMessagesForObserver(messages: AgentMessage[], timezone: string): string {
	return formatMessagesForObserverLines(messages, timezone).join("\n");
}
