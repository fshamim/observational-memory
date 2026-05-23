import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalConfigPath, loadConfig } from "../config";
import { DEFAULT_CONFIG } from "../types";

let tempDir = "";
let backupPath = "";
const globalConfigPath = getGlobalConfigPath();

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "om-config-test-"));
	backupPath = `${globalConfigPath}.bak-om-test`;
	fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
	if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
	if (fs.existsSync(globalConfigPath)) fs.renameSync(globalConfigPath, backupPath);
});

afterEach(() => {
	if (fs.existsSync(globalConfigPath)) fs.rmSync(globalConfigPath, { force: true });
	if (fs.existsSync(backupPath)) fs.renameSync(backupPath, globalConfigPath);
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("OM config loading", () => {
	test("project config overrides global config and thresholds are configurable", () => {
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({
				sessionRollover: { warnBytes: 16 * 1024 * 1024, targetBytes: 24 * 1024 * 1024, hardBytes: 32 * 1024 * 1024 },
				oversizedEntries: { entryBytes: 1234 },
			}),
		);
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "observational-memory.json"),
			JSON.stringify({
				sessionRollover: { targetBytes: 40 * 1024 * 1024, hardBytes: 48 * 1024 * 1024 },
				oversizedEntries: { entryBytes: 4321 },
				experienceBank: { maxInjectedExperiences: 5 },
				footerUsagePollIntervalMs: 420000,
			}),
		);

		const config = loadConfig(tempDir);
		expect(config.sessionRollover.warnBytes).toBe(16 * 1024 * 1024);
		expect(config.sessionRollover.targetBytes).toBe(40 * 1024 * 1024);
		expect(config.sessionRollover.hardBytes).toBe(48 * 1024 * 1024);
		expect(config.oversizedEntries.entryBytes).toBe(4321);
		expect(config.experienceBank.maxInjectedExperiences).toBe(5);
		expect(config.footerUsagePollIntervalMs).toBe(420000);
	});

	test("legacy codex poll field maps to footer usage poll interval", () => {
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({
				codexQuotaPollIntervalMs: 180000,
			}),
		);
		const config = loadConfig(tempDir);
		expect(config.footerUsagePollIntervalMs).toBe(180000);
	});

	test("defaults footer usage poll interval to five minutes", () => {
		const config = loadConfig(tempDir);
		expect(config.footerUsagePollIntervalMs).toBe(300000);
		expect(config.compressionStrategy).toBe("reobserve");
		expect(config.cacheOptimization.maxPromptContextPercent).toBe(50);
	});

	test("supports low observation trigger/target thresholds for <50% guardrails", () => {
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({
				observationTriggerContextPercent: 45,
				observationTargetContextPercent: 33,
			}),
		);
		const config = loadConfig(tempDir);
		expect(config.observationTriggerContextPercent).toBe(45);
		expect(config.observationTargetContextPercent).toBe(33);
	});

	test("compression strategy and cache optimization settings are configurable", () => {
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({
				compressionStrategy: "reflector",
				cacheOptimization: {
					enabled: true,
					maxPromptContextPercent: 47,
					snapshotTokenBudget: 8000,
					activeTailTokenBudget: 1600,
					minCheckpointTurns: 3,
					minCheckpointMs: 90000,
				},
			}),
		);
		const config = loadConfig(tempDir);
		expect(config.compressionStrategy).toBe("reflector");
		expect(config.cacheOptimization.maxPromptContextPercent).toBe(47);
		expect(config.cacheOptimization.snapshotTokenBudget).toBe(8000);
		expect(config.cacheOptimization.activeTailTokenBudget).toBe(1600);
		expect(config.cacheOptimization.minCheckpointTurns).toBe(3);
		expect(config.cacheOptimization.minCheckpointMs).toBe(90000);
	});

	test("legacy reflection keys are ignored", () => {
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({
				reflectionObservationContextPercent: 41,
				forceReflectContextPercent: 10,
			}),
		);
		const config = loadConfig(tempDir);
		expect(config.reflectionTriggerContextPercent).toBe(DEFAULT_CONFIG.reflectionTriggerContextPercent);
		expect(config.reflectionTargetContextPercent).toBe(DEFAULT_CONFIG.reflectionTargetContextPercent);
	});

	test("reflection trigger/target fields normalize to a valid hysteresis window", () => {
		fs.writeFileSync(
			globalConfigPath,
			JSON.stringify({
				reflectionTriggerContextPercent: 33,
				reflectionTargetContextPercent: 45,
			}),
		);
		const config = loadConfig(tempDir);
		expect(config.reflectionTriggerContextPercent).toBe(33);
		expect(config.reflectionTargetContextPercent).toBe(32);
	});
});
