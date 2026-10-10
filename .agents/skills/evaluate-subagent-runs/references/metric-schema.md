# Subagent Session Metric Schema

`schemaVersion = 5` is a redacted evaluation document, not runtime state and not a workflow ledger. It is independent of the collaboration/managed envelope version (currently `4`) and of the session-view version (currently `4`): those describe runtime payloads, while `schemaVersion` versions only this report.

The evaluator reads the retired one-shot `csheng_subagents` tool name and the registered managed `csheng_subagent_sessions` tool name only to **classify** envelopes. It never interprets one-shot task payloads, and it interprets a managed envelope only when its `schemaVersion === 4`. Every other version is excluded before any nested field is read and is reported as an exclusion, not as invalid current evidence. There is no legacy inference and no compatibility adapter.

## Top level

- `schemaVersion`: the metric artifact version (`5`).
- `source`: selected/excluded/unavailable envelope coverage and the selection mode.
- `observations`: owned native/managed evidence. Never add its usage to any transport count a second time.
- `managedDispatch`: managed transport/invocation evidence, with its own explicit denominator.

This version emits only the sections below. It does not emit legacy one-shot aggregate sections, and it provides no adapter for older report shapes.

## Source and version selection

- `sessionId`: identifier derived from the selected JSONL filename, or `current-epoch`.
- `selectionMode`: `exact-session` or `current-epoch`.
- `scannedSessions`: `1` for exact-session; the number of walked JSONL files for current-epoch.
- `matchedSessions`: sessions that contributed supported current evidence.
- `selectedRuns`: exact-session counts supported current managed tool-result envelopes; current-epoch reports the managed selector's `selectedRequests` (distinct owned requests with a matching epoch).
- `excludedRuns`: exact-session counts unsupported envelopes (retired one-shot results and managed results whose version is not `4`); current-epoch adds the managed selector's `excludedRequests` to those unsupported envelopes.
- `unavailableProvenanceRuns`: `0` for exact-session; current-epoch reports the managed selector's `unassignedRequests` (current requests with no effective extension/configuration pair).
- `planEligibility`: always `unavailable`; this document does not judge plan conformance.

`excluded`, `invalid`, and `unavailable` are separate categories:

- **excluded** — an envelope whose version is not the current supported version. It is never interpreted and never counted as current work.
- **invalid** — a current-version envelope whose payload fails bounded shape/consistency validation. It cannot silently become current coverage.
- **unavailable** — current evidence that exists but lacks a required, non-inferable field (for example a missing epoch pair).

Neither excluded nor unavailable evidence is silently merged into a known total.

## Owned native observations

Exact-session `observations` consumes version-one parent custom observations and embedded native child projections. `available` means recognized owned observation windows exist, not that every field is complete or that the whole task lifetime was observed. The physical native reader shares the producer's 32 MiB, 100,000-entry, 1 MiB-line bounds and rejects partial tails. Malformed, overlapping, or conflicting evidence does not become a complete prefix. A copied fork prefix has no new owner; only validated new-owner ranges contribute. Native observations require an exact-session input; the current-epoch projection leaves them unavailable.

- `excludedRecords`: unsupported envelope versions encountered while reading owned windows (v3 execution events, retired one-shot tool results, non-current managed tool results). Counted separately; they never invalidate current evidence.
- `observedSessions` and `observedEpisodes`: unique managed handles and handle/episode pairs seen in owned windows, not new launches per request.
- `actions`: observed managed `create`/`continue`/`inspect`/`apply`/`close` tool-result counts.
- `outcomes.executionSucceeded`, `reportComplete`, and `candidatesApplied`: distinct committed episode/candidate facts. `candidatesApplied` counts a **logical candidate once** and only when its own status is `applied`; a root-level status change never adds a second applied candidate. An error on a later request does not replace a previous episode's result. None is parent acceptance.
- `rootStatuses`: a bounded per-root projection of `{ candidateId, rootId, destination, status, recovery, release }`. `candidateId` is `null` when no candidate was frozen. `recovery` is `required` for `applying`/`partial`/`unknown` windows, otherwise `clear`. `release` is that root's own `pending`/`remaining`/`released` fact, derived from the record's owned state, not copied from the aggregate status. Rows are keyed by stable session/episode/root identity, so repeated reads update one row instead of multiplying it.
- `releases`: the bounded aggregate `{ candidateId, status, remaining }` per session, kept **separate** from `rootStatuses`. A `partial` release with only session `scratch` remaining therefore reports every projected root as released and one aggregate partial cleanup; scratch is never invented as a per-root failure.
- `usage.parent`, `children`, and `total`: six nullable `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` values, recomputed from direct native rows with owner/entry deduplication. Total is not a sum of unrelated aggregates. This is cumulative referenced owned evidence, not a bill for the current replay/inspect call, and it is counted once per logical owner/episode.
- `models`: at most 1,000 groups with an opaque tuple-hashed `modelKey` (or `null`) and owned usage. `modelCoverage` is `complete` or `unavailable`; unavailable grouping does not silently claim zero models.

Direct assistant, compaction, and branch-summary rows contribute once; nested tool aggregates and retained context copies do not. Failed summary usage remains unknown. Missing fields remain `null`, real zero stays zero, and nonfinite overflow is not a valid metric. A missing disposable cache on replay can reuse earlier valid evidence for that episode; conflicting entries, timing, command, or configured capability snapshots cannot silently choose whichever was read first. Launched child identities without matching view evidence make child usage unavailable rather than free.

`timing` reports independently validated parent wall, active, reasoning, local delegation wait, compaction, and unattributed milliseconds, plus worker effort/occupied wall. Parent active is the union of assistant/local-tool/compaction spans; wait can overlap activity. Unattributed is the complement of observed activity plus wait, not proven user idle. Each owned parent window is measured separately. Run child offsets are translated only with matching process clock keys and known origins/endpoints; unrelated clocks are never unioned. A known parent boundary can remain available when reasoning endpoints or a child clock are missing.

`childTiming` reports summed episode wall, active, reasoning, local-tool, and compaction effort. It unions spans inside each valid episode, then sums those separately measured values across child processes. It never presents that effort as parallel occupied wall or server compute. Missing/incomplete child timing does not inherit parent process duration.

`commands` reports coverage (`complete`/`partial`/`unavailable`), deduplicated observed rows and status counts, duration effort, and source/environment endpoint-change counts. Aggregate duration and change totals require complete coverage and known endpoints; partial observed status counts are not a complete command total. Equal before/after hashes do not prove no transient mutation. A successful command is not proof that the command was a test or that the parent accepted its output. No command text, hashes, or raw call IDs are exported. Native command rows carry their own command-correlation version; legacy raw-ID and current hashed-key representations normalize before comparison, and unknown keys/versions stay conservative.

`childCapabilities` reports the count of known manifest identities, distinct configured context windows, and configured tool sets. Missing configurations remain `null`. These are host-state observations, not final provider payload, stronger sandbox permissions, token utilization, or provider quotas. No manifest paths or hashes are emitted.

Missing native timing does not erase otherwise validated owned rows, command records, or capabilities. Each plane retains its own completeness. Usage is still scoped to committed recorded rows and does not assert a complete bill for a killed in-flight request.

## Managed dispatch

This section counts transport evidence, not missions, acceptance, fresh work on replay, or cost. It reads current managed tool results and owner-tagged v3/v4 execution custom entries; it never reconstructs actions from assistant arguments or error prose. A current managed result's `requestTelemetry` carries native owner/invocation identity, wall start, nullable monotonic duration, observed extension/configuration epochs, nullable requested/admitted widths, actual launches, and replayed-episode count. Non-execution actions launch zero children. A queued task with no committed episode does not become a replayed episode.

- `recordedResults`: all encountered managed tool-result records within bounds, including invalid and copied records.
- `ownedRequests`: distinct valid current managed owner/invocation pairs after excluding conflicting identities; equal repeated records count once. Physical header ownership must match; copied fork records do not gain ownership.
- `selectedRequests`, `excludedRequests`, `unassignedRequests`: partition valid owned requests. Exact-session mode selects all valid owned requests. Current-epoch mode selects only matching extension/configuration pairs with an eligible start; missing pairs are unassigned. Returned session/episode provenance never substitutes for invocation provenance.
- `excludedRecords`: unsupported envelope versions (v3 execution custom events and non-current managed results), excluded before interpretation.
- `invalidRecords`: current-version records that fail shape/consistency validation.
- `conflictingRequests`, `duplicateRecords`, `copiedRecords`: independently named conflict/duplicate/copied evidence; a conflict removes that invocation from authoritative counts.
- `actions`: bounded selected-request groups containing only action, status, and count. A null action is `invalid-request`, never `inspect`. `errors` contains bounded selected stable request-code counts.
- `launchedChildren` and `replayedEpisodes`: `{ known, unavailableRequests }`. Known sums cover selected valid requests (each logical request counted once); unavailable requests count invalid records and conflicting identities. Excluded and unassigned requests are reported through their own buckets rather than silently merged into the known sums.

No request IDs, handles, native owner/invocation identities, epoch values, reports, or command keys appear in redacted dispatch output.

### Asynchronous evidence

`managedDispatch.async` is additive and absent when no receipt/event evidence exists. `receipts` counts accepted admission, `runs` distinct referenced runs, and `terminalRuns`/`terminalTasks` selected terminal evidence. `duplicateEvents`, `conflictingEvents`, `copiedEvents`, `invalidEvents`, and `excludedTasks` expose evidence quality, not semantic outcome.

`launchedChildren` comes from terminal episode `childStarted` evidence, never a receipt or repeated inspect/join. `timing` contains nullable `preparationMs`, `queueMs`, `workspaceMs`, `childEffortMs`, and `submissionToTerminalMs`. Task/run facts deduplicate by owner and episode; conflicting results cannot be replaced merely to enrich timing. The epoch activation predicate applies equally to selected task facts and run latency. Missing phase timing is unavailable, not a fabricated zero. Native observation entry ownership prevents receipt/event/replay double billing, and cross-turn async worker occupancy is not assigned to an unrelated parent window.

## Explicit parent disposition

Exact-session mode can additionally read one explicitly supplied `--disposition <json-file>` of at most 4 KiB. The exact shape is `{version:1,parentSessionId,startEntryId,endEntryId,outcome,startedAtMs?,acceptedAtMs?,semanticRepairs?,takeovers?}`. The owner must match the native header; both entry IDs must exist in physical order. Outcome is `accepted` or `rejected`. Optional numeric fields accept omission or explicit null; known endpoints are finite/nonnegative and ordered, and repair/takeover counts are nonnegative safe integers. Unknown keys and prose are rejected.

`parentDispositionScope` becomes `explicit-entry-range`, not whole-report acceptance. `outcomes.parentAccepted`, `semanticRepairs`, and `takeovers` reflect only that parent declaration. `acceptedDeliveryWallMs` requires an accepted outcome and both explicit finite endpoints; otherwise it is `null`. All these fields remain unavailable without a declaration. The evaluator validates association and shape, not the parent's semantic judgment, and never applies candidates or mutates runtime state. Do not pair a narrow declared delivery interval with wider recorded costs as if their scopes were equal.

## Redaction

The schema must never include:

- prompts, objectives, user or child messages;
- raw model selectors, assistant tool arguments, stdout, stderr, tool prose, or external file content;
- task IDs or repository paths beyond the bounded root `destination` projection explicitly listed above;
- environment variables, credentials, settings, or raw route configuration;
- session directory paths.

Resolved provider/model/thinking identifiers, bounded stable error codes, operator/tool names, candidate/root identifiers, bounded root destinations, and aggregate usage are intentionally retained because evaluation owns those fields. Candidate lists and error prose are not retained.
