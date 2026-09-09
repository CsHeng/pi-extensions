# Subagent Result and Telemetry Reliability Design

Status: implemented and verified locally on 2026-09-09; see the companion plan for verification and review evidence.

Companion: [Implementation plan](2026-09-09-subagent-result-and-telemetry-reliability-plan.md).

## Objective and authority

Make subagent results describe execution facts rather than an extension-invented acceptance state, and make managed execution health measurable without confusing requests, launches, replay, and incomplete observations. After independent design/plan review, the user explicitly approved implementation of this bounded scope. Installation, configuration changes, and provider experiments remain excluded.

The user's clarification is binding: `parent acceptance unavailable` must not be emitted as a routine result, log, or user message. Acceptance is a parent judgment, not an execution state for the extension to compute or persist. A compact tool instruction may state who owns acceptance; it must not publish a pretend internal reasoning state.

Design depth: design-full for the bounded result/observation compatibility boundary. No new scheduler, workflow owner, database, accounting ledger, or extension is needed.

## Current evidence

The read-only investigation scanned 78 local parent JSONL files against the explicitly selected current provenance manifest. Its current extension/configuration pair matched 46 one-shot batches in eight sessions: 88 tasks launched, 86 succeeded, one explorer returned `incomplete_report`, and one worker hit the 15-minute task timeout. Managed evidence was separate: two parent sessions, 33 request results, five distinct episodes, four successful episodes, one worker timeout, and two applied candidates. These are bounded historical observations, not a future health threshold or an acceptance declaration. The active investigation itself can create later records; implementation must not use these counts as a moving test fixture.

| ID | Current repository/runtime fact | Owner |
| --- | --- | --- |
| F1 | `render.ts` injects `parentAcceptance: "unavailable"` into every managed model payload and repeats the phrase in TUI output. `SessionActionResult` has no acceptance field. | Managed rendering |
| F2 | `ContinuationService.execute()` maps every parser exception to `failed("inspect", ...)`. A failed create and a failed close were therefore recorded as inspect. | Managed request adapter |
| F3 | The flat request schema makes action-specific fields optional; the parser requires `requestId` for create and `expectedEpisode` for apply/close. Current descriptions do not adequately expose these requirements. | Managed request contract |
| F4 | Managed result envelopes have no effective revision pair; the current-epoch evaluator excludes them from attribution and only recognizes create/continue as unassigned dispatches. | Managed producer and evaluator |
| F5 | `runner.ts` discards an otherwise collected native observation when episode timing is absent. A forcibly stopped child can miss the timing marker. | Native observation projection |
| F6 | Worker command recording and native collection restrict host tool-call IDs to the managed-identity character set. The two successful managed worker episodes had command rows but missing correlation IDs and partial command coverage. The recorded evidence proves the correlation gap, not the exact original provider ID spelling. | Worker command producer and collector |
| F7 | Both tools return child usage inside `details` or native observations, not top-level tool-result `usage`. Pi documents top-level `usage` as the nested-LLM accounting input to footer, `/session`, and RPC totals. The named runtime sample had no top-level usage on its 20 subagent results. | Extension adapter versus Pi accounting |

Stable truth owners are [Managed Subagent Execution](../../architecture/subagent-execution.md), [Subagents](../../architecture/subagents.md), and the [maintainer metric schema](../../../.agents/skills/evaluate-subagent-runs/references/metric-schema.md). Relevant code is under `extensions/subagents/`; Pi's documented accounting contract is `docs/extensions.md`, Custom Tools / Usage accounting, in the installed Pi distribution. Repository development Pi is 0.84.4 and the inspected installed documentation is 0.85.1; verification must cover both supported lanes without silently changing dependencies.

## Scope and non-goals

In scope: managed result presentation and request guidance; correct action/error attribution; bounded managed request and episode provenance; current-epoch managed dispatch evaluation; independent native observation coverage; bounded command correlation; compatibility tests; documentation of the existing accounting boundary.

Out of scope: automatic acceptance, automatic retry or continuation, repeated-inspect suppression, changing task timeout/concurrency/routes/providers, parent footer customization, forwarding child charges into Pi accounting, historical session rewriting, reading credentials, new diagnostic storage roots, changes to Herdr or other extensions, publishing, and installing or reloading the running user's extension. Timeout reduction and native accounting forwarding require separate scopes if later requested.

## Chosen boundary

| Option | Decision and cost |
| --- | --- |
| Keep the current contract; explain the warning | Rejected: preserves both misleading user output and incorrectly attributed failures. |
| Repair the existing adapters and add bounded versioned evidence | Selected: the extension already owns these observations and managed records; the evaluator already owns attribution and deduplication. This buys diagnosability without new control state. |
| Add an acceptance service, billing ledger, or background monitoring system | Rejected: shifts parent/Pi authority into the extension and adds durable operational cost unrelated to the observed defects. |

The maintainer owns compatibility and bounded optional evidence. Pi owns sessions, actual usage, and UI totals. The parent owns semantic decisions. The constrained resource is trustworthy evidence and operator attention, not measured scheduler capacity. A later native-accounting bridge is justified only by an explicit reporting requirement and an independently specified per-invocation accounting/deduplication contract.

## D1. Separate instructions, execution results, and analysis

Remove the acceptance phrase and the rendered `parentAcceptance` fields from newly generated managed content and both collapsed/expanded TUI results. Do not replace them with `pending acceptance`, `not accepted`, or another always-present semantic state. Do not inject acceptance custom entries, notifications, or context messages.

Keep a short static tool instruction that reports/candidates are evidence and the parent decides acceptance. Remove repetitive acceptance disclaimers from the ephemeral stored-session index; retain the operational distinction that idle means no running process and inspect does not launch a model. Do not change parent behavior by imposing a new inspect/approval protocol.

Display actual request action/status, bounded error code and field guidance, stored state, episode result, report completeness, and candidate/apply facts. The user's implementation addendum requires retaining the actual resolved provider/model/thinking in model JSON, collapsed/expanded TUI, and the stored index, including failures and historical replay; compactness must not strip these execution facts. Successful reports remain available to the model and expanded UI. Real failures, source drift, truncation, unknown request outcomes, and missing evidence needed for a requested diagnostic must remain visible. This is not a global ban on `null` or `unavailable` in machine-readable metrics.

The offline evaluator continues to keep `parentAccepted: null` without an explicit scoped parent disposition. That value describes missing analysis evidence, is not a runtime state, and must not be promoted into tool output or routine logs.

## D2. Make the action contract legible and truthful

Preserve the current accepted request shapes and the provider-compatible flat object schema using `StringEnum`. Do not switch to a top-level union that breaks Pi/provider schema compatibility. Put conditional requirements on the action and relevant property descriptions, with a compact complete create/continue/apply/close example in the tool guidance or description. No generated request IDs or inferred episode versions: these fields protect replay and compare-and-swap semantics.

Keep parser-side disjoint-field validation. When parsing fails, retain the raw action only if it is one of the five code-owned actions; otherwise use a null action in the new result envelope and render `Managed session request: failed`. Do not echo arbitrary action strings or other rejected input. Preserve existing stable error codes and add a bounded structured list of missing field names for the known action when applicable. A create missing `requestId` must render as create, and a close missing `expectedEpisode` as close. Both remain failed, with zero launches.

Produce managed result schema version two. New readers/renderers accept historical version-one results as evidence; new output omits acceptance presentation even when rendering a legacy result. Historical JSONL bytes remain untouched. Older extensions are not promised forward readability of v2 results or new managed records.

## D3. Distinguish each request from committed episode evidence

Version-two result details carry a bounded `requestTelemetry` record for each extension invocation, including parse/admission refusals and inspect/apply/close. It contains a schema version, native parent owner identity, an opaque fresh invocation identity, wall start, monotonic duration or null, the runtime extension epoch if observed, the configuration epoch only if this invocation actually resolved that configuration, nullable requested/admitted task counts for create/continue, actual launched-child count, and replayed-episode count. Non-execution actions have zero launches; unavailable widths are null, not fabricated empty batches. Never derive counts from prompt text or error prose.

Capture extension identity from the loaded runtime instance, not current source mtime. Observe configuration only through the existing trusted configuration path. Do not load routes/configuration merely to inspect, replay, or attribute a pre-trust/parse refusal. Such requests may have extension-only or unavailable provenance; they stay in explicit unassigned buckets for extension/configuration-pair selection. A cached old configuration snapshot must not be represented as freshly resolved for this invocation.

Each newly committed episode separately retains its effective execution revision pair and original start evidence in the existing bounded managed record/request result. This is immutable evidence about the execution, not the latest inspect or replay. Preserve it in returned session views. A mixed continue batch can contain replayed old episodes and fresh new episodes; each view retains its own origin.

A replay returns the committed result/candidate evidence in a fresh transport envelope with zero launches for replayed episodes. It must not load routes, refresh sources, run a model, mutate the original episode provenance, or charge historical usage as fresh work. Persist original committed evidence; do not append a durable request record for every inspect merely to support telemetry. The ordinary parent tool result is the transport record.

Extend the existing managed storage schema with an explicit versioned reader/writer transition. Read historical records and batch caches; missing historical provenance stays unavailable. Do not rewrite all records on read. New writes retain owner/branch/CAS/lock/size checks and preserve historical evidence. No bulk migration, TTL, automatic lock recovery, or new state root.

## D4. Evaluate managed dispatch without changing one-shot totals

Keep metric schema version four and the existing one-shot-only totals/roles/routes/runs. Add a bounded `managedDispatch` section with request counts by action/status, stable request errors, known launches/replay counts, and provenance selection coverage. Include failed requests and non-execution actions rather than deriving request counts from owned observation windows. Null action belongs to an invalid-request bucket, never inspect.

Exact-session mode may consume structured managed request details independently of completed parent observation windows. Current-epoch mode selects only requests with a matching extension/configuration pair and separately reports excluded and unassigned requests. An old episode returned by a current inspect/replay must not become a new current-epoch launch. Keep native `observations` independently scoped and owned; do not synthesize native timing/cost/acceptance from dispatch records.

Validate v2 invocation ownership against the physical parent header and deduplicate identical owner/invocation records; copied fork prefixes do not grant new invocations to the fork. Contradictory repeated records make the affected evidence unavailable rather than selecting whichever appeared first. These identities stay out of redacted metrics.

Historical v1 results remain readable. Their real structured action/status is available as recorded-result evidence, but missing request ownership/provenance/counts remain unavailable; do not claim unique owned invocations for legacy records. Do not repair historically mislabeled actions by reading assistant arguments or interpreting stable error codes. A metrics document produced before this additive section is interpreted as lacking managed dispatch evidence, not proving zero calls.

The current-epoch legacy source counters retain their existing scope/meaning; new managed coverage lives in `managedDispatch`, with its denominator documented explicitly. Keep all outputs redacted and bounded, including action/error groups, at most the existing per-report run limit, and complete aggregate counts even when per-request rows are clipped. Do not publish raw request IDs, handles, tool-call IDs, task text, paths, revision fingerprints, or native command text.

## D5. Preserve independently valid observation planes

Absence of an episode timing marker must not erase validated owned usage rows, command rows, or capability facts. Preserve the existing physical native reader checks: correct native owner and append range, bounded bytes/lines/entries, valid complete physical JSONL, and unchanged continuity/leaf rules. An unreadable or partial physical tail remains unavailable; this change must not silently accept a valid prefix of an invalid file.

Treat structural readability, owned recorded usage, timing endpoints, command coverage, and capability evidence independently. A missing timing marker produces unavailable timing, not zero reasoning or an invented terminal endpoint. A killed in-flight provider request may have unrecorded usage; any retained usage is explicitly scoped to validated owned recorded rows, not a complete provider bill for the episode. Evaluator coverage must distinguish available recorded rows from unavailable episode timing/command completeness, and complete totals must not be fabricated from incomplete evidence.

Outer task timeout/abort remains an execution failure. It does not synthesize a bash-command timeout row: only an actual command producer can assert that command outcome. Unknown commands, missing endpoint hashes, or unmatched command calls retain partial coverage. Required worker ready/stopped evidence, writer cleanup, freeze, and apply remain mandatory and unchanged. Optional metrics can never turn a failed or unsettled execution into a successful report/candidate.

## D6. Correlate commands without treating provider IDs as managed handles

Introduce a shared bounded correlation function for host tool-call IDs. Accept a nonempty host string up to 4 KiB UTF-8, then hash a domain-separated exact byte sequence to an opaque fixed-width key. Do not normalize case, split on provider delimiters, reuse managed-handle validation, or log the raw value. Missing/oversized IDs remain uncorrelated; do not guess.

Use a version-two worker command marker to distinguish the new correlation key from a historical raw ID. Mark newly normalized native observation projections with `commandCorrelationVersion: 2`; absence means the legacy raw-ID representation. Readers normalize both historical stored projections and newly collected markers before deduplication, so rereading an old cache and its native evidence cannot create a false conflict or a second charge. Normalize legacy supported raw IDs and new markers to the same internal correlation representation; do not double-hash a v2 key. Assistant bash calls and emitted command markers must use the same function. Existing native owner/entry and episode scoping remains authoritative. Reject contradictory, duplicate, malformed-version, or unmatched evidence as incomplete rather than silently selecting a convenient row. Legacy null IDs remain partial and are not retrospectively reconstructed.

No OS restriction, credential boundary, filesystem permission, or command execution behavior changes. Preserve fixed command/observation limits and the existing private retention policy.

## D7. Accounting boundary

Today, child usage does not automatically accumulate into the main Pi session's displayed total: the adapter supplies no top-level tool-result `usage`. Nested `details.usage` and evaluator `observations.usage.total` are not that API. The provider still accounts for actual child calls; a parent footer that omits them does not make those calls free.

Pi already provides a supported nested-usage API. This milestone documents the current behavior and protects the absence of accidental double accounting; it does not implement forwarding. A later bridge would need complete provider-shaped usage, fresh-episode deltas, replay/reload/fork behavior, unknown-usage handling, and separation from cumulative owned observations. Do not inject cumulative observation totals into parent assistant messages or customize the footer to simulate billing.

## Acceptance evidence

| ID | Executable evidence required before implementation completion |
| --- | --- |
| A1 | New model JSON and collapsed/expanded TUI contain no runtime acceptance field/phrase across success, parse error, episode failure, applied candidate, replay, and legacy-result rendering. Actual failure/report/candidate facts remain. |
| A2 | Service-level create/close missing-field fixtures retain their action and identify missing fields; malformed actions use null/request; every refused request launches zero children. Host tool registration exposes complete conditional requirements without breaking supported schema serialization. |
| A3 | Fresh create/continue, mixed replay/fresh continue, inspect, apply, close, pre-trust refusal, and parse refusal produce bounded truthful request evidence. Replay has zero new launches and immutable episode provenance across configuration change and restart. |
| A4 | Current-epoch fixtures separate matching, old, and missing pairs; v1 remains unavailable rather than inferred; parse refusals are not counted as inspect; one-shot totals are unchanged. Dispatch counts remain visible without a settled native parent window. |
| A5 | A readable owned native range without timing retains its known rows but unavailable timing; partial tails, wrong owners, copied prefixes, conflicting entries, and missing required lifecycle evidence still fail closed. Abort/timeout never creates a successful candidate. |
| A6 | Realistic pipe, colon, punctuation, Unicode, and long bounded host IDs correlate end-to-end; empty/oversized, duplicate, wrong-owner, legacy-null, and mixed marker versions remain conservatively classified. No raw host ID appears in new markers/evaluator output. |
| A7 | Synthetic-provider/native subprocess tests cover a successful command, outer timeout, continuation, inspect/replay, and source/candidate integrity on development and installed Pi lanes without paid inference. Command success is not asserted to mean test success or parent acceptance. |
| A8 | Fake-Pi tool adapter tests keep top-level native usage absent; owned native aggregation still counts parent/child rows once and excludes nested aggregates. Documentation explains Pi totals versus evaluator totals. |

## Recovery and truth impact

Use fix-forward for new managed-record compatibility. Removing/reloading the extension remains independently supported but is not authorized during this design task. A downgrade must not be promised to read new records; preserve required data rather than deleting or rewriting it to make an old extension start. If the implementation needs a destructive migration, wider state access, weaker ownership/CAS/lifecycle checks, or a new storage/usage authority, pause the affected slice for a new decision.

After verified implementation, update README, the subagent architecture owners, the maintainer skill/schema, and any affected root AGENTS boundary sentence. Do not edit unrelated extension instructions or historical artifacts. This design and its companion plan are stage artifacts, not current runtime truth.

## Review and approval

Independent design and plan review is required because result/storage compatibility and partial observation semantics can otherwise make invalid evidence appear authoritative. The parent adjudicates findings; a passed review does not approve implementation.

Review: the initial independent reviewers returned `child_model_error` without an evaluation. On the user's explicit one-retry authorization, both reviewers completed using the same configured route with no model or route changes. Design verdict: pass, no material findings; plan verdict: pass, no material findings. The parent accepted both evaluations against the current artifacts. These are document-review results, not implementation verification. Approval: the user explicitly approved implementation on 2026-09-09.
