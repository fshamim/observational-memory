# Observational Memory

Observational Memory (OM) is a Pi extension that watches growing session context, turns older raw history into observations, optionally compacts observations/reflections further, and can preserve durable memory across long-running sessions.

## Install

Public repo install:

```bash
pi install https://github.com/fshamim/observational-memory.git
```

If you are loading it directly from a checkout during development:

```bash
pi -e extensions/observational-memory/index.ts
```

## Config files

OM always has built-in defaults from `types.ts`.

On first load, OM now **auto-generates** a project-local config file at:

- project: `<project>/.pi/observational-memory.json`

That generated file is a full copy of the current defaults, so users have something concrete to inspect and edit immediately.

OM also supports an optional global override file at:

- global: `~/.pi/agent/extensions/observational-memory/config.json`

### Precedence

Runtime config is built in this order:

1. built-in defaults from `types.ts`
2. global OM config
3. project OM config

Nested objects merge by key, so you only need to specify the fields you want to override.

### Quick start

Minimal project-local override:

```json
{
  "contextWindowSize": 272000,
  "rawMessages": {
    "observeThresholdPercent": 50,
    "oldestScopePercent": 5
  },
  "observations": {
    "reobserveThresholdPercent": 12,
    "oldestScopePercent": 6
  },
  "reflections": {
    "reobserveThresholdPercent": 10,
    "archiveThresholdPercent": 10,
    "archivePlaceholderTokenBudget": 256
  }
}
```

Full starter file:

- `config.example.json`

You can copy it to either config location and edit from there.

## Recommended knobs to experiment with first

If you only want to tune behavior without changing everything, start with these:

- `contextWindowSize`
  - fallback context window when runtime/model metadata is unavailable
- `cacheOptimization.maxPromptContextPercent`
  - caps how much of the prompt OM treats as safely usable working context
- `rawMessages.observeThresholdPercent`
  - when raw-message observation begins
- `rawMessages.oldestScopePercent`
  - how aggressively OM looks into the oldest raw backlog
- `observations.reobserveThresholdPercent`
  - when OM starts compacting accumulated observations
- `observations.oldestScopePercent`
  - how much of the oldest observation backlog is considered first during compaction
- `reflections.reobserveThresholdPercent`
  - when already-compacted reflections become eligible for another compaction pass
- `preserveRecentMessages`
  - how much newest chat tail stays protected from observation
- `experienceBank.maxInjectedExperiences`
  - how many reusable experiences may be injected into the active prompt

## Important compatibility note

Prefer the nested queue fields under:

- `rawMessages`
- `observations`
- `reflections`

Those are the current runtime knobs.

Some top-level fields are legacy compatibility mirrors retained for older configs:

- `observationTriggerContextPercent`
- `observationScopePercent`
- `reflectionTriggerContextPercent`

New configs should usually tune the nested fields instead.

## Field reference

All defaults below come from `extensions/observational-memory/types.ts`.

### Top-level fields

#### `enabled`
- default: `true`
- type: boolean
- master on/off switch for OM
- when `false`, OM does not inject prompt memory, observe, reflect, update its footer, roll over sessions, or use the experience bank

#### `observerModel.provider`
- default: `"openai-codex"`
- type: string
- provider used for observation passes
- in `reobserve` mode, this is also the model doing compaction-style summary work

#### `observerModel.modelId`
- default: `"gpt-5.4-mini"`
- type: string
- model id used for observation passes

#### `reflectorModel.provider`
- default: `"openai-codex"`
- type: string
- provider used for classic reflector mode

#### `reflectorModel.modelId`
- default: `"gpt-5.4-mini"`
- type: string
- model id used for classic reflector mode

#### `compressionStrategy`
- default: `"reobserve"`
- type: string
- allowed values: `"reobserve"`, `"reflector"`
- `reobserve` compacts by re-summarizing existing observations/reflections
- `reflector` uses the dedicated reflector pipeline/model

#### `observationTriggerContextPercent`
- default: `50`
- type: number
- legacy compatibility mirror for when observation should start
- new configs should prefer `rawMessages.observeThresholdPercent`

#### `observationTargetContextPercent`
- default: `30`
- type: number
- OM tries to reduce observation pressure toward this target once observation starts
- runtime normalization keeps this below the effective observation trigger
- clamp range: `1..94`, then normalized to at least `5` and below trigger

#### `observationScopePercent`
- default: `5`
- type: number
- legacy compatibility mirror for how much oldest raw backlog may be considered in a planning pass
- new configs should prefer `rawMessages.oldestScopePercent`

#### `preserveRecentMessages`
- default: `12`
- type: number
- newest raw messages protected from observation so the active tail stays intact
- clamp range: `1..400`

#### `minObservationMessages`
- default: `10`
- type: number
- minimum observation batch size OM will schedule
- clamp range: `1..200`

#### `reflectionTriggerContextPercent`
- default: `12`
- type: number
- legacy compatibility mirror for reflection/reobserve trigger pressure
- new configs should prefer `observations.reobserveThresholdPercent`

#### `reflectionTargetContextPercent`
- default: `5`
- type: number
- target OM tries to reduce observation pressure toward once reflection/compaction starts
- clamp range: `1..89`, then normalized to stay below the effective reflection trigger

#### `contextWindowSize`
- default: `250000`
- type: number
- fallback context window used only when runtime/model metadata does not provide a better value
- clamp range: `10000..Number.MAX_SAFE_INTEGER`

#### `maxReflectionRetries`
- default: `3`
- type: number
- extra retry attempts for reflector-style compression validation
- clamp range: `0..6`

#### `observerPromptTokenLimit`
- default: `160000`
- type: number
- hard cap for observer prompt size
- clamp range: `8000..Number.MAX_SAFE_INTEGER`

#### `reflectorPromptTokenLimit`
- default: `140000`
- type: number
- hard cap for dedicated reflector prompts
- clamp range: `8000..Number.MAX_SAFE_INTEGER`

#### `observerTimeoutMs`
- default: `30000`
- type: number
- timeout for a single observation model call
- clamp range: `1000..Number.MAX_SAFE_INTEGER`

#### `reflectorTimeoutMs`
- default: `30000`
- type: number
- timeout for a single reflector model call
- clamp range: `1000..Number.MAX_SAFE_INTEGER`

#### `observerMaxAttempts`
- default: `3`
- type: number
- total attempts for observation calls on transient failures
- clamp range: `1..6`

#### `reflectorMaxAttempts`
- default: `3`
- type: number
- total attempts for reflector calls on transient failures
- clamp range: `1..6`

#### `retryBaseDelayMs`
- default: `5000`
- type: number
- base retry backoff delay
- clamp range: `250..Number.MAX_SAFE_INTEGER`

#### `retryMaxDelayMs`
- default: `60000`
- type: number
- max retry backoff delay
- clamp range: `1000..Number.MAX_SAFE_INTEGER`

#### `errorNotifyCooldownMs`
- default: `60000`
- type: number
- suppresses repeated OM notifications from spamming too often
- clamp range: `0..Number.MAX_SAFE_INTEGER`

#### `footerRenderThrottleMs`
- default: `1250`
- type: number
- throttle for OM footer redraw work
- clamp range: `50..5000`

#### `footerUsagePollIntervalMs`
- default: `300000`
- type: number
- polling interval for footer usage/quota updates
- clamp range: `0..86400000`
- legacy alias accepted: `codexQuotaPollIntervalMs`

### `cacheOptimization`

#### `cacheOptimization.enabled`
- default: `true`
- type: boolean
- enables cache-aware threshold math instead of treating the full context window as safely usable working context

#### `cacheOptimization.maxPromptContextPercent`
- default: `60`
- type: number
- soft cap for how much of the prompt OM treats as usable working context
- other thresholds can be clamped against this cap
- clamp range: `20..95`

#### `cacheOptimization.snapshotTokenBudget`
- default: `12000`
- type: number
- max number of reflection tokens OM may re-inject as compact snapshot memory
- clamp range: `2000..200000`

#### `cacheOptimization.activeTailTokenBudget`
- default: `2500`
- type: number
- max number of observation tokens OM may re-inject from the active observation tail
- clamp range: `500..50000`

#### `cacheOptimization.minCheckpointTurns`
- default: `6`
- type: number
- in `reobserve` mode, automatic reflection requires at least this many turns since the last checkpoint
- clamp range: `0..200`

#### `cacheOptimization.minCheckpointMs`
- default: `300000`
- type: number
- in `reobserve` mode, automatic reflection also requires at least this much wall-clock time since the last checkpoint
- clamp range: `0..86400000`

### `sessionRollover`

#### `sessionRollover.enabled`
- default: `true`
- type: boolean
- enables OM logic that warns about or prepares rollover for very large session files

#### `sessionRollover.warnBytes`
- default: `10485760` (~10 MiB)
- type: number
- warning threshold for growing session files
- clamp range: `8388608..Number.MAX_SAFE_INTEGER`

#### `sessionRollover.targetBytes`
- default: `20971520` (~20 MiB)
- type: number
- preferred rollover target point
- clamp range: `16777216..Number.MAX_SAFE_INTEGER`
- normalized so final value is always at least `warnBytes`

#### `sessionRollover.hardBytes`
- default: `31457280` (~30 MiB)
- type: number
- harder rollover guardrail
- clamp range: `25165824..Number.MAX_SAFE_INTEGER`
- normalized so final value is always at least `targetBytes`

#### `sessionRollover.legacyRecoveryCandidateBytes`
- default: `41943040` (~40 MiB)
- type: number
- threshold for old very-large sessions that may need recovery treatment
- clamp range: `33554432..Number.MAX_SAFE_INTEGER`

#### `sessionRollover.minProjectedSavingsBytes`
- default: `3145728` (~3 MiB)
- type: number
- OM only bothers rolling over when estimated savings meet or exceed this amount
- clamp range: `1048576..Number.MAX_SAFE_INTEGER`

### `oversizedEntries`

#### `oversizedEntries.entryBytes`
- default: `8388608` (~8 MiB)
- type: number
- any single session entry above this size is treated as oversized
- clamp range: `1024..Number.MAX_SAFE_INTEGER`

#### `oversizedEntries.stubPreviewChars`
- default: `1500`
- type: number
- how many preview characters to keep when replacing an oversized entry with a stub
- clamp range: `120..8000`

#### `oversizedEntries.trimWorkflowToolResults`
- default: `true`
- type: boolean
- special-case trimming for large workflow tool results

### `archive`

#### `archive.targetChunkBytes`
- default: `67108864` (~64 MiB)
- type: number
- preferred archive chunk size during rollover
- clamp range: `1024..Number.MAX_SAFE_INTEGER`

#### `archive.maxChunkBytes`
- default: `134217728` (~128 MiB)
- type: number
- hard ceiling for any archive chunk
- clamp range: `1024..Number.MAX_SAFE_INTEGER`
- normalized so final value is always at least `targetChunkBytes`

#### `archive.preserveOriginalSessionFile`
- default: `true`
- type: boolean
- when true, rollover preserves the original session file instead of deleting it

### `experienceBank`

#### `experienceBank.enabled`
- default: `true`
- type: boolean
- enables reusable experience storage and injection

#### `experienceBank.maxInjectedExperiences`
- default: `3`
- type: number
- max number of matched experiences that may be injected into the active prompt at once
- clamp range: `0..12`

#### `experienceBank.minScoreToInject`
- default: `20`
- type: number
- minimum retrieval score required before an experience may be injected
- clamp range: `-1000..1000`

#### `experienceBank.maxTextChars`
- default: `240`
- type: number
- max characters of each injected experience snippet
- clamp range: `60..2000`

### `rawMessages`

These are the most important current knobs for observation scheduling.

#### `rawMessages.observeThresholdPercent`
- default: `50`
- type: number
- effective runtime threshold where OM begins observing older raw messages
- clamp range: `1..95`

#### `rawMessages.oldestScopePercent`
- default: `5`
- type: number
- how much of the oldest raw backlog the planner considers first when selecting observation work
- clamp range: `1..100`

### `observations`

These are the most important current knobs for compaction in `reobserve` mode.

#### `observations.reobserveThresholdPercent`
- default: `12`
- type: number
- when accumulated observation tokens reach this pressure, OM becomes eligible to compact them into a smaller representation
- clamp range: `1..95`

#### `observations.oldestScopePercent`
- default: `6`
- type: number
- how much of the oldest observation backlog is considered first during reobserve compaction
- clamp range: `1..100`

### `reflections`

#### `reflections.reobserveThresholdPercent`
- default: `10`
- type: number
- when already-compacted reflections themselves grow too large, OM can compact them again
- clamp range: `1..95`

#### `reflections.archiveOldToMemoryMd`
- default: `true`
- type: boolean
- enables archiving older reflections into durable `MEMORY.md`
- archived reflection detail is replaced in prompt-visible memory with a tiny hash-id placeholder

#### `reflections.archiveThresholdPercent`
- default: `10`
- type: number
- minimum active-reflection context percent before a reflection refresh also archives the pre-refresh reflection body to `MEMORY.md`
- placeholder lines do not count toward this threshold
- clamp range: `1..95`

#### `reflections.archivePlaceholderTokenBudget`
- default: `256`
- type: number
- rolling token budget reserved for prompt-visible archive placeholders like `[OM_REFLECTION_ARCHIVE abc123...]`
- older placeholders fall out of the in-prompt reflection section once this budget is exceeded, but remain in `MEMORY.md`
- clamp range: `0..8192`

#### `reflections.memoryMdPath`
- default: `"MEMORY.md"`
- type: string
- relative path where archived reflection memory is written

### `experiences`

#### `experiences.enabled`
- default: `true`
- type: boolean
- enables generation and updating of experience-bank candidates from observations

#### `experiences.generateAfter`
- default: `"observations"`
- type: string
- currently fixed to `"observations"`
- OM generates experiences only after observation runs, not after raw turns or reflection runs

#### `experiences.maxOpsPerObservation`
- default: `4`
- type: number
- max add/modify/merge experience operations allowed per observation-derived pass
- clamp range: `0..10`

#### `experiences.maxWords`
- default: `64`
- type: number
- max words allowed in a generated experience
- clamp range: `16..96`

#### `experiences.mergeSimilarityThreshold`
- default: `0.7`
- type: number
- if two experiences are at least this similar, OM may merge them instead of keeping near-duplicates
- clamp range: `0..1`

## Runtime normalization rules

OM does more than just merge JSON:

- nested objects deep-merge with defaults
- invalid or unreadable config files are ignored and treated like `{}`
- numbers are clamped into safe ranges
- `observationTargetContextPercent` is normalized to stay below the effective observation trigger
- `reflectionTargetContextPercent` is normalized to stay below the effective reflection trigger
- `sessionRollover.targetBytes >= sessionRollover.warnBytes`
- `sessionRollover.hardBytes >= sessionRollover.targetBytes`
- `archive.maxChunkBytes >= archive.targetChunkBytes`

## Suggested workflows

### Use only overrides

For most users, a tiny config is better than copying the full default file.

Example:

```json
{
  "rawMessages": {
    "observeThresholdPercent": 45
  },
  "observations": {
    "reobserveThresholdPercent": 12
  }
}
```

### Start from the full example

If you want to experiment with every knob:

1. copy `config.example.json`
2. put it at either:
   - `~/.pi/agent/extensions/observational-memory/config.json`, or
   - `<project>/.pi/observational-memory.json`
3. change a few fields at a time
4. reload Pi or start a new session

## Source of truth

When in doubt, check:

- `types.ts` for defaults and intended meaning
- `config.ts` for merge behavior, clamp ranges, and normalization logic
