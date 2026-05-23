import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectObservationSamplesFromSessionFile,
	formatComparisonReportMarkdown,
	parseOmCompareArgs,
	writeComparisonReport,
	type CompressionComparisonReport,
} from "../compression-compare";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-compare-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

describe("compression compare args", () => {
	test("parses explicit session path and flags", () => {
		const dir = makeTempDir();
		const sessionPath = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionPath, "", "utf-8");

		const parsed = parseOmCompareArgs(`--session ${sessionPath} --samples 9 --min-tokens 18000`, "");
		expect(parsed.sessionPath).toBe(path.resolve(sessionPath));
		expect(parsed.sampleCount).toBe(9);
		expect(parsed.minInputTokens).toBe(18000);
	});

	test("uses fallback session path", () => {
		const dir = makeTempDir();
		const fallbackPath = path.join(dir, "fallback.jsonl");
		fs.writeFileSync(fallbackPath, "", "utf-8");

		const parsed = parseOmCompareArgs("--samples 4", fallbackPath);
		expect(parsed.sessionPath).toBe(path.resolve(fallbackPath));
		expect(parsed.sampleCount).toBe(4);
	});
});

describe("collectObservationSamplesFromSessionFile", () => {
	test("collects largest OM state snapshots from real JSONL shape", async () => {
		const dir = makeTempDir();
		const sessionPath = path.join(dir, "session.jsonl");
		const lines = [
			JSON.stringify({ type: "message", id: "m1" }),
			JSON.stringify({
				type: "custom",
				customType: "om:state",
				id: "om-a",
				timestamp: "2026-04-10T10:00:00.000Z",
				data: {
					eventType: "observation",
					state: {
						activeObservations: "Date: Apr 10, 2026\n* 🔴 alpha\n* 🟡 beta",
						compactedObservations: "",
						generationCount: 0,
						totalObservationTokens: 12000,
						totalCompactedTokens: 0,
					},
				},
			}),
			JSON.stringify({
				type: "custom",
				customType: "om:state",
				id: "om-b",
				timestamp: "2026-04-10T11:00:00.000Z",
				data: {
					eventType: "observation",
					state: {
						activeObservations: "Date: Apr 10, 2026\n* 🔴 huge snapshot\n" + "x".repeat(40000),
						compactedObservations: "Date: Apr 9, 2026\n* 🟡 prior",
						generationCount: 1,
						totalObservationTokens: 50000,
						totalCompactedTokens: 1200,
					},
				},
			}),
		].join("\n");
		fs.writeFileSync(sessionPath, lines, "utf-8");

		const samples = await collectObservationSamplesFromSessionFile(sessionPath, {
			sampleCount: 1,
			minInputTokens: 10000,
		});
		expect(samples.length).toBe(1);
		expect(samples[0].entryId).toBe("om-b");
		expect(samples[0].activeObservationTokens).toBe(50000);
		expect(samples[0].inputTokens).toBeGreaterThan(10000);
	});
});

describe("format/write comparison report", () => {
	test("renders markdown matrix and writes report files", () => {
		const dir = makeTempDir();
		const report: CompressionComparisonReport = {
			createdAt: "2026-04-15T12:00:00.000Z",
			projectCwd: dir,
			sessionPath: "/tmp/session.jsonl",
			configSnapshot: {
				reflectorModel: { provider: "openai-codex", modelId: "gpt-5.4-mini" },
				reflectorPromptTokenLimit: 140000,
				reflectorTimeoutMs: 30000,
				reflectionTriggerContextPercent: 50,
				reflectionTargetContextPercent: 35,
			},
			compareOptions: { sampleCount: 1, minInputTokens: 20000, timeoutMs: 120000, promptTokenLimit: 140000 },
			samples: [],
			aggregate: {
				reflector: {
					algorithm: "reflector",
					sampleCount: 1,
					successCount: 1,
					hardFailureCount: 0,
					hardFailureRatePercent: 0,
					medianTokenReductionPercent: 40,
					medianSignalRetentionPercent: 70,
					medianLossinessPercentEstimate: 30,
					p90LossinessPercentEstimate: 35,
					medianMeaningfulContextGainPercentEstimate: 28,
					meanMeaningfulContextGainTokensEstimate: 12000,
					meanDeadOutputPercentEstimate: 30,
					overallScore: 0.71,
				},
				caveman: {
					algorithm: "caveman",
					sampleCount: 1,
					successCount: 1,
					hardFailureCount: 0,
					hardFailureRatePercent: 0,
					medianTokenReductionPercent: 58,
					medianSignalRetentionPercent: 63,
					medianLossinessPercentEstimate: 37,
					p90LossinessPercentEstimate: 39,
					medianMeaningfulContextGainPercentEstimate: 31,
					meanMeaningfulContextGainTokensEstimate: 14500,
					meanDeadOutputPercentEstimate: 37,
					overallScore: 0.75,
				},
				reobserve: {
					algorithm: "reobserve",
					sampleCount: 1,
					successCount: 1,
					hardFailureCount: 0,
					hardFailureRatePercent: 0,
					medianTokenReductionPercent: 52,
					medianSignalRetentionPercent: 68,
					medianLossinessPercentEstimate: 32,
					p90LossinessPercentEstimate: 36,
					medianMeaningfulContextGainPercentEstimate: 29,
					meanMeaningfulContextGainTokensEstimate: 13000,
					meanDeadOutputPercentEstimate: 32,
					overallScore: 0.74,
				},
			},
			decisionMatrix: {
				criteria: [],
				recommendation: "collect_more_samples",
				reason: "mixed",
			},
		};

		const markdown = formatComparisonReportMarkdown(report);
		expect(markdown).toContain("# OM Compression Comparison Report");
		expect(markdown).toContain("Aggregate score matrix");

		const outputPath = path.join(dir, "report.json");
		const written = writeComparisonReport(report, { cwd: dir, reportPath: outputPath });
		expect(fs.existsSync(written.jsonPath)).toBe(true);
		expect(fs.existsSync(written.markdownPath)).toBe(true);
	});
});
