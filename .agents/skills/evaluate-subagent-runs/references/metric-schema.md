# Subagent Session Metric Schema

`schemaVersion = 4` is a redacted evaluation document, not runtime state and not a workflow ledger. The evaluator reads runtime telemetry schema versions one through four and qualified legacy task results; it always emits this metric schema version. Current-epoch mode selects matching schema-three and schema-four runs and never infers provenance from mtime or prose.

## Top level

- `source.legacyCountersScope`: `csheng_subagents-only`. That name is the historical one-shot tool, not the registered managed runtime. Existing `totals`, `roles`, `routes`, `errors`, `concurrency`, and `runs` keep that historical one-shot meaning and do not include managed calls or parent-native usage.
- `observations`: separately owned native/managed evidence described below; never add its usage to the legacy aggregate a second time.
- `managedDispatch`: additive metric-v4 transport evidence, independent of settled observation windows and one-shot totals. Older reports lacking this section have unavailable managed dispatch evidence, not known zero.
- `source.sessionId`: identifier derived from the selected JSONL filename.
- `source.telemetryMode`: `authoritative`, `legacy`, or `mixed`. Recognized runtime telemetry versions are authoritative only for the fields they declare.
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

## Version-four timing

Runtime v4 measures `runDurationMs` from tool entry through final result readiness, including admission and awaited cleanup, on one parent-process monotonic clock. `runs[].timing.boundary` distinguishes `tool-entry` from standalone `scheduler` measurements. Wall-clock `startedAtMs` remains provenance correlation, not a duration source. Historical v1–v3 run durations keep their original meaning; legacy inference is unchanged.

`runs[].timing` is unavailable (`null`) for older or missing evidence. Recognized v4 timing provides:

- `schedulerMs`: a separately validated scheduler span, or `null`;
- `complete`: whether all required interval evidence is valid and complete;
- `workerEffortMs`: summed parent-observed worker child intervals;
- `workerOccupiedMs`: the union of those intervals on the common parent clock;
- `waitMsByReason`: summed task waiting spans for `dependency`, global `capacity`, `role-capacity`, `resource-lock`, and eligible `ready` time.

Invalid, backward, nonfinite, missing, or unclosed endpoints do not become zero: incomplete worker/wait totals are `null`. A complete empty interval set legitimately totals zero. Wait reasons can overlap; their sums are not a partition of wall time. Effort is neither wall time nor provider utilization: three workers each alive for ten overlapping minutes contribute thirty minutes of effort and ten occupied minutes. These are process observations, not model-only work, provider queue time, or child reasoning time. Native episode/command observations are consumed separately rather than changing these historical counters. Parent acceptance is never supplied by process timing.

Raw timing task IDs and intervals are projected into bounded redacted summaries, never copied. Existing `totals.durationMs` and role/route durations remain sums of task durations, not the v4 tool wall duration. Current-epoch v4 selection accepts fractional or explicitly unavailable run duration without inventing timing; the provenance and count checks still apply.

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

`mechanicalDispatchCorrectionCandidates` counts failed calls with no child launch. It does not prove that a later call corrected the same intent. Legacy `totals.semanticRepairs` remains `null` with `semanticRepairEvidence: unavailable`. Explicit scoped parent declarations are separate under `observations.outcomes`.

## Owned native observations

Exact-session `observations` consumes version-one parent custom observations and embedded native child projections from both tools. `available` means recognized owned observation windows exist, not that every field is complete or that the whole task lifetime was observed. The physical native reader shares the producer's 32 MiB, 100,000-entry, 1 MiB-line bounds and rejects partial tails. Malformed/overlapping/conflicting evidence does not become a complete prefix. A copied fork prefix has no new owner; only validated new-owner ranges can contribute.

- `observedSessions` and `observedEpisodes`: unique managed handles and handle/episode pairs seen in owned windows, not new launches per request.
- `actions`: observed managed create/continue/inspect/apply/close tool-result counts.
- `outcomes.executionSucceeded`, `reportComplete`, and `candidatesApplied`: distinct committed episode/candidate facts. An error on a later request does not replace a previous episode's result. None is parent acceptance.
- `usage.parent`, `children`, and `total`: six nullable `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` values, recomputed from direct native rows with owner/entry deduplication. Total is not legacy aggregate plus native cost. This is cumulative referenced owned evidence, not a bill for the current replay/inspect call.
- `models`: at most 1,000 groups with opaque tuple-hashed `modelKey` (or null) and owned usage. `modelCoverage` is complete or unavailable; unavailable grouping does not silently claim zero models.

Direct assistant, compaction, and branch-summary rows contribute once; nested tool aggregates and retained context copies do not. Failed summary usage remains unknown. Missing fields remain null, real zero stays zero, and nonfinite overflow is not a valid metric. A missing disposable cache on replay can reuse earlier valid evidence for that episode; conflicting entries, timing, command, or configured capability snapshots cannot silently choose whichever was read first. Launched child identities without matching view evidence make child usage unavailable rather than free.

`timing` reports independently validated parent wall, active, reasoning, local delegation wait, compaction, and unattributed milliseconds, plus worker effort/occupied wall. Parent active is the union of assistant/local-tool/compaction spans; wait can overlap activity. Unattributed is the complement of observed activity plus wait, not proven user idle. Each owned parent window is measured separately. Run child offsets are translated only with matching process clock keys and known origins/endpoints; unrelated clocks are never unioned. A known parent boundary can remain available when reasoning endpoints or a child clock are missing.

`childTiming` reports summed episode wall, active, reasoning, local-tool, and compaction effort. It unions spans inside each valid episode, then sums those separately measured values across child processes. It never presents that effort as parallel occupied wall or server compute. Missing/incomplete child timing does not inherit parent process duration.

`commands` reports coverage (complete/partial/unavailable), deduplicated observed rows and status counts, duration effort, and source/environment endpoint-change counts. Aggregate duration and change totals require complete coverage and known endpoints; partial observed status counts are not a complete command total. Equal before/after hashes do not prove no transient mutation. A successful command is not proof that the command was a test or that the parent accepted its output. No command text, hashes, or raw call IDs are exported.

`childCapabilities` reports the count of known manifest identities, distinct configured context windows, and configured tool sets. Missing configurations remain null. These are host-state observations, not final provider payload, stronger sandbox permissions, token utilization, or provider quotas. No manifest paths or hashes are emitted.

Current-epoch mode retains the historical source counters/provenance selector and its unassigned create/continue accounting for backward compatibility. The separate `managedDispatch` selector consumes v2 invocation telemetry with its own explicit denominator. Neither selector infers a missing pair from current settings, file time, or prose. Native `observations` remain unavailable for the epoch-filtered projection; select an exact session to inspect them.

Missing native timing does not erase otherwise validated owned rows, command records, or capabilities. Each plane retains its own completeness. Usage is still scoped to committed recorded rows and does not assert a complete bill for a killed in-flight request. New command projections declare `commandCorrelationVersion: 2`; legacy raw-ID and current hashed-key representations normalize before comparison/deduplication. Unknown keys/versions and conflicting evidence remain conservative.

## Managed dispatch

This section counts transport evidence, not missions, acceptance, fresh work on replay, or cost. It reads only structured managed tool results; it never reconstructs historical actions from assistant arguments or error prose. Result v2 contains `requestTelemetry` version one with native owner/invocation identity, wall start, nullable monotonic duration, observed extension/configuration epochs, nullable requested/admitted widths, actual launches, and replayed-episode count. Non-execution actions launch zero children. A queued task with no committed episode does not become a replayed episode.

- `recordedResults`: all encountered managed tool-result records within bounds, including invalid and copied records.
- `ownedRequests`: distinct valid v2 owner/invocation pairs after excluding conflicting identities; equal repeated records count once. Physical header ownership must match; copied fork records do not gain ownership.
- `selectedRequests`, `excludedRequests`, `unassignedRequests`: partition valid owned requests. Exact-session mode selects all valid owned requests. Current-epoch mode selects only matching extension/configuration pairs with an eligible start; missing pairs are unassigned. Returned session/episode provenance never substitutes for invocation provenance.
- `legacyResults` and `legacyActions`: v1 recorded-result counts by recorded action/status, without claiming unique ownership, correcting historically mislabeled inspect, or inventing launch evidence.
- `invalidRecords`, `conflictingRequests`, `duplicateRecords`, `copiedRecords`: independently named exclusions/duplicate evidence; a conflict removes that invocation from authoritative counts.
- `actions`: bounded selected-request groups containing only action, status, and count. Null action is `invalid-request`, never inspect. `errors` contains bounded selected stable request-code counts.
- `launchedChildren` and `replayedEpisodes`: `{ known, unavailableRequests }`. Known sums cover selected valid requests; unavailable requests count legacy records, invalid records, and conflicting identities. Excluded and unassigned valid requests are reported through their selection buckets rather than silently merged into the known sums.

All fields preserve the historical `csheng_subagents-only` meaning of the pre-existing aggregate sections. No request IDs, handles, native owner/invocation identities, epoch values, reports, or command keys appear in redacted dispatch output. Static parent-acceptance ownership remains documentation; missing disposition remains an offline nullable metric, not a routine runtime warning.

## Explicit parent disposition

Exact-session mode can additionally read one explicitly supplied `--disposition <json-file>` of at most 4 KiB. The exact shape is `{version:1,parentSessionId,startEntryId,endEntryId,outcome,startedAtMs?,acceptedAtMs?,semanticRepairs?,takeovers?}`. The owner must match the native header; both entry IDs must exist in physical order. Outcome is `accepted` or `rejected`. Optional numeric fields accept omission or explicit null; known endpoints are finite/nonnegative and ordered, and repair/takeover counts are nonnegative safe integers. Unknown keys and prose are rejected.

`parentDispositionScope` becomes `explicit-entry-range`, not whole-report acceptance. `outcomes.parentAccepted`, `semanticRepairs`, and `takeovers` reflect only that parent declaration. `acceptedDeliveryWallMs` requires accepted outcome and both explicit finite endpoints; otherwise it is null. All these fields remain unavailable without a declaration. The evaluator validates association and shape, not the parent's semantic judgment, and never applies candidates or mutates runtime state. Do not pair a narrow declared delivery interval with wider recorded costs as if their scopes were equal.

## Redaction

The schema must never include:

- prompts, objectives, user or child messages;
- raw model selectors, assistant tool arguments, stdout, stderr, tool prose, or external file content;
- task IDs or repository paths;
- environment variables, credentials, settings, or raw route configuration;
- session directory paths.

Resolved provider/model/thinking identifiers, bounded stable error codes, selection source, configuration source, and aggregate usage are intentionally retained because route evaluation owns those fields. Candidate lists and error prose are not retained.
