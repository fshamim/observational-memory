const CAVEMAN_COMPRESSION_GUIDANCE: Record<0 | 1 | 2 | 3, string> = {
	0: "",
	1: `
## COMPRESSION REQUIRED

Compress more aggressively while preserving signal:
- keep dates, decisions, blockers, unresolved tasks, and user constraints
- keep ✅ completion outcomes with concrete resolution
- collapse repeated implementation churn into one concise line
- preserve technical anchors exactly (file paths, code spans, command names, errors)
`,
	2: `
## AGGRESSIVE COMPRESSION REQUIRED

Compress further:
- summarize oldest context into terse high-signal bullets
- preserve only meaningful outcomes and active constraints
- merge repetitive tool/process details into compact summaries
- preserve technical anchors exactly (file paths, code spans, commands, errors)
`,
	3: `
## CRITICAL COMPRESSION REQUIRED

Maximum compression with memory safety:
- keep only durable facts, decisions, blockers, and active next steps
- remove procedural chatter and duplicate narratives
- preserve names, dates, model/provider changes, file paths, errors, and user preferences
- keep recent context higher fidelity than oldest context
`,
};

export function buildCavemanReflectorSystemPrompt(): string {
	return `You are a caveman-style memory compressor for an AI coding agent.

Goal: shrink observational memory hard while keeping decision-critical signal.

Rules:
- Keep technical truth exact.
- Keep dates and temporal ordering.
- Keep user goals/preferences/constraints.
- Keep unresolved blockers and active next steps.
- Keep ✅ completion markers with concrete outcomes.
- Keep technical anchors exactly when present: file paths, inline code, commands, model/provider ids, quoted errors, URLs.
- Remove fluff, repetition, and procedural noise.
- Prefer terse bullets and compressed phrasing.

Output format (required):
<observations>
Date-grouped bullets only.
</observations>

<current-task>
Primary + Secondary task status, concise.
</current-task>

Do not invent facts. If uncertain, preserve the original claim conservatively.`;
}

export function buildCavemanReflectorPrompt(
	observations: string,
	compressionLevel: 0 | 1 | 2 | 3,
): string {
	let prompt = `## OBSERVATIONS TO COMPRESS

${observations}

---

Rewrite this memory in caveman style:
- short, high-signal bullets
- no filler words
- keep core context needed to continue work safely
- preserve technical anchors exactly`;

	const guidance = CAVEMAN_COMPRESSION_GUIDANCE[compressionLevel];
	if (guidance) {
		prompt += `\n\n${guidance}`;
	}

	return prompt;
}
