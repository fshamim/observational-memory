import { takeTailWithinTokenBudget } from "./chunking";
import { formatExperiencesForPrompt } from "./lib/experience-bank";
import {
	formatActiveReflectionItems,
	formatArchivedReflectionPlaceholderItems,
	formatObservationItems,
} from "./memory-queues";
import type { ExperienceRecord, ObservationState, ObservationalMemoryConfig } from "./types";

export function buildObservationPromptSections(args: {
	state: ObservationState;
	config: ObservationalMemoryConfig;
	experiences: ExperienceRecord[];
}): string[] {
	const sections: string[] = [];
	const cacheEnabled = args.config.cacheOptimization.enabled;
	const reflectionPlaceholderText = formatArchivedReflectionPlaceholderItems(
		args.state.reflections,
		args.config.reflections.archivePlaceholderTokenBudget,
	);
	const reflectionActiveBudget = cacheEnabled
		? Math.max(0, args.config.cacheOptimization.snapshotTokenBudget - args.config.reflections.archivePlaceholderTokenBudget)
		: args.config.cacheOptimization.snapshotTokenBudget;
	const reflectionsText = formatActiveReflectionItems(args.state.reflections);
	const reflectionsForPrompt = cacheEnabled
		? takeTailWithinTokenBudget(reflectionsText, reflectionActiveBudget)
		: reflectionsText;
	const combinedReflectionText = [reflectionsForPrompt, reflectionPlaceholderText].filter(Boolean).join("\n\n").trim();
	if (combinedReflectionText) {
		sections.push(
			"## Reflections",
			"Trust current messages over these memories if they conflict.",
			"",
			combinedReflectionText,
		);
	}
	if (args.experiences.length > 0) {
		sections.push(
			"## Actionable Tool-Use Experiences",
			"Use these only when the current task clearly matches the condition.",
			formatExperiencesForPrompt(args.experiences, args.config.experienceBank.maxTextChars),
		);
	}
	const observationsText = formatObservationItems(args.state.observations);
	const observationsForPrompt = cacheEnabled
		? takeTailWithinTokenBudget(observationsText, args.config.cacheOptimization.activeTailTokenBudget)
		: observationsText;
	if (observationsForPrompt) {
		sections.push(
			"## Active Observations",
			"Trust current messages over these memories if they conflict.",
			"",
			observationsForPrompt,
		);
	}
	return sections;
}

export function buildObservationPromptSuffix(args: {
	state: ObservationState;
	config: ObservationalMemoryConfig;
	experiences: ExperienceRecord[];
}): string {
	const sections = buildObservationPromptSections(args);
	return sections.length > 0 ? `\n\n${sections.join("\n")}` : "";
}

export function stripObservationPromptSuffix(systemPrompt: string): string {
	if (!systemPrompt) return systemPrompt;
	const markers = [
		"\n\n## Reflections",
		"\n\n## Actionable Tool-Use Experiences",
		"\n\n## Active Observations",
		"\n\n## Compacted Observational Memory",
		"\n\n## Active Observational Memory",
		"\n\n## Relevant Operational Experiences",
	];
	let markerIndex = -1;
	for (const marker of markers) {
		const idx = systemPrompt.indexOf(marker);
		if (idx >= 0 && (markerIndex === -1 || idx < markerIndex)) {
			markerIndex = idx;
		}
	}
	return markerIndex >= 0 ? systemPrompt.slice(0, markerIndex) : systemPrompt;
}
