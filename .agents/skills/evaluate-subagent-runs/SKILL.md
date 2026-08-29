---
name: evaluate-subagent-runs
description: "Use for read-only evaluation of explicit Pi session JSONL files containing csheng_subagents results: routing, launch, usage, cost, timing, concurrency, convergence, admission failures, and correction evidence."
---

# Evaluate Subagent Runs

Evaluate one explicitly named Pi session without changing Pi state, runtime routes, the workspace, or external files.

## Boundary

- Accept one exact session JSONL path or session ID.
- Read only Pi JSONL. Never read Pi SQLite, settings, credentials, logs, or unrelated sessions.
- Emit only the versioned metric shape in `references/metric-schema.md`.
- Never copy prompts, objectives, child output, stderr, environment values, route-file content, or external file content.
- Treat schema-one runtime telemetry as authoritative. Label legacy launch and timing derivation as inference.
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

1. Confirm `source.telemetryMode` before treating launch, queue, or peak-concurrency metrics as authoritative.
2. Compare roles and routes using task count, actual launches, usage, duration, changed-path count, and outcome.
3. Use `mechanicalDispatchCorrectionCandidates` as a dispatch-quality signal, not as semantic repair count.
4. Diagnose errors by stable code and run ordinal. Return to raw session content only through a separately authorized investigation; never paste it into the report.
5. Make route or cap changes only through a separately approved design and user configuration change backed by multiple representative runs.

## Verify

```bash
node --experimental-strip-types --test tests/subagents-evaluator.test.ts
npm run typecheck
```
