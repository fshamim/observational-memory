import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			total += estimateStringTokens(msg.content);
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text") {
					total += estimateStringTokens(part.text);
				} else if (part.type === "toolCall") {
					total += estimateStringTokens(part.name + JSON.stringify(part.arguments));
				}
			}
		}
		// Overhead per message for role, metadata
		total += 10;
	}
	return total;
}
