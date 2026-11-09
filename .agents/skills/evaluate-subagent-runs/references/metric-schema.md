# Subagent Session Metric Schema

`schemaVersion = 5` identifies a redacted evaluation document; runtime state and workflow records have their own owners. It is independent of the collaboration/managed envelope version (currently `4`) and of the session-view version (currently `4`): those describe runtime payloads, while `schemaVersion` versions only this report.

The evaluator reads the retired one-shot `csheng_subagents` tool name and the canonical managed `agent` and known historical `csheng_subagent_sessions` tool names only to **classify** envelopes. One-shot task payloads remain outside interpretation; managed envelopes are interpreted only when their `schemaVersion === 4`. Every other version is excluded before any nested field is read and is reported as an exclusion; invalid current evidence has its own category. Classification uses the current-version evidence boundary.

## Top level

- `schemaVersion`: the metric artifact version (`5`).
- `source`: selected/excluded/unavailable envelope coverage and the selection mode.
- `observations`: owned native/managed evidence. Count its usage once across transport totals.
- `managedDispatch`: managed transport/invocation evidence, with its own explicit denominator.

This version emits only the sections below; older report shapes and legacy one-shot aggregates remain outside its output.

## Source and version selection

- `sessionId`: identifier derived from the selected JSONL filename, or `current-epoch`.
- `selectionMode`: `exact-session` or `current-epoch`.
- `scannedSessions`: `1` for exact-session; the number of walked JSONL files for current-epoch.
- `matchedSessions`: sessions that contributed supported current evidence.
- `selectedRuns`: exact-session counts supported current managed tool-result envelopes; current-epoch reports the managed selector's `selectedRequests` (distinct owned requests with a matching epoch).
- `excludedRuns`: exact-session counts unsupported envelopes (retired one-shot results and managed results whose version is not `4`); current-epoch adds the managed selector's `excludedRequests` to those unsupported envelopes.
- `unavailableProvenanceRuns`: `0` for exact-session; current-epoch reports the managed selector's `unassignedRequests` (current requests with no effective extension/configuration pair).
- `planEligibility`: always `unavailable`; plan conformance belongs to the parent.

`excluded`, `invalid`, and `unavailable` are separate categories:

- **excluded** — an envelope with an unsupported version. Classify it before nested interpretation and count it separately from current work.
- **invalid** — a current-version envelope whose payload fails bounded shape/consistency validation. Report it separately from current coverage.
- **unavailable** — current evidence that exists but lacks a required, non-inferable field (for example a missing epoch pair).

Excluded and unavailable evidence retain separate categories outside known totals.

## Owned native observations

Exact-session `observations` consumes version-one parent custom observations and embedded native child projections. `available` means recognized owned observation windows exist; each field and the observed task lifetime have separate completeness. The physical native reader shares the producer's 32 MiB, 100,000-entry, 1 MiB-line bounds and rejects partial tails. A complete prefix requires well-formed, non-overlapping, consistent evidence. A copied fork prefix has no new owner; only validated new-owner ranges contribute. Native observations require an exact-session input; the current-epoch projection leaves them unavailable.

- `excludedRecords`: unsupported envelope versions encountered while reading owned windows (v3 execution events, retired one-shot tool results, non-current managed tool results). Counted separately; current evidence retains its own validity.
- `observedSessions` and `observedEpisodes`: unique managed handles and handle/episode pairs seen in owned windows; launches are counted separately.
- `actions`: observed managed `create`/`continue`/`inspect`/`apply`/`close` tool-result counts.
- `outcomes.executionSucceeded`, `reportComplete`, and `candidatesApplied`: distinct committed episode/candidate facts. `candidatesApplied` counts a **logical candidate once** and only when its own status is `applied`; root-level status changes retain the same logical candidate count. Each episode retains its result through later request errors. Parent acceptance is a separate judgment.
- `rootStatuses`: a bounded per-root projection of `{ candidateId, rootId, destination, status, recovery, release }`. `candidateId` is `null` when no candidate was frozen. `recovery` is `required` for `applying`/`partial`/`unknown` windows, otherwise `clear`. `release` is that root's own `pending`/`remaining`/`released` fact, derived from the record's owned state; the aggregate status is separate. Rows are keyed by stable session/episode/root identity, so repeated reads update one row.
- `releases`: the bounded aggregate `{ candidateId, status, remaining }` per session, kept **separate** from `rootStatuses`. A `partial` release with only session `scratch` remaining therefore reports every projected root as released and one aggregate partial cleanup; scratch remains an aggregate cleanup fact.
- `usage.parent`, `children`, and `total`: six nullable `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` values, recomputed from direct native rows with owner/entry deduplication. Total is recomputed from direct native rows. This is cumulative referenced owned evidence, counted once per logical owner/episode; billing for the current replay/inspect call is a separate matter.
- `models`: at most 1,000 groups with an opaque tuple-hashed `modelKey` (or `null`) and owned usage. `modelCoverage` is `complete` or `unavailable`; unavailable grouping preserves model count as unavailable.

Direct assistant, compaction, and branch-summary rows contribute once; nested tool aggregates and retained context copies remain outside the sum. Failed summary usage remains unknown. Missing fields remain `null`, real zero stays zero, and valid metrics require finite values. A missing disposable cache on replay can reuse earlier valid evidence for that episode; conflicting entries, timing, command, or configured capability snapshots cannot silently choose whichever was read first. Launched child identities without matching view evidence make child usage unavailable.

`timing` reports independently validated parent wall, active, reasoning, local delegation wait, compaction, and unattributed milliseconds, plus worker effort/occupied wall. Parent active is the union of assistant/local-tool/compaction spans; wait can overlap activity. Unattributed is the complement of observed activity plus wait; user idle requires separate evidence. Each owned parent window is measured separately. Run child offsets are translated and unioned only with matching process clock keys and known origins/endpoints. A known parent boundary can remain available when reasoning endpoints or a child clock are missing.

`childTiming` reports summed episode wall, active, reasoning, local-tool, and compaction effort. It unions spans inside each valid episode, then sums those separately measured values across child processes. Parallel occupied wall and server compute require separate evidence. Missing/incomplete child timing remains unavailable independently of parent process duration.

`commands` reports coverage (`complete`/`partial`/`unavailable`), deduplicated observed rows and status counts, duration effort, and source/environment endpoint-change counts. Aggregate duration and change totals require complete coverage and known endpoints; partial observed status counts retain partial coverage. Equal before/after hashes leave transient mutation possible. A command's purpose and parent acceptance require separate evidence from its successful exit. No command text, hashes, or raw call IDs are exported. Native command rows carry their own command-correlation version; legacy raw-ID and current hashed-key representations normalize before comparison, and unknown keys/versions stay conservative.

`childCapabilities` reports the count of known manifest identities, distinct configured context windows, and configured tool sets. Missing configurations remain `null`. These are host-state observations; final provider payload, sandbox permissions, token utilization, and provider quotas require their own evidence. No manifest paths or hashes are emitted.

Validated owned rows, command records, and capabilities retain their own completeness when native timing is missing. Usage is scoped to committed recorded rows; a complete bill for a killed in-flight request requires separate evidence.

## Managed dispatch

This section counts transport evidence; missions, acceptance, fresh work on replay, and cost have separate evidence. It reads current managed tool results and owner-tagged v3/v4 execution custom entries; action reconstruction uses those records. A current managed result's `requestTelemetry` carries native owner/invocation identity, wall start, nullable monotonic duration, observed extension/configuration epochs, nullable requested/admitted widths, actual launches, and replayed-episode count. Non-execution actions launch zero children. A replayed episode requires a committed episode; queued tasks remain separate.

- `recordedResults`: all encountered managed tool-result records within bounds, including invalid and copied records.
- `ownedRequests`: distinct valid current managed owner/invocation pairs after excluding conflicting identities; equal repeated records count once. Physical header ownership must match; copied fork records retain their original ownership.
- `selectedRequests`, `excludedRequests`, `unassignedRequests`: partition valid owned requests. Exact-session mode selects all valid owned requests. Current-epoch mode selects only matching extension/configuration pairs with an eligible start; missing pairs are unassigned. Invocation provenance retains its own evidence requirement alongside returned session/episode provenance.
- `excludedRecords`: unsupported envelope versions (v3 execution custom events and non-current managed results), excluded before interpretation.
- `invalidRecords`: current-version records that fail shape/consistency validation.
- `conflictingRequests`, `duplicateRecords`, `copiedRecords`: independently named conflict/duplicate/copied evidence; a conflict removes that invocation from authoritative counts.
- `actions`: bounded selected-request groups containing only action, status, and count. A null action is `invalid-request`. `errors` contains bounded selected stable request-code counts.
- `launchedChildren` and `replayedEpisodes`: `{ known, unavailableRequests }`. Known sums cover selected valid requests (each logical request counted once); unavailable requests count invalid records and conflicting identities. Excluded and unassigned requests are reported through their own buckets, separate from known sums.

No request IDs, handles, native owner/invocation identities, epoch values, reports, or command keys appear in redacted dispatch output.

### Asynchronous evidence

`managedDispatch.async` is additive and absent when no receipt/event evidence exists. `receipts` counts accepted admission, `runs` distinct referenced runs, and `terminalRuns`/`terminalTasks` selected terminal evidence. `duplicateEvents`, `conflictingEvents`, `copiedEvents`, `invalidEvents`, and `excludedTasks` expose evidence quality; semantic outcome remains a separate judgment.

`launchedChildren` comes from terminal episode `childStarted` evidence; receipts and repeated inspect/join retain their separate roles. `timing` contains nullable `preparationMs`, `queueMs`, `workspaceMs`, `childEffortMs`, and `submissionToTerminalMs`. Task/run facts deduplicate by owner and episode; conflicting results cannot be replaced merely to enrich timing. The epoch activation predicate applies equally to selected task facts and run latency. Missing phase timing is unavailable; a recorded zero represents a measured zero. Native observation entry ownership prevents receipt/event/replay double billing, and cross-turn async worker occupancy is not assigned to an unrelated parent window.

## Explicit parent disposition

Exact-session mode can additionally read one explicitly supplied `--disposition <json-file>` of at most 4 KiB. The exact shape is `{version:1,parentSessionId,startEntryId,endEntryId,outcome,startedAtMs?,acceptedAtMs?,semanticRepairs?,takeovers?}`. The owner must match the native header; both entry IDs must exist in physical order. Outcome is `accepted` or `rejected`. Optional numeric fields accept omission or explicit null; known endpoints are finite/nonnegative and ordered, and repair/takeover counts are nonnegative safe integers. Unknown keys and prose are rejected.

`parentDispositionScope` becomes `explicit-entry-range`; whole-report acceptance remains a separate parent judgment. `outcomes.parentAccepted`, `semanticRepairs`, and `takeovers` reflect only that parent declaration. `acceptedDeliveryWallMs` requires an accepted outcome and both explicit finite endpoints; otherwise it is `null`. All these fields remain unavailable without a declaration. The evaluator validates association and shape; the parent owns semantic judgment and candidate application, and runtime state remains unchanged. Compare declared delivery intervals and recorded costs using matching scopes, and label any scope difference.

## Redaction

The schema must never include:

- prompts, objectives, user or child messages;
- raw model selectors, assistant tool arguments, stdout, stderr, tool prose, or external file content;
- task IDs or repository paths beyond the bounded root `destination` projection explicitly listed above;
- environment variables, credentials, settings, or raw route configuration;
- session directory paths.

Resolved provider/model/thinking identifiers, bounded stable error codes, operator/tool names, candidate/root identifiers, bounded root destinations, and aggregate usage are intentionally retained because evaluation owns those fields. Candidate lists and error prose remain outside retained output.
