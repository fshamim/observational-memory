import { describe, expect, test } from "bun:test";
import { isMissingProviderApiKeyError, prefersProviderManagedAuth } from "../auth";

describe("auth helpers", () => {
	test("prefers provider-managed auth for openai-codex", () => {
		expect(prefersProviderManagedAuth({ provider: "openai-codex" } as any)).toBe(true);
		expect(prefersProviderManagedAuth({ provider: "google" } as any)).toBe(false);
	});

	test("detects provider-managed auth missing-key fallback errors", () => {
		expect(isMissingProviderApiKeyError(new Error("No API key for provider: openai-codex"), "openai-codex")).toBe(true);
		expect(isMissingProviderApiKeyError(new Error("No API key for provider: google"), "openai-codex")).toBe(false);
	});
});
