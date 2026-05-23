# Observational Memory vNext Tasks

Status: proposed
Owner: `extensions/observational-memory`
Scope: hot/raw session split, seamless rollover, legacy recovery, configurable thresholds, internal experience bank, replay/debug upgrades.

---

## Phase 0 — Documentation baseline

- [ ] Review and align implementation against `PLAN.md`
- [ ] Keep all new naming under `.pi/om/`
- [ ] Preserve command naming as `/session-switch <token>`
- [ ] Preserve current session name across all hot-session rebuilds

Acceptance:
- `PLAN.md` and `TASKS.md` remain the source-of-truth planning docs for OM vNext.

---

## Phase 1 — Configurable threshold foundation

### Goal
Make rollover and oversized-entry behavior configurable instead of hard-coded.

### Files
- `extensions/observational-memory/types.ts`
- `extensions/observational-memory/config.ts`
- new: project-local config support for `.pi/observational-memory.json`

### Tasks
- [ ] Add typed config fields for:
  - [ ] `sessionRollover.warnBytes`
  - [ ] `sessionRollover.targetBytes`
  - [ ] `sessionRollover.hardBytes`
  - [ ] `sessionRollover.legacyRecoveryCandidateBytes`
  - [ ] `sessionRollover.minProjectedSavingsBytes`
  - [ ] `oversizedEntries.entryBytes`
  - [ ] `oversizedEntries.stubPreviewChars`
  - [ ] `oversizedEntries.trimWorkflowToolResults`
  - [ ] `archive.targetChunkBytes`
  - [ ] `archive.maxChunkBytes`
- [ ] Merge config precedence as:
  - [ ] defaults
  - [ ] `~/.pi/agent/extensions/observational-memory/config.json`
  - [ ] `<project>/.pi/observational-memory.json`
- [ ] Validate thresholds for sane minimums/maximums
- [ ] Add status/debug output to print current effective thresholds
- [ ] Ensure threshold loading does not break current OM startup flow

Acceptance:
- OM can report effective threshold config.
- Thresholds are configurable without code edits.

---

## Phase 2 — OM project storage layout

### Goal
Create the project-local storage model under `.pi/om/`.

### Files
- new: OM storage helpers under `extensions/observational-memory/lib/`

### Tasks
- [ ] Create storage path helpers for:
  - [ ] `.pi/om/raw/`
  - [ ] `.pi/om/pending/`
  - [ ] `.pi/om/experiences/`
  - [ ] `.pi/om/recovery/reports/`
- [ ] Add helpers for archive chunk path generation
- [ ] Add helpers for pending switch token files
- [ ] Add helpers for experience-bank index/item paths
- [ ] Ensure all directories are created lazily and safely
- [ ] Keep storage path logic separate from runtime/session logic

Acceptance:
- OM can resolve and create all `.pi/om/` directories deterministically.

---

## Phase 3 — Provenance and coverage model

### Goal
Track what OM has covered using entry IDs only.

### Files
- `extensions/observational-memory/types.ts`
- `extensions/observational-memory/index.ts`
- new: provenance helpers under `lib/`

### Tasks
- [ ] Define coverage metadata shape using:
  - [ ] `entryIdStart`
  - [ ] `entryIdEnd`
  - [ ] `coveredEntryIds`
  - [ ] `sourceSessionPath`
  - [ ] `sourceSessionName`
  - [ ] `archiveChunkPath`
- [ ] Extend OM observation/reflection state to remember exact covered entry IDs when available
- [ ] Add safe-boundary helper to advance from raw OM cursor to:
  - [ ] tool-pair-safe boundary
  - [ ] turn-safe boundary
- [ ] Record provenance whenever OM observation is persisted
- [ ] Expose provenance in `/om status` or debug-only output

Acceptance:
- OM can describe exactly which entries a future rollover would archive.

---

## Phase 4 — Raw archive writer

### Goal
Archive covered raw history out of the hot session into chunked OM raw files.

### Files
- new: `extensions/observational-memory/lib/raw-archive.ts`
- `extensions/observational-memory/index.ts`

### Tasks
- [ ] Implement chunk writer for `.pi/om/raw/<session-name-or-id>/chunk-*.jsonl`
- [ ] Support chunk splitting based on configurable chunk byte thresholds
- [ ] Write full-fidelity original entries into raw chunks
- [ ] Write archive manifest metadata for each chunk
- [ ] Record archive manifests via OM append entries or sidecar manifest files
- [ ] Ensure archival happens only after safe post-turn boundaries
- [ ] Add failure handling so partial archive writes do not trigger switch

Acceptance:
- Covered history can be archived without touching the current live Pi session file in place.

---

## Phase 5 — Hot session builder

### Goal
Build a fresh compact hot session from the retained tail + OM metadata.

### Files
- new: `extensions/observational-memory/lib/hot-session.ts`
- `extensions/observational-memory/index.ts`

### Tasks
- [ ] Implement hot-session builder that writes a new JSONL session file
- [ ] Preserve:
  - [ ] session name
  - [ ] latest model metadata
  - [ ] latest thinking metadata
  - [ ] latest OM state
  - [ ] parent/source lineage metadata
- [ ] Keep only the retained tail after safe boundary selection
- [ ] Stub oversized tool-result payloads when configurable conditions match
- [ ] Add archive references for stubbed payloads
- [ ] Reset/rebase OM cursor relative to the newly built hot session
- [ ] Validate resulting parent chain / JSONL structure

Acceptance:
- OM can produce a new resumable hot session file that preserves the same human-facing session name.

---

## Phase 6 — Seamless switch via `/session-switch <token>`

### Goal
Perform safe automatic rollover switching without manual user session picking.

### Files
- `extensions/observational-memory/index.ts`
- new: `extensions/observational-memory/lib/pending-switch.ts`

### Tasks
- [ ] Register command:
  - [ ] `/session-switch <token>`
- [ ] Implement pending token file storage under `.pi/om/pending/<token>.json`
- [ ] Store in token file:
  - [ ] target hot session path
  - [ ] previous session path
  - [ ] expected session name
  - [ ] rollout reason
  - [ ] timestamp/version
- [ ] At safe post-turn boundary, queue:
  - [ ] `pi.sendUserMessage("/session-switch <token>", { deliverAs: "followUp" })`
- [ ] In command handler:
  - [ ] `await ctx.waitForIdle()`
  - [ ] validate token and target session
  - [ ] call `await ctx.switchSession(targetHotSessionPath)`
- [ ] Clear token/indicator on success
- [ ] Leave current session untouched on failure and surface debug notice

Acceptance:
- OM can auto-switch to a new hot session seamlessly after a completed turn.

---

## Phase 7 — Rollover decision engine

### Goal
Decide *when* to roll over based on configurable thresholds and projected savings.

### Files
- `extensions/observational-memory/index.ts`
- new: `extensions/observational-memory/lib/rollover-policy.ts`

### Tasks
- [ ] Add hot-session size measurement helpers
- [ ] Add projected-savings estimation from:
  - [ ] OM-covered range
  - [ ] oversized entries that can be stubbed
- [ ] Trigger warning state at `warnBytes`
- [ ] Stage rollover at `targetBytes` when archiveable savings are sufficient
- [ ] Force rollover at `hardBytes` at next safe post-turn boundary
- [ ] Mark sessions above `legacyRecoveryCandidateBytes` as recovery candidates
- [ ] Avoid noisy rollover when projected savings are below `minProjectedSavingsBytes`

Acceptance:
- Rollover happens well before the session reaches a dangerous, unresumable size.

---

## Phase 8 — Legacy recovery tooling

### Goal
Recover already-bloated sessions such as `ghostclaw-main`.

### Files
- new: `extensions/observational-memory/scripts/recover_large_session.py`
- new: `extensions/observational-memory/scripts/session_report.py`
- new: `extensions/observational-memory/scripts/validate_hot_session.py`

### Tasks
- [ ] Implement `session_report.py`
  - [ ] stream-parse JSONL
  - [ ] report size by entry type/customType
  - [ ] report largest entries
  - [ ] report latest OM cursor
  - [ ] report likely recovery strategy
- [ ] Implement `recover_large_session.py`
  - [ ] stream-parse giant session without full-file string load
  - [ ] extract latest name/model/thinking/OM metadata
  - [ ] determine safe rebuild boundary
  - [ ] archive removed history to `.pi/om/raw/...`
  - [ ] stub oversized workflow/tool-result payloads
  - [ ] emit recovered hot session with same session name
  - [ ] move/archive original giant file out of active Pi session scanning
  - [ ] emit recovery report to `.pi/om/recovery/reports/`
- [ ] Implement `validate_hot_session.py`
  - [ ] JSONL sanity checks
  - [ ] session header presence
  - [ ] parent-chain sanity
  - [ ] size threshold sanity
  - [ ] optional dry-run resume validation

Acceptance:
- `ghostclaw-main`-style sessions can be recovered offline into a resumable hot session.

---

## Phase 9 — Internal experience bank (v1)

### Goal
Add XSkill-style private experience memory with ranking and retrieval.

### Files
- new: `extensions/observational-memory/lib/experience-bank.ts`
- new: `.pi/om/experiences/index.json` and `items/*.json`
- `extensions/observational-memory/index.ts`

### Tasks
- [ ] Define experience record schema with:
  - [ ] `id`
  - [ ] `kind`
  - [ ] `text`
  - [ ] `toolNames`
  - [ ] `triggerPatterns`
  - [ ] `status`
  - [ ] `score`
  - [ ] `rank`
  - [ ] `retrievedCount`
  - [ ] `appliedCount`
  - [ ] `helpedCount`
  - [ ] `hurtCount`
  - [ ] `ignoredCount`
  - [ ] provenance entry IDs
- [ ] Add candidate extraction boundary after OM observation/reflection
- [ ] Add retrieval path for `before_agent_start` / context injection
- [ ] Add ranking updates from later usage outcomes
- [ ] Keep v1 internal only; do not auto-generate `SKILL.md`

Acceptance:
- OM can store, rank, and retrieve experiences privately without polluting Pi skill discovery.

---

## Phase 10 — Replay/debug UI upgrade

### Goal
Make OM/archive/experience activity visible and debuggable.

### Files
- `extensions/session-replay.ts`
- optionally new OM render helpers under `extensions/observational-memory/lib/`

### Tasks
- [ ] Extend session replay item taxonomy to include:
  - [ ] OM state
  - [ ] OM diagnostics
  - [ ] archive chunk boundaries
  - [ ] rollover events
  - [ ] pending switch events
  - [ ] experience candidate/update events
- [ ] Add color legend mapped by event type
- [ ] Add filtering/toggling for noisy categories
- [ ] Show archive references / hot session lineage where available
- [ ] Keep replay UI read-only; no direct runtime mutation from overlay

Acceptance:
- The replay overlay can clearly explain what OM archived, what remained hot, and what experiences were generated.

---

## Phase 11 — Footer/status integration

### Goal
Expose rollover state clearly in the TUI.

### Files
- `extensions/observational-memory/footer.ts`
- `extensions/observational-memory/index.ts`

### Tasks
- [ ] Add transient status states such as:
  - [ ] `OM observing`
  - [ ] `OM archiving`
  - [ ] `OM rebuilding hot session`
  - [ ] `OM switching session`
  - [ ] `OM recovering`
- [ ] Ensure context/token bars refresh immediately after successful session switch
- [ ] Clear indicators on failure or completion

Acceptance:
- Users can tell when OM is archiving, rebuilding, or switching sessions.

---

## Phase 12 — Test matrix

### Goal
Lock behavior down before broad use.

### Black-box scenarios
- [ ] normal turn-end rollover
- [ ] rollover after observation completion
- [ ] rollover after overflow-recovery observation
- [ ] repeated rollovers in long sessions
- [ ] preserve session name across rollover
- [ ] archive chunk manifests are correct
- [ ] no duplicate entries in rebuilt hot session
- [ ] no lost tail entries in rebuilt hot session
- [ ] oversized tool-result payloads are stubbed in hot session and archived fully in raw storage
- [ ] `/session-switch <token>` succeeds on valid token
- [ ] `/session-switch <token>` fails safely on invalid token
- [ ] recovery script rebuilds legacy giant session like `ghostclaw-main`
- [ ] recovered session opens successfully
- [ ] original huge source is archived out of active session scanning
- [ ] threshold warnings / target / hard rollover behavior respect config overrides

Acceptance:
- OM vNext behavior is covered by regression tests and recovery checks.

---

## Recommended implementation order

1. Phase 1 — Configurable thresholds
2. Phase 2 — `.pi/om/` storage scaffolding
3. Phase 3 — Provenance coverage model
4. Phase 4 — Raw archive writer
5. Phase 5 — Hot session builder
6. Phase 6 — `/session-switch <token>` seamless switching
7. Phase 7 — Rollover policy engine
8. Phase 8 — Legacy recovery scripts
9. Phase 11 — Footer/status integration
10. Phase 10 — Replay/debug UI upgrade
11. Phase 9 — Internal experience bank
12. Phase 12 — Full black-box/regression test matrix

---

## Done definition

This plan is complete when:

- [ ] hot sessions no longer drift into unresumable size ranges,
- [ ] existing giant sessions can be recovered,
- [ ] same session name persists across rollover,
- [ ] thresholds are configurable,
- [ ] seamless switch works via `/session-switch <token>`,
- [ ] OM has a private experience bank in v1,
- [ ] replay/debug UI explains OM actions clearly.
