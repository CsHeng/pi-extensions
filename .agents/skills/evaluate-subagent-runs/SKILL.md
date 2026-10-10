---
name: evaluate-subagent-runs
description: "Use for read-only evaluation of explicit Pi session JSONL files containing current-version managed csheng_subagent_sessions results and native observations: routing, launch, replay, owned usage, command/timing evidence, apply, and explicit parent disposition. Retired one-shot csheng_subagents and non-current managed envelopes are excluded, not interpreted."
---

# Evaluate Subagent Runs

Evaluate one explicitly named Pi session (or one explicit current-epoch scan) without changing Pi state, runtime routes, the workspace, or external files.

## Boundary

- Accept one exact session JSONL path or session ID, or an explicit current-epoch scan that names both a sessions root and the provenance manifest.
- Read only the selected Pi JSONL and, when explicitly supplied, one bounded parent-disposition JSON. Never read Pi SQLite, settings, credentials, logs, or unrelated sessions.
- Emit only metric artifact schema version five as defined in `references/metric-schema.md`. That artifact version is independent of the collaboration/managed envelope version (currently four) and of the session-view version (currently four).
- Interpret a managed `csheng_subagent_sessions` envelope only when `schemaVersion` is four. The retired one-shot `csheng_subagents` tool name and any non-four managed envelope are classified shallowly and excluded before any nested field is read; they are reported as exclusions (`source.excludedRuns`, `observations.excludedRecords`, `managedDispatch.excludedRecords`), never as invalid current work. Do not add legacy inference or a compatibility adapter.
- Never copy prompts, objectives, raw model selectors, task IDs, child output, stderr, environment values, route-file content, or external file content. The bounded per-root `destination` projection described in the schema is the only path-like field retained.
- Report exclusions, invalid current records, and unavailable provenance as separate categories. Do not merge excluded or unavailable evidence into a known total.
- Report logical counts once: `outcomes.candidatesApplied` counts a candidate only when it is actually `applied`; owned usage is deduplicated by owner/entry/episode; `managedDispatch` deduplicates owner/invocation. Do not multiply a count because a bundle has several repository roots.
- Report per-root disposition (`rootStatuses`) and the aggregate release (`releases`) separately. A scratch-only partial cleanup is an aggregate release fact, never a per-root failure.
- Never invoke subagents, change routing, retry provider calls, or mutate a report unless an explicit new output path is provided.

## Run

From the `pi-extensions` repository:

```bash
bun \
  .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts \
  --session <path-or-id>
```

For one explicit current-epoch scan:

```bash
bun \
  .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts \
  --epoch current --sessions-root <dir> --manifest <file>
```

Options:

- `--session <path-or-id>`: exact-session input. A path (or anything containing a separator or ending in `.jsonl`) is resolved directly; a bare id is resolved under `--sessions-root` (default `~/.pi/agent/sessions`) and must match exactly one JSONL file.
- `--sessions-root <dir>`: alternate sessions root for `--session` resolution, or the required root for `--epoch current`. Use a bounded fixture or explicitly selected root, not the whole corpus.
- `--epoch current`: managed current-epoch mode; requires `--sessions-root` and `--manifest`. Selects matching managed invocations by their explicit epoch pair and activation cutoff. Native `observations` stay unavailable in this mode; select an exact session to inspect them.
- `--manifest <file>`: version-one epoch manifest `{version:1, extensionEpoch, configurationEpoch, extensionActivatedAtMs, configurationActivatedAtMs}`.
- `--disposition <json-file>`: exact-session only. One bounded parent-acceptance declaration; see the schema for the strict shape, owner/entry-range association, explicit-null handling, and 4 KiB limit.
- `--output <new-file>`: create a report. The extractor refuses to overwrite an existing path.
- `--help`: print usage.

## Interpret

1. Confirm `schemaVersion` is five, then read `source` for selection mode and excluded/unavailable coverage before treating metrics as authoritative.
2. Use `managedDispatch` for managed transport/invocation evidence: `selectedRequests`/`excludedRequests`/`unassignedRequests`, `actions`, `errors`, and the `{ known, unavailableRequests }` launch/replay counts. Use `observations` for native/managed owned evidence. There is no legacy one-shot aggregate.
3. Read `observations.available` and its nullable subfields independently. Missing timing does not erase valid owned recorded usage; that usage does not prove a complete provider bill for an interrupted in-flight request.
4. Read `observations.rootStatuses` per root (`destination`, `status`, `recovery`, `release`, nullable `candidateId`) and `observations.releases` per session. A `partial` aggregate release with only `scratch` remaining keeps every root `released`; do not inflate that into per-root failures.
5. Use `observations.outcomes.candidatesApplied` as a logical count (one per actually-applied candidate). Parent acceptance is only `observations.outcomes.parentAccepted` from an explicit `--disposition`; report or apply status never implies acceptance.
6. For managed async evidence, `managedDispatch.async` separates accepted receipts from owned terminal events. Only terminal episode facts count child launches and phase timing; conflicting facts fence the metrics even when a later event enriches timing. Missing or cross-clock timing stays unavailable.
7. Diagnose errors by stable code and bounded action groups. Return to raw session content only through a separately authorized investigation; never paste it into the report.
8. Make route or cap changes only through a separately approved design and user configuration change backed by multiple representative runs.

## Verify

```bash
bun test tests/subagents-evaluator.test.ts tests/subagents-observation-metrics.test.ts tests/subagents-async-evaluator.test.ts
bun run typecheck
```
