---
name: evaluate-subagent-runs
description: "Use for read-only evaluation of explicit Pi session JSONL files containing historical one-shot csheng_subagents results, managed csheng_subagent_sessions results, and native observations: routing, launch, replay, owned usage, command/timing evidence, apply, and explicit parent disposition."
---

# Evaluate Subagent Runs

Evaluate one explicitly named Pi session without changing Pi state, runtime routes, the workspace, or external files.

## Boundary

- Accept one exact session JSONL path or session ID, or an explicit current-epoch scan that names both a sessions root and the provenance manifest.
- Read only the selected Pi JSONL and, when explicitly supplied, one bounded parent-disposition JSON. Never read Pi SQLite, settings, credentials, logs, or unrelated sessions.
- Emit only metric schema version four as defined in `references/metric-schema.md`.
- Never copy prompts, objectives, raw model selectors, task IDs, child output, stderr, environment values, route-file content, or external file content.
- Treat runtime telemetry schema two through four as authoritative for the fields they declare. Treat schema one as authoritative only for its available launch, admission, duration, and concurrency fields. Label legacy launch, width, and timing derivation as inference.
- Never reconstruct topology, explicit model or thinking requests, or other new metrics from assistant tool arguments, prompts, or legacy prose. Report unavailable evidence as `null` per run and through `unavailableRuns` totals.
- Report legacy mechanical dispatch-correction candidates separately. Semantic repair, takeover, and acceptance stay unavailable unless an explicit scoped parent disposition supplies them; report or apply status never implies acceptance.
- Existing totals/roles/routes/runs remain historical `csheng_subagents-only` one-shot counters. They do not describe the registered managed tool. Use `managedDispatch` for v2 invocation counts/selection independent of settled windows, with owner/invocation deduplication and explicit legacy/invalid/unassigned coverage. Use `observations` for native/managed evidence, with owner/entry and episode deduplication. Never add its usage to a referenced legacy aggregate or charge replay as new model work.
- Do not invoke subagents, change routing, retry provider calls, or mutate a report unless an explicit new output path is provided.

## Run

From the `pi-extensions` repository:

```bash
node --experimental-strip-types \
  .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts \
  --session <path-or-id>
```

For current installed/configured health, require explicit inputs:

```bash
node --experimental-strip-types \
  .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts \
  --epoch current --sessions-root <dir> --manifest <file>
```

For a parent-owned acceptance declaration, exact-session mode optionally accepts `--disposition <json-file>`. Follow the strict shape, owner/entry-range association, explicit-null handling, and 4 KiB bound in `references/metric-schema.md`. This is evaluation input, not a runtime approval or a whole-report acceptance claim.

Current-epoch `managedDispatch` selects only v2 invocations with their own matching revision pair; missing pairs remain unassigned, and legacy records retain unavailable ownership/launch evidence. Returned old episode provenance is not current-invocation provenance. Native observations still require exact-session input.

Use `--sessions-root <dir>` only for a bounded fixture or explicitly selected alternate session root. Use `--output <new-file>` to create a report; the extractor refuses to overwrite an existing path.

## Interpret

1. Confirm `source.telemetryMode`, each run's `telemetrySchemaVersion`, and nullable evidence fields before treating metrics as authoritative.
2. Compare roles and routes using task count, actual launches, usage, duration, changed-path count, outcome, configuration `source`, and route `selectionSource`.
3. Use requested, admitted, and launched totals distinctly. A singleton is a run with known `requestedTasks === 1`; an empty legacy rejection has unknown width.
4. Use `mechanicalDispatchCorrectionCandidates` as a dispatch-quality signal, not as semantic repair count.
5. Diagnose errors by stable code and run ordinal. Return to raw session content only through a separately authorized investigation; never paste it into the report.
6. For v4, distinguish tool wall time, scheduler span, worker effort, occupied interval wall, and overlapping wait reasons; incomplete evidence stays unavailable. Do not infer provider utilization or child reasoning from process intervals.
7. Read native `observations.available` and nullable subfields independently. Missing timing does not erase valid owned recorded usage; that usage does not prove a complete provider bill for an interrupted in-flight request. Read `managedDispatch` separately from native windows and one-shot totals. Parent/child cost is cumulative referenced owned evidence; child phase summaries are per-episode effort, not unrelated-clock union. Command coverage and endpoint changes are evidence, not proof of tests or acceptance. Configured tools/context windows are host-state observations, not final provider payload or quotas.
8. Make route or cap changes only through a separately approved design and user configuration change backed by multiple representative runs.

## Verify

```bash
node --experimental-strip-types --test tests/subagents-evaluator.test.ts tests/subagents-observation-metrics.test.ts
npm run typecheck
```
