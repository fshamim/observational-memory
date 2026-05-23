# Observational Memory Three-Queue Implementation Plan

This plan is written for an autonomous implementation agent. Do **not** ask the user follow-up questions. If code and this plan disagree, prefer this plan for the target behavior, preserve existing public behavior where it does not conflict, and verify with automated tests before finishing.

## Target behavior summary

Observational Memory must become a simple three-queue pipeline:

```text
raw session messages -> observations -> reflections -> refreshed reflections
```

1. **Raw messages -> observations**
   - When raw-message context reaches the configured threshold, observe the configured oldest slice of **unobserved raw messages only**.
   - Append the observer output to `observations`.
   - Advance the raw-message cursor only after successful observation.
   - Create XSkill-qualified tool-use experiences only after this successful observation, using both the raw slice and the new observations as evidence.

2. **Observations -> reflections**
   - When observation tokens reach the configured threshold, reobserve/reflect the configured oldest slice of **observations only**.
   - Append the result to existing `reflections`.
   - Remove the reflected observations from active `observations` after success.
   - Do not pass existing reflections into this step.
   - Do not create experiences in this step.

3. **Reflections -> refreshed reflections**
   - When reflection tokens reach the configured threshold, reobserve **all current reflections**.
   - Before replacing old reflections, append the old reflections to `MEMORY.md`, creating it if needed.
   - Replace old reflections with the refreshed reflections only after the archive write succeeds.
   - Leave observations unchanged.
   - Do not create experiences in this step.

Prompt injection order must be:

```text
## Reflections
...

## Actionable Tool-Use Experiences
...

## Active Observations
...
```

---

## Non-negotiable invariants

- Production naming must use **observations** and **reflections**.
- Legacy names are allowed only in migration compatibility/tests:
  - `activeObservations` -> `observations`
  - `compactedObservations` -> `reflections`
  - `totalCompactedTokens` -> `totalReflectionTokens`
- Raw observation never reobserves previous observations.
- Observation reobserve never includes existing reflections.
- Reflection refresh never mutates observations.
- Experiences are created only after raw-message observation succeeds.
- Experiences are injected between reflections and observations.
- Old reflections are archived to `MEMORY.md` before being replaced.
- Failed archive write prevents reflection replacement.
- All queue transitions are oldest-first and cursor/id based.

---

## Relevant source files

Start by reading these files:

```text
extensions/observational-memory/types.ts
extensions/observational-memory/state.ts
extensions/observational-memory/config.ts
extensions/observational-memory/index.ts
extensions/observational-memory/observer.ts
extensions/observational-memory/reobserver.ts
extensions/observational-memory/reflector.ts
extensions/observational-memory/prompts.ts
extensions/observational-memory/message-formatter.ts
extensions/observational-memory/token-estimator.ts
extensions/observational-memory/lib/experience-bank.ts
extensions/observational-memory/lib/om-paths.ts
extensions/observational-memory/tests/*.test.ts
```

Also use local XSkill references for experience design:

```text
../myPi/XSkill/README.md
../myPi/XSkill/eval/exskill/trajectory_summary.py
../myPi/XSkill/eval/exskill/experience_critique.py
../myPi/XSkill/eval/exskill/experience_manager.py
../myPi/XSkill/eval/prompts/experience_prompts.py
```

XSkill concepts to preserve:

- trajectory summary before experience extraction
- cross-rollout/trajectory critique
- action-level experiences, not factual memories
- add/modify operations from critique
- merge/refine by similarity/consolidation
- experiences under ~64 words
- condition-action form
- generalizable tool-use guidance

---

## Canonical config

Implement or normalize config to this shape inside the extension config system. Keep existing project/global config loading behavior.

```ts
interface ObservationalMemoryQueueConfig {
  rawMessages: {
    observeThresholdPercent: number; // default 70
    oldestScopePercent: number;      // default 25
  };
  observations: {
    reobserveThresholdPercent: number; // default 40
    oldestScopePercent: number;        // default 25
  };
  reflections: {
    reobserveThresholdPercent: number; // default 20
    archiveOldToMemoryMd: boolean;     // default true
    memoryMdPath: string;              // default "MEMORY.md"
  };
  experiences: {
    enabled: boolean;                  // default true
    generateAfter: "observations";     // only supported value for now
    maxOpsPerObservation: number;      // default 4
    maxWords: number;                  // default 64
    mergeSimilarityThreshold: number;  // default 0.70
  };
}
```

Clamp values:

- threshold percents: `1..95`
- scope percents: `1..100`
- `maxOpsPerObservation`: `0..10`
- `maxWords`: `16..96`
- `mergeSimilarityThreshold`: `0..1`

Migration aliases:

```text
observationTriggerContextPercent -> rawMessages.observeThresholdPercent
observationScopeContextPercent or observationScopePercent -> rawMessages.oldestScopePercent
reflectionTriggerContextPercent -> observations.reobserveThresholdPercent
reflectionTargetContextPercent -> observations.oldestScopePercent, if no better legacy key exists
experienceBank.enabled -> experiences.enabled
```

Do not silently rewrite user config files. Normalize in memory and optionally append a diagnostic warning once.

---

## Canonical state model

Add schema version `2`. Implement a normalizer that accepts old and new state.

```ts
interface OmObservationItem {
  id: string;
  text: string;
  tokenCount: number;
  createdAt: string;
  source: {
    messageStartIndex: number;
    messageEndIndex: number;
    entryIds?: string[];
  };
}

interface OmReflectionItem {
  id: string;
  text: string;
  tokenCount: number;
  createdAt: string;
  generation: number;
  sourceObservationIds?: string[];
  refreshedFromReflectionIds?: string[];
  archivedToMemoryMdHash?: string;
}

interface OmExperienceItem {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  sourceObservationIds: string[];
  sourceRawMessageRange?: {
    messageStartIndex: number;
    messageEndIndex: number;
  };
  mergedFrom?: string[];
  modifiedFrom?: string;
  score?: number;
  retrievedCount?: number;
  appliedCount?: number;
  helpedCount?: number;
  hurtCount?: number;
  ignoredCount?: number;
}

interface OmStateV2 {
  schemaVersion: 2;
  rawMessageCursor: number;
  observations: OmObservationItem[];
  reflections: OmReflectionItem[];
  experiences: OmExperienceItem[];
  totalObservationTokens: number;
  totalReflectionTokens: number;
  totalExperienceTokens: number;
  generationCount: number;
  lastObservedTimestamp?: string;
  lastReflectionTimestamp?: string;
  lastReflectionRefreshTimestamp?: string;
}
```

Migration rules:

- If old `activeObservations` string exists, create one `OmObservationItem` from it.
- If old `compactedObservations` string exists, create one `OmReflectionItem` from it.
- If new `observations`/`reflections` exist, they win over legacy fields.
- If token counts are missing, recompute from item text.
- Persist only new field names after the next state write.

---

## New helper modules

Create small pure modules so tests can verify behavior without Pi runtime or real model calls.

### `extensions/observational-memory/memory-queues.ts`

Responsibilities:

- normalize/migrate state
- compute token totals
- select oldest raw-message batch
- select oldest observation batch
- apply observation result
- apply observation-to-reflection result
- apply reflection refresh result

Exports should include pure functions like:

```ts
normalizeOmState(raw: unknown): OmStateV2
computeQueueTokenTotals(state: OmStateV2): OmStateV2
selectOldestRawMessageBatch(args): RawMessageBatch | null
selectOldestObservationBatch(args): ObservationBatch | null
appendObservationResult(args): OmStateV2
appendReflectionFromObservations(args): OmStateV2
replaceReflectionsAfterArchive(args): OmStateV2
```

### `extensions/observational-memory/memory-md.ts`

Responsibilities:

- resolve `MEMORY.md` path relative to `cwd`
- create parent directory if needed
- append old reflections before replacement
- avoid duplicate archive entries by content hash

Exports:

```ts
resolveMemoryMdPath(cwd: string, configuredPath: string): string
buildMemoryMdArchiveBlock(args): { hash: string; text: string }
appendReflectionsToMemoryMd(args): Promise<{ path: string; hash: string; appended: boolean }>
```

Archive block format:

```md

<!-- OM_REFLECTION_ARCHIVE hash=<sha256> session=<sessionName> generation=<n> -->

## Observational Memory Reflection Archive — <ISO timestamp>

Session: `<sessionName>`
Generation: `<generation>`
Hash: `<sha256>`

<old reflections markdown>

<!-- /OM_REFLECTION_ARCHIVE -->
```

If the same hash is already present, return `appended: false` and allow replacement to proceed.

### `extensions/observational-memory/experience-miner.ts`

Responsibilities:

- build XSkill-style trajectory summary input from raw slice + observations
- call optional LLM critic if available
- parse add/modify/merge ops
- validate qualification rules
- apply operations to experience library
- support deterministic extraction for tests and basic operation without network

Exports:

```ts
extractToolTrajectoryEvidence(rawMessages: AgentMessage[]): ToolTrajectoryEvidence
buildExperienceCritiquePrompt(args): string
parseExperienceOps(text: string): OmExperienceOp[]
qualifiesAsExperience(text: string, evidence: ToolTrajectoryEvidence, config): boolean
applyExperienceOps(args): OmExperienceItem[]
deriveExperiencesAfterObservation(args): Promise<ExperienceDerivationResult>
```

Deterministic minimum extraction must catch:

- bash `python` command unavailable followed by successful `python3`
- failed tool call followed by same/related tool success with corrected arguments
- tests fail with stack trace/symbol followed by targeted search/read before edit
- repeated exact `SKILL.md` rereads should **not** become an experience unless the lesson is a general tool-use process, not a project path fact

---

## Phase 1 — state/config foundation

### Tasks

1. Update `types.ts` with new state/config types.
2. Update `config.ts` to normalize the canonical config and legacy aliases.
3. Add `memory-queues.ts` with state normalization and token recomputation.
4. Update `state.ts` to read old fields and write only new fields.
5. Update footer/status types to display:
   - raw cursor
   - observation tokens
   - reflection tokens
   - experience count/tokens

### Tests

Add `extensions/observational-memory/tests/memory-queues.test.ts`.

Required cases:

- migrates `activeObservations` into `observations`
- migrates `compactedObservations` into `reflections`
- migrates `totalCompactedTokens` into `totalReflectionTokens`
- new fields win over old fields
- missing token counts recompute from text
- invalid config values clamp/fallback
- legacy config aliases normalize to canonical keys

### Verification

```bash
bun test extensions/observational-memory/tests/config.test.ts extensions/observational-memory/tests/memory-queues.test.ts
```

---

## Phase 2 — raw messages -> observations

### Tasks

1. In `memory-queues.ts`, implement `selectOldestRawMessageBatch`.
2. Selection must:
   - start at `state.rawMessageCursor`
   - select oldest eligible messages only
   - target `rawMessages.oldestScopePercent * contextWindow` tokens
   - select at least one message if threshold is crossed
   - preserve recent tail according to existing preserve-recent config
   - align to tool-call/tool-result boundaries using existing boundary helpers
3. Update `index.ts` observation scheduling:
   - threshold is raw-message pressure, not observation tokens
   - observer receives only selected raw message batch
   - previous observations may be passed only as context if current observer API needs it, but they must not be re-observed or duplicated in output
   - after success, append a new `OmObservationItem`
   - advance `rawMessageCursor` to batch end
   - persist state
4. On observation failure, do not advance cursor and do not create experiences.

### Tests

Add cases to `memory-queues.test.ts` or new `raw-observation-pipeline.test.ts`:

- raw threshold below limit does nothing
- raw threshold crossing selects oldest unobserved messages
- second observation selects the next oldest messages only
- previous observations are not included in selected raw batch
- cursor advances only after successful observation
- failed observation leaves cursor unchanged
- tool-call/result pair is not split
- recent protected tail is not selected

### Verification

```bash
bun test extensions/observational-memory/tests/raw-observation-pipeline.test.ts
```

---

## Phase 3 — XSkill-style experiences after observations

### Tasks

1. Add `experience-miner.ts`.
2. Keep existing `lib/experience-bank.ts` storage if practical, but adapt it to the new `experiences` state shape or bridge between them. Do not duplicate storage systems unless necessary.
3. Trigger derivation only immediately after a successful raw observation.
4. Input must include:
   - selected raw message slice
   - newly generated observation item
   - relevant existing experiences, if any
   - tool evidence extracted from raw messages
5. Implement XSkill-style prompt:
   - trajectory review: what worked/failed, tool sequences, detours, corrections
   - experience extraction: execution tips and decision rules
   - ops: `add`, `modify`, `merge`
   - max ops from config
   - under 64 words
   - condition-action format
   - generalizable and tool-use oriented
   - output JSON only
6. Implement strict deterministic validator:
   - accept only if starts with `When`, `If`, `For`, `After`, or `Before`
   - reject over max words
   - reject project facts/file paths/session names/user facts/dates/secrets
   - reject pure recaps like “The agent ran tests”
   - reject abstract principles like “Debug carefully”
   - require an action verb and tool/process term
   - require grounding in observed raw evidence or observations
7. Implement operation application:
   - `add`: assign next `E#`
   - `modify`: update target ID if present; if missing, drop or convert to add only if non-duplicate
   - `merge`: combine IDs, preserve lowest ID, remove merged sources
   - dedupe normalized text
8. Similarity can be deterministic initially:
   - normalized token overlap/Jaccard for tests
   - threshold default `0.70`
   - keep embedding integration optional/future

### Required fixtures

Create `extensions/observational-memory/tests/fixtures/` with small JSON/JSONL fixtures:

```text
python-fallback-session.jsonl
stacktrace-search-session.jsonl
project-fact-rejection-session.jsonl
reflection-separation-session.jsonl
```

Fixture expectations:

- `python-fallback-session.jsonl`: bash `python` fails as unavailable, later `python3` succeeds.
  - Expected experience:
    `When a bash command fails because python is unavailable, retry with python3 before changing the script logic.`
- `stacktrace-search-session.jsonl`: test failure names stack frame/symbol, agent searches/reads targeted code.
  - Expected experience under 64 words about using stack trace clues before editing.
- `project-fact-rejection-session.jsonl`: user states a project path or file location.
  - Expected no experience.

### Tests

Add `extensions/observational-memory/tests/experience-miner.test.ts`.

Required cases:

- derives experiences only after observations exist
- passes raw slice and new observations to derivation
- accepts `python` -> `python3` command correction
- accepts stack-trace -> targeted search/read workflow
- rejects project-specific path facts
- rejects user facts as experiences
- rejects over-64-word experience
- rejects non-condition-action text
- applies add operation with new ID
- applies modify operation to existing ID
- applies merge operation and removes source IDs
- deduplicates normalized experience text
- reflection/reobserve paths do not call the miner

### Verification

```bash
bun test extensions/observational-memory/tests/experience-miner.test.ts extensions/observational-memory/tests/experience-bank.test.ts
```

---

## Phase 4 — observations -> reflections

### Tasks

1. Implement `selectOldestObservationBatch`.
2. Trigger when:

```ts
totalObservationTokens >= observations.reobserveThresholdPercent / 100 * contextWindow
```

3. Select oldest observations up to:

```ts
observations.oldestScopePercent / 100 * contextWindow
```

4. Reobserve only selected observation item text.
5. Do not include existing reflections in the reobserver input.
6. On success:
   - append new `OmReflectionItem` to `reflections`
   - remove selected observation items from `observations`
   - recompute token totals
   - increment generation count
   - persist state
7. On failure, leave observations/reflections unchanged.
8. Do not create experiences.

### Tests

Add `extensions/observational-memory/tests/observation-reflection-pipeline.test.ts`.

Required cases:

- observation threshold below limit does nothing
- threshold crossing selects oldest observations
- second cycle selects next oldest observations only
- reobserver input excludes existing reflections
- new reflection appends to existing reflections
- selected observations are removed after success
- failed reobserve leaves state unchanged
- experience miner is not called

### Verification

```bash
bun test extensions/observational-memory/tests/observation-reflection-pipeline.test.ts
```

---

## Phase 5 — reflections -> refreshed reflections with MEMORY.md archival

### Tasks

1. Add `memory-md.ts`.
2. Trigger when:

```ts
totalReflectionTokens >= reflections.reobserveThresholdPercent / 100 * contextWindow
```

3. Reobserve all current reflections.
4. Before replacing reflections:
   - append current reflections to `MEMORY.md`
   - default path is `<cwd>/MEMORY.md`
   - create file and parent dirs if needed
   - include hash marker for idempotency
5. If archival fails, abort replacement and append diagnostic.
6. If archival succeeds or duplicate hash already exists:
   - replace all old reflections with one or more refreshed `OmReflectionItem`s
   - preserve observations unchanged
   - recompute token totals
   - persist state
7. Do not create experiences.

### Tests

Add `extensions/observational-memory/tests/reflection-refresh-pipeline.test.ts` and `memory-md.test.ts`.

Required cases:

- below reflection threshold does nothing
- threshold crossing sends all reflections to reobserver
- observations unchanged after refresh
- old reflections replaced by refreshed reflection
- `MEMORY.md` created if missing
- archive block contains hash/session/generation/timestamp
- duplicate hash is not appended twice
- failed archive write prevents reflection replacement
- experience miner is not called

### Verification

```bash
bun test extensions/observational-memory/tests/memory-md.test.ts extensions/observational-memory/tests/reflection-refresh-pipeline.test.ts
```

---

## Phase 6 — prompt injection and commands

### Tasks

1. Update prompt composition in `index.ts` or relevant helper.
2. Required section order:

```text
## Reflections
## Actionable Tool-Use Experiences
## Active Observations
```

3. Omit empty sections.
4. Keep trust rule:

```text
Trust current messages over these memories if they conflict.
```

5. Update command/status text:
   - `/om show` or equivalent should display observations/reflections/experiences separately.
   - `/om compact` may remain as an alias, but user-facing primary term should be `/om reflect` if a command exists.
6. Update footer labels:
   - `obs=<tokens>`
   - `refl=<tokens>`
   - `exp=<count>`
7. Remove user-facing “compacted observations” wording except deprecation notes.

### Tests

Add `extensions/observational-memory/tests/prompt-order.test.ts`.

Required cases:

- sections appear in exact order: reflections -> experiences -> observations
- empty experience section is omitted
- empty observation section is omitted
- no “Compacted Observations” heading appears
- experience bullets include IDs
- suffix stripping still prevents duplicate OM suffixes across turns

### Verification

```bash
bun test extensions/observational-memory/tests/prompt-order.test.ts
```

---

## Phase 7 — example session integration tests

### Tasks

1. Add small example session fixtures under:

```text
extensions/observational-memory/tests/fixtures/sessions/
```

2. Fixtures must be hand-sized, not copied from giant live sessions.
3. Include message entries with:
   - session header
   - user messages
   - assistant tool calls
   - toolResult messages
   - custom OM state entries where needed
4. Add parser/helper if needed to load message entries from JSONL.

### Tests

Add `extensions/observational-memory/tests/session-pipeline.test.ts`.

Required cases:

- raw context-window threshold changes cause observation at expected point
- raw observation uses oldest raw messages and advances cursor
- next observation skips already observed raw messages
- observation threshold causes oldest observations to become reflections
- reflection threshold causes archive + replacement
- experiences are generated after observation and injected between reflections and observations
- custom state entries are not treated as raw messages
- thinking blocks are omitted from observer-formatted text
- tool-call/result boundaries remain intact

### Verification

```bash
bun test extensions/observational-memory/tests/session-pipeline.test.ts
```

---

## Phase 8 — cleanup, grep acceptance, full verification

### Cleanup tasks

1. Search production code for legacy naming:

```bash
rg "compactedObservations|totalCompactedTokens|Compacted Observations" extensions/observational-memory
```

Allowed only in:

- migration normalizer
- tests
- explicit deprecation comments

2. Search for experience derivation call sites:

```bash
rg "deriveExperience|experience-miner|deriveExperiencesAfterObservation" extensions/observational-memory
```

Verify calls occur only after raw observation success.

3. Search reflection/reobserver inputs:

```bash
rg "existingCompacted|existingReflections|compacted" extensions/observational-memory
```

Verify observation->reflection does not pass existing reflections.

4. Ensure no automated path writes `MEMORY.md` except reflection refresh archival.

### Full verification commands

Run targeted OM tests:

```bash
bun test extensions/observational-memory/tests
```

Run all available workspace tests if practical:

```bash
bun test
```

If `bun test` is too broad or unavailable, run every OM test file explicitly:

```bash
bun test \
  extensions/observational-memory/tests/config.test.ts \
  extensions/observational-memory/tests/chunking.test.ts \
  extensions/observational-memory/tests/reflection-guard.test.ts \
  extensions/observational-memory/tests/reflection-parser.test.ts \
  extensions/observational-memory/tests/experience-bank.test.ts \
  extensions/observational-memory/tests/memory-queues.test.ts \
  extensions/observational-memory/tests/raw-observation-pipeline.test.ts \
  extensions/observational-memory/tests/experience-miner.test.ts \
  extensions/observational-memory/tests/observation-reflection-pipeline.test.ts \
  extensions/observational-memory/tests/memory-md.test.ts \
  extensions/observational-memory/tests/reflection-refresh-pipeline.test.ts \
  extensions/observational-memory/tests/prompt-order.test.ts \
  extensions/observational-memory/tests/session-pipeline.test.ts
```

Manual smoke command, only if Pi is locally runnable:

```bash
pi -e extensions/observational-memory/index.ts
```

Do not require real provider calls in automated tests. Use mocked observer/reobserver/experience critic functions.

---

## Completion checklist

Implementation is complete only when all are true:

- [ ] State uses `observations` and `reflections` in production code.
- [ ] Legacy fields migrate correctly.
- [ ] Raw threshold observes oldest unobserved raw messages only.
- [ ] Repeated raw observation cycles skip already observed raw messages.
- [ ] Experience derivation runs only after successful raw observation.
- [ ] Experience derivation receives both raw slice and new observations.
- [ ] Experience qualification follows XSkill condition-action/action-level/generalizable rules.
- [ ] Observation threshold reflects oldest observations only.
- [ ] Observation->reflection appends to existing reflections and removes reflected observations.
- [ ] Reflection threshold archives old reflections to `MEMORY.md` before replacement.
- [ ] Failed `MEMORY.md` archive prevents replacement.
- [ ] Prompt injection order is reflections -> experiences -> observations.
- [ ] Automated tests cover all queue transitions and example session behavior.
- [ ] Grep acceptance has no unexpected legacy naming.
- [ ] `bun test extensions/observational-memory/tests` passes.

---

## Implementation notes for the autonomous agent

- Prefer small pure functions and tests over large rewrites in `index.ts`.
- Keep model/provider calls behind injectable function parameters for tests.
- Preserve existing Pi lifecycle hooks: `session_start`, `context`, `before_agent_start`, `agent_end`, `turn_end`, `session_before_compact`, `session_shutdown`.
- Preserve append-only custom state entries; do not rewrite session JSONL files in place.
- Use temp dirs for tests that write `MEMORY.md` or experience files.
- Keep fixtures small and deterministic.
- If a test reveals ambiguous behavior, choose the behavior that preserves the invariants at the top of this file.
