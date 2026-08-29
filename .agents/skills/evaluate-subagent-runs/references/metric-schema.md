# Subagent Session Metric Schema

`schemaVersion = 1` is a redacted evaluation document, not runtime state and not a workflow ledger.

## Top level

- `source.sessionId`: identifier derived from the selected JSONL filename.
- `source.telemetryMode`: `authoritative`, `legacy`, or `mixed`.
- `totals`: run/task/launch counts, usage, duration sum, changed-path count, and correction evidence.
- `roles`: explorer, reviewer, and worker aggregates.
- `routes`: aggregates keyed by provider, model, thinking, and route source.
- `errors`: stable error-code counts.
- `concurrency`: largest requested width and authoritative observed peak when available.
- `runs`: bounded per-call metrics by ordinal; no task objective, output, or path is retained.

## Evidence labels

Schema-one tool details supply authoritative requested/admitted/launched counts, run duration, and peak concurrency. For legacy details:

- a task is inferred to have launched only when `usage.turns > 0`;
- run duration is inferred as the maximum task duration;
- requested width is inferred from persisted task count and is unknown for empty admission failures;
- observed peak concurrency remains `null`.

`mechanicalDispatchCorrectionCandidates` counts failed calls with no child launch. It does not prove that a later call corrected the same intent. `semanticRepairs` is always `null` and `semanticRepairEvidence` is `unavailable` until a parent-owned structured disposition contract exists.

## Redaction

The schema must never include:

- prompts, objectives, user or child messages;
- stdout, stderr, tool text, or external file content;
- task IDs or repository paths;
- environment variables, credentials, settings, or raw route configuration;
- session directory paths.

Provider/model/thinking identifiers and aggregate usage are intentionally retained because route evaluation owns those fields.
