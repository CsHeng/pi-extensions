# Subagent Session Metric Schema

`schemaVersion = 2` is a redacted evaluation document, not runtime state and not a workflow ledger. The evaluator reads runtime telemetry schema versions one and two and qualified legacy task results; it always emits this metric schema version.

## Top level

- `source.sessionId`: identifier derived from the selected JSONL filename.
- `source.telemetryMode`: `authoritative`, `legacy`, or `mixed`. Both runtime telemetry versions are authoritative for the fields they declare.
- `totals`: run, requested/admitted/persisted task, launch, usage, duration, changed-path, singleton, zero-change-worker, and correction evidence.
- `roles`: explorer, reviewer, and worker aggregates.
- `routes`: aggregates keyed by resolved provider, model, thinking, configuration source, and selection source.
- `errors`: stable error-code counts.
- `concurrency`: largest known requested width and authoritative observed peak when available.
- `runs`: the first 1,000 per-call metrics by ordinal with role summaries; `totals.toolCalls` remains the complete count. No task objective, output, ID, selector, or path is retained.

## Version-two metrics

Runtime telemetry schema two supplies exact per-run:

- `requestedTasks`, `admittedTasks`, and `launchedChildren`;
- `requestedDependencyEdges` and `admittedDependencyEdges`;
- `explicitModelTasks` and `explicitThinkingTasks`;
- run duration and peak concurrency.

`totals.requestedTasks`, `totals.admittedTasks`, and `totals.launchedChildren` sum their known run values. `totals.hardDependencyEdges`, `totals.explicitModelTasks`, and `totals.explicitThinkingTasks` each have `{ known, unavailableRuns }`. The hard-dependency total counts requested hard edges, including edges in a graph rejected before admission. For runtime schema one and legacy runs, the corresponding per-run fields are `null` and `unavailableRuns` increments. The evaluator never reconstructs these fields from assistant tool arguments or prose.

`totals.singletonRuns` counts runs whose authoritative or legacy-inferred `requestedTasks` is exactly one. Empty legacy rejections have `requestedTasks = null`, are excluded from requested-width totals, and are not singletons.

`totals.zeroChangeWorkers` counts historical task results with role `worker`, status `succeeded`, and a structured empty `changedPaths` array. Missing changed-path evidence is not inferred. A `worker_no_changes` failure remains an error, not a successful zero-change worker.

Each bounded run includes role summaries so singleton role, usage, cost, duration, launch, and outcome remain derivable without retaining task identifiers or prose.

## Route attribution

Route aggregates intentionally retain the resolved provider, model, thinking, and configuration `source`. Their key also includes `selectionSource`:

- `role-default`: package or user role defaults selected the physical model, with or without an applied execution profile;
- `explicit-task`: an ephemeral task parameter selected the physical model;
- `unavailable`: old or incomplete route evidence did not declare selection source.

Selection source is mechanical attribution and does not prove user intent. Raw model selectors are never retained or reconstructed.

## Older evidence labels

Runtime telemetry schema one remains authoritative for its requested/admitted/launched counts, run duration, and peak concurrency. New schema-two topology and explicit-route request fields are unavailable.

For legacy details:

- a task is inferred to have launched only when `usage.turns > 0`;
- run duration is inferred as the maximum task duration;
- requested and admitted width are inferred from a non-empty persisted task list;
- an empty legacy result has unknown requested/admitted width (`null`);
- observed peak concurrency remains `null`.

`mechanicalDispatchCorrectionCandidates` counts failed calls with no child launch. It does not prove that a later call corrected the same intent. `semanticRepairs` is always `null` and `semanticRepairEvidence` is `unavailable` until a parent-owned structured disposition contract exists.

## Redaction

The schema must never include:

- prompts, objectives, user or child messages;
- raw model selectors, assistant tool arguments, stdout, stderr, tool prose, or external file content;
- task IDs or repository paths;
- environment variables, credentials, settings, or raw route configuration;
- session directory paths.

Resolved provider/model/thinking identifiers, bounded stable error codes, selection source, configuration source, and aggregate usage are intentionally retained because route evaluation owns those fields. Candidate lists and error prose are not retained.
