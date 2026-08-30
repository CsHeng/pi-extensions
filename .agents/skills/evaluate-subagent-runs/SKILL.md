---
name: evaluate-subagent-runs
description: "Use for read-only evaluation of explicit Pi session JSONL files containing csheng_subagents results: routing, launch, usage, cost, timing, concurrency, convergence, admission failures, and correction evidence."
---

# Evaluate Subagent Runs

Evaluate one explicitly named Pi session without changing Pi state, runtime routes, the workspace, or external files.

## Boundary

- Accept one exact session JSONL path or session ID.
- Read only Pi JSONL. Never read Pi SQLite, settings, credentials, logs, or unrelated sessions.
- Emit only metric schema version two as defined in `references/metric-schema.md`.
- Never copy prompts, objectives, raw model selectors, task IDs, child output, stderr, environment values, route-file content, or external file content.
- Treat runtime telemetry schema two as authoritative for all declared fields. Treat schema one as authoritative only for its available launch, admission, duration, and concurrency fields. Label legacy launch, width, and timing derivation as inference.
- Never reconstruct topology, explicit model or thinking requests, or other new metrics from assistant tool arguments, prompts, or legacy prose. Report unavailable evidence as `null` per run and through `unavailableRuns` totals.
- Report mechanical dispatch-correction candidates separately. Semantic repair remains unavailable unless parent-owned structured evidence is added in a future approved contract.
- Do not invoke subagents, change routing, retry provider calls, or mutate a report unless an explicit new output path is provided.

## Run

From the `pi-extensions` repository:

```bash
node --experimental-strip-types \
  .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts \
  --session <path-or-id>
```

Use `--sessions-root <dir>` only for a bounded fixture or explicitly selected alternate session root. Use `--output <new-file>` to create a report; the extractor refuses to overwrite an existing path.

## Interpret

1. Confirm `source.telemetryMode`, each run's `telemetrySchemaVersion`, and nullable evidence fields before treating metrics as authoritative.
2. Compare roles and routes using task count, actual launches, usage, duration, changed-path count, outcome, configuration `source`, and route `selectionSource`.
3. Use requested, admitted, and launched totals distinctly. A singleton is a run with known `requestedTasks === 1`; an empty legacy rejection has unknown width.
4. Use `mechanicalDispatchCorrectionCandidates` as a dispatch-quality signal, not as semantic repair count.
5. Diagnose errors by stable code and run ordinal. Return to raw session content only through a separately authorized investigation; never paste it into the report.
6. Make route or cap changes only through a separately approved design and user configuration change backed by multiple representative runs.

## Verify

```bash
node --experimental-strip-types --test tests/subagents-evaluator.test.ts
npm run typecheck
```
