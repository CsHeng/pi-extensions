+++
artifact_kind = "design"
design_version = 1
design_depth = "design-full"
approval_status = "approved"
approval_basis = "The user accepted the five observability, evaluation, planning, timing, and community-comparison recommendations and explicitly requested design-change followed by plan-change on 2026-09-04."
decision_state = "decided"
truth_impact = "high"
truth_sync_required = true
review_required = true
review_status = "passed_after_repair"
+++
# Subagent operator observability and current-epoch evaluation design

## Objective

Give one Pi operator a compact, independently removable view of active `csheng_subagents` work, a bounded way to inspect and cancel selected work while the foreground tool is running, and an authoritative current-effective-revision evaluation cohort. Also keep total reasoning duration and its wall-time share visible in every settled `work-timing` entry.

The selected boundary preserves the existing foreground, single-shot child model. The subagent runtime remains the authority for scheduling, process settlement, task outcome, diagnostics, and convergence. A new TUI-only `subagents-ui` extension projects bounded lifecycle snapshots and explicit cancellation receipts through Pi's shared event bus. It does not own execution state, write the working message, replace the footer, or create a durable task ledger.

Current-epoch evaluation uses runtime-generated opaque extension and configuration epochs rather than source mtimes or session creation times. The evaluator may scan a user-explicit sessions root only when current-epoch mode is explicitly selected. It filters individual runs, not whole sessions, and never falls back to mixed historical data when provenance is unavailable.

## Current truth and observed demand

- `extensions/subagents/protocol.ts`, `runner.ts`, and `scheduler.ts` already project child phase, assistant turn count, active tools, elapsed time, inactivity, errors, settlement, and process close into bounded `ChildActivity` snapshots.
- `extensions/subagents/index.ts` forwards those snapshots only through the active tool's `onUpdate` row and retains only `activeChildren` for `/subagents`. There is no cross-extension lifecycle contract, keyed TUI status, activity widget, overlay, or task-specific cancellation surface.
- The active run has one run-level `AbortController`. Escape and session shutdown can cancel the whole foreground call. Each executing task already creates an internal controller, but the scheduler exposes no task-cancellation contract and pending tasks cannot be cancelled individually.
- `work-timing` exclusively owns `ctx.ui.setWorkingMessage()`. Pi does not provide a keyed composition API for the working row. `session-id-footer` replaces the footer factory while preserving Pi's built-in `FooterComponent`, including keyed extension statuses.
- `work-timing` already persists `totalMs`, `reasoningMs`, and `lastTurnReasoningMs`. Its collapsed renderer shows only total wall time; reasoning is visible only after expansion.
- Runtime telemetry schema two records requested, admitted, launched, dependency, route-request, duration, and concurrency evidence, but no run start time, effective source/configuration revision, or effective configured concurrency.
- `$evaluate-subagent-runs` accepts one exact Pi session and emits metric schema two. It cannot identify a current installed/configured cohort or scan multiple explicitly authorized sessions.
- A conservative mtime-based exploratory cohort found 12 calls across 5 relevant sessions, with 8 succeeded and 4 failed calls and 24 requested, 17 admitted, and 16 launched tasks. This is useful demand evidence but not a valid durable cohort definition: mtime does not prove `/reload`, session creation does not identify run time, and an old session can execute a new call.
- Historical parallel batches show material elapsed-time benefit, while worker outcome alone cannot distinguish inherently serial work, correct write/resource serialization, conservative planning, parent retention, or runtime underuse.
- `plan-change` and `implement-change` already require factual dependencies, independent flat batches, exact write sets, locks, isolation, and parent-owned convergence. The accepted small clarification now requires every serial dependency between delegation-ready tasks to name its concrete predecessor artifact, shared resource, or parent-owned decision and states that narrative order is not a dependency.
- The community `nicobailon/pi-subagents` project demonstrates a compact Fleet view, event-driven status DTOs, explicit control receipts, and separate inspect/steer/stop semantics. Its missions, schedules, background execution, dynamic agents, workflow scripts, watchdogs, and broader orchestration ownership do not fit this repository's boundary.

## Design depth and architecture economics

This is `design-full` because the change adds an inter-extension protocol, a TUI extension, task-cancellation semantics, a private persisted provenance record, runtime telemetry schema three, multi-session evaluator behavior, and stable removal/privacy contracts.

| Option | Fit | Decision |
| --- | --- | --- |
| Keep tool-row-only progress and mtime-filtered ad hoc evaluation | No new runtime surface, but leaves active work hard to inspect and current health impossible to define authoritatively | Rejected |
| Let subagents also write `setWorkingMessage()` | Minimal UI code, but races with `work-timing` because the API has one unkeyed owner | Rejected |
| Merge timing, footer, and subagent UI into one extension | Can compose one visual surface, but couples independently removable behaviors and increases every future change's blast radius | Rejected |
| Add a bounded event protocol, TUI-only consumer, private current-epoch provenance, and explicit evaluator mode | Meets current operator and evaluation demand while preserving the foreground runtime and independent extensions | Selected |
| Adopt or embed community `pi-subagents` | Supplies richer control and orchestration, but replaces fixed roles and bounded foreground mechanics with a much broader lifecycle and dependency surface | Rejected |
| Move children in-process now | Could simplify live control, but weakens the proven subprocess capability boundary and is unnecessary for status and cancellation | Deferred |

The scarce resources are operator attention, trustworthy evaluation evidence, and the review capacity needed to protect cancellation, privacy, and persisted-state boundaries. The smallest sufficient investment is a bounded projection and control protocol plus a constant-size provenance record. A larger agent runtime would displace reliability work without solving a current requirement that cannot be met inside the existing process architecture.

Reconsider in-process children or bidirectional child steering only after an explicit steer requirement and evidence that a bounded subprocess control channel cannot satisfy it. Reconsider a shared working-row compositor only after at least two independently useful producers need simultaneous text on that exact row and keyed status/widget surfaces prove insufficient.

## Requirements

### SOE-1 — One authoritative activity projection

The subagent runtime emits a versioned, bounded full snapshot whenever run/task state changes and on the existing five-second heartbeat. The snapshot contains no prompt, objective, child output, stderr, model selector, repository path, external root, diagnostic path, or tool arguments.

### SOE-2 — Independently removable TUI consumer

`subagents-ui` listens through `pi.events`, validates every event, and remains inert outside TUI mode. Removing it changes no subagent execution, result, diagnostics, telemetry, route, or cancellation behavior. Removing the core subagent extension leaves the UI extension inert and safe.

### SOE-3 — Non-conflicting Pi surfaces

`work-timing` remains the sole owner of `setWorkingMessage()`. `session-id-footer` remains the sole footer factory owner. `subagents-ui` uses only keyed `setStatus`, a bounded `belowEditor` widget, a custom overlay, a shortcut, and its own custom entry renderer.

### SOE-4 — Durable completion projection without a second ledger

Each settled run may append one context-free TUI custom entry containing only run status, requested/admitted/launched/settled counts, aggregate child assistant turns, elapsed time, peak concurrency, and whether a cancellation was requested. The structured subagent tool result remains authoritative; the custom entry is a display projection and stores no graph, task output, path, model, prompt, or continuation state.

### SOE-5 — Live inspection while the foreground tool is active

`Ctrl+Alt+F` opens the current subagent inspector without relying on a queued slash command. `/subagents-ui` opens the same inspector when command input is available. The overlay shows at most ten admitted tasks and bounded role, status, phase, turns, elapsed, inactivity, active-tool names, and error-count evidence. It is not a child terminal and cannot display or inject transcript content.

### SOE-6 — Active TUI capability gate

Before any production implementation edit, a disposable no-network Pi 0.84.4 TUI probe must prove that a registered shortcut fires and a custom overlay opens and rerenders while a deterministic fake-provider tool call is blocked. The probe uses a disposable agent directory and no credential or live provider. Failure returns `needs_design_decision`; implementation must not fall back to the queued slash command, the working row, a background controller, or Pi internals.

### SOE-7 — Explicit bounded cancellation

The inspector can request cancellation of the current run or one pending/running task only after explicit user confirmation. Every request carries the current run ID, target, and a request ID. The core returns a bounded receipt such as `accepted`, `not-active`, `unknown-task`, `already-settled`, or `too-late`; acceptance means the cancellation signal was accepted, not that process settlement or cleanup is complete.

A run cancellation always returns `accepted` for the current active run, stops new scheduling, aborts every cancellable pending/running task through the existing controller paths, and waits for all cleanup. A worker already inside convergence is allowed to finish that non-interruptible critical section while unrelated cancellable branches stop; the run-level request is not rejected merely because one task is converging. A task-targeted cancellation marks a pending task aborted without launch or aborts only that running task's controller; dependents become blocked and unrelated branches continue. Only a task-targeted request against convergence returns `too-late`. No cancellation rolls back already succeeded or converged siblings, and every started-child diagnostic is preserved.

The aggregate run keeps current compatibility semantics: any task that ends aborted makes the run `aborted`, even when unrelated tasks succeeded. A run-level cancellation request also keeps the aggregate aborted after any converging critical section settles. The final tool result, not the receipt, proves outcome.

### SOE-8 — No steering or continuation

The event protocol accepts no text, prompt, follow-up message, model change, retry, resume, or continuation action. Child stdin remains ignored. Interactive steer, attach, and session continuation require a separate approved design; Herdr remains the existing persistent-agent boundary.

### SOE-9 — Current effective revision epochs

At extension load, the core fingerprints the sorted names and bytes of its shipped runtime source files under `extensions/subagents/`. It registers or reuses an opaque extension epoch in a constant-size private provenance manifest. Source edits do not become a new effective epoch until a new extension instance loads them.

Each configuration observation fingerprints the exact packaged baseline plus the optional user override presence and bytes before parsing. A changed source fingerprint receives a fresh opaque configuration epoch, including transitions back to previously seen bytes. The same observed fingerprint reuses the current epoch across Pi sessions. This identifies effective transitions rather than relying on mtime.

The provenance manifest lives under an extension-owned private directory beneath `getAgentDir()`, is a regular mode-0600 file beneath mode-0700 ancestors, and is replaced atomically under a bounded cross-process lock. It stores only its schema version, private source fingerprints, opaque epoch IDs, and activation timestamps. It stores no raw configuration, route, credential, prompt, task, repository, session, or model output. It retains only the current pair and is not orchestration or resume state.

The lock is an exclusive mode-0700 directory containing a mode-0600 random owner token and acquisition timestamp. A writer waits at most two seconds. A lock older than thirty seconds may be atomically renamed to a token-qualified quarantine before reacquisition; the displaced owner must compare its token immediately before manifest replacement and discard its temporary file if ownership changed. A writer removes only a lock whose token still matches. Recovery removes at most eight stale token-qualified temporary or quarantine entries per observation, never follows symlinks, and treats any unsafe ownership, type, or mode as provenance unavailable.

Each loaded core caches its assigned extension epoch and last observed configuration fingerprint/epoch. If the manifest later names another extension epoch, the superseded core never changes the manifest. It may reuse its cached configuration epoch only while the configuration fingerprint remains unchanged; after a configuration transition it records provenance unavailable rather than inventing a process-local epoch or replacing the current pair.

An unsafe, corrupt, contended, or unavailable provenance store does not block subagent execution. The run records provenance as unavailable, `/subagents` reports that evaluation provenance is unavailable, and current-epoch evaluation fails closed rather than widening its cohort.

### SOE-10 — Runtime telemetry schema three

Every call emits runtime telemetry schema three while retaining all schema-two meanings. Schema three adds:

- run start wall-clock time;
- provenance availability plus opaque extension and configuration epoch IDs when available;
- effective global and per-role concurrency caps when route configuration was valid.

Pre-admission and invalid-route failures preserve requested counts and current provenance when it was observable. No raw fingerprint, file timestamp, source path, route-file content, repository path, session path, task ID, or prompt enters telemetry.

### SOE-11 — Explicit current-epoch multi-session evaluation

The evaluator retains exact-session mode. It adds a separate mode requiring an explicit sessions root and the exact extension-owned provenance manifest. This mode scans regular Pi parent-session JSONL only, selects individual schema-three runs whose epoch pair matches the manifest and whose run start is not earlier than the later activation timestamp, and applies that cohort to every aggregate metric, not only errors.

Session file mtime may narrow candidate IO but is never cohort authority. Old sessions containing matching new calls are included; new session files containing old or unavailable runs are excluded. If there are no matching calls, the report returns authoritative zero totals. If current provenance is unavailable, scan bounds are exceeded, or the manifest is unsafe, the command fails without emitting a partial report or falling back to historical runs.

Metric schema three reports selection mode, scanned/matched session counts, matched/excluded/unavailable run counts, telemetry modes, effective-cap evidence, and the existing redacted aggregates. It does not emit manifest fingerprints, epoch IDs, activation paths, session paths, task IDs, or excluded-run details. Runtime telemetry versions one and two remain evaluable only in exact-session mode and remain provenance-unavailable.

The current-epoch scanner is streaming and uses these hard limits; crossing any limit fails the whole report without partial output:

| Resource | Hard limit and counting rule |
| --- | --- |
| Traversal depth | Eight directory levels below the explicit sessions root; the root is level zero |
| Directory entries | 20,000 total files, directories, and symlinks encountered |
| Candidate session files | 4,096 regular `.jsonl` files after any safe mtime prefilter |
| Per-session bytes | 64 MiB from `lstat` before streaming |
| Aggregate input bytes | 1 GiB across candidate session files |
| JSONL line bytes | 1 MiB before parse |
| Matching plus excluded tool runs | 100,000 parsed `csheng_subagents` results |
| Detailed output runs | First 1,000 selected runs; totals still cover every selected run within the parsed-run ceiling |
| Aggregate route keys | 256 distinct safe route keys |
| Aggregate error keys | 256 distinct stable error codes |
| Encoded report | 4 MiB before stdout or exclusive mode-0600 output-file write |

The scanner rejects symlink roots, directories, and files, ambiguous input modes, malformed JSONL, and output overwrite. Session mtime can only remove a file whose last modification predates both current activation timestamps; epoch IDs and run start remain selection authority. The Skill never scans a default sessions root silently: the user must explicitly name or authorize the root for multi-session evaluation.

### SOE-12 — Honest worker and plan interpretation

Runtime evaluation may compare requested/admitted/launched worker counts, hard edges, peak concurrency, and effective caps. It must not label a plan conservative, a worker omitted, or runtime capacity underused without an explicitly supplied approved-plan ready set and dependency rationale. When that evidence is absent, plan eligibility remains `unavailable`.

The accepted `plan-change` clarification improves human-reviewable causal plans but does not turn Skills into a runtime graph or authorize the evaluator to read arbitrary plan files. Automated parent-declared plan evidence is a future contract, not part of this milestone.

### SOE-13 — Reasoning duration and share remain visible

Every settled `work-timing` entry renders total wall time, total parent-session reasoning time, and the rounded reasoning share in collapsed and expanded states. Expanded rendering additionally shows last-turn reasoning. The percentage is derived at render time from existing version-one entry data; zero total renders an unavailable share, and display is bounded to a valid wall-time percentage without rewriting the stored reasoning duration.

This changes no live working-row text, timing event semantics, persisted entry schema, or headless behavior. It does not claim child reasoning or infer reasoning from tokens.

## Selected architecture

### Lifecycle snapshot protocol

A small shared module owns three event names and exact version-one DTOs:

- `csheng.subagents.snapshot.v1` for full current-state snapshots;
- `csheng.subagents.cancel.request.v1` for explicit UI control requests;
- `csheng.subagents.cancel.receipt.v1` for acknowledgements.

A snapshot contains one run ID, run phase, counts, aggregate turns, elapsed time, cancellation-requested state, and at most ten task projections. Full snapshots are selected over deltas because the hard task limit is ten, consumers can recover from a missed event without replay, and no event log is needed. The producer emits after initial acceptance, scheduler updates, heartbeat, cancellation receipt-affecting state, and final aggregation.

The event bus is a trusted in-process extension composition seam, not an authentication boundary. The core still validates version, current run ID, target existence, and target phase for every control request. Unknown or malformed events cannot mutate a run.

### TUI state ownership

`subagents-ui` captures a TUI `ExtensionContext` at session start, keeps only the latest validated active snapshot and pending receipt in memory, and clears all UI state on final settlement, session switch, reload, or shutdown. It renders:

- keyed footer status `csheng.subagents.status`: compact active/total, turns, and elapsed summary;
- keyed `belowEditor` widget `csheng.subagents.panel`: a bounded active-task summary with overflow count;
- `/subagents-ui` and `Ctrl+Alt+F`: live overlay with selection, scrolling, receipt display, and confirmed cancellation actions;
- custom entry type `csheng-subagents-run`: one bounded settled summary.

The widget disappears when no run is active. The keyed status clears rather than retaining a permanent idle label. Overlay rerenders are driven by accepted snapshots; it owns no polling timer because the core heartbeat already advances elapsed and inactivity.

### Cancellation state and critical sections

The scheduler gains a run-local control interface rather than exposing its internal maps. It can classify and cancel a pending task before launch. `index.ts` retains per-task controllers and execution phases for running work. The phase contract distinguishes queued, workspace preparation, child execution, convergence critical section, and settled state without exposing workspace paths.

One run-local synchronous control record linearizes each cancellation decision with execution-phase transitions. Entering convergence atomically changes the task phase before any convergence await or filesystem apply. A task cancellation that wins first latches cancellation and prevents convergence; a convergence transition that wins first makes a task-targeted cancellation `too-late`. Run cancellation always latches the run as aborted and stops other cancellable work, but never aborts a task after that task has entered convergence. There is no asynchronous gap between checking and changing the phase/control state.

Cancellation during workspace preparation latches a request, prevents child launch, and cleans the workspace. Cancellation during child execution aborts the task controller. Cancellation during convergence returns `too-late`; convergence completes under existing CAS and atomic-apply rules. Receipts are emitted immediately, while the lifecycle snapshot and final tool result later show the authoritative transition.

### Provenance ownership

A dedicated provenance module owns source fingerprinting, manifest validation, private atomic replacement, locking, transition detection, and injected filesystem/clock/random seams. Configuration loading supplies the exact source snapshot used by that run so provenance and route behavior cannot describe different file reads. The runtime receives only opaque epochs; the evaluator receives only the safe current selection after validating the manifest and never renders private fingerprints.

The extension epoch is fixed for the lifetime of one loaded core instance. The configuration epoch is observed for each parent start/dispatch and can change within a long-lived Pi session. An older loaded core keeps its original extension epoch and cannot overwrite the manifest's newer extension activation merely because it later runs. If that superseded core observes a configuration transition, the affected run is provenance-unavailable; unchanged cached configuration evidence remains usable only for exact-session attribution. Manifest updates and stale-lock recovery use the token protocol above with injected clock/random/filesystem seams.

### Evaluator modes

Exact-session mode preserves current intent and old telemetry support. Current-epoch mode is a separate CLI shape and output selection mode. The implementation first parses bounded run records, then aggregates only selected records so errors, success denominators, roles, routes, usage, cost, duration, worker evidence, and concurrency all describe the same cohort.

The Skill's default interpretation becomes:

- an explicitly named session means exact-session evaluation;
- a request for current installed/configured health or all current calls means explicit-root current-epoch evaluation;
- no explicit session or sessions-root authority means stop and ask, not discover broadly.

### Community design intake

The design borrows ideas, not source code or a runtime dependency, from the community Fleet/status/control model reviewed on 2026-09-04. The useful patterns are compact-plus-detail UI, event-driven snapshots, stable control receipts, and the distinction between accepted control and proven settlement. No MIT-licensed code is copied, so no new notice or dependency is required.

Missions, background jobs, schedules, workflow scripts, dynamic agents, watchdogs, automatic acceptance loops, nested delegation, and persisted resumable run artifacts remain rejected because they would create a second lifecycle engine.

## Ownership and dependency direction

| Owner | Owns | Does not own |
| --- | --- | --- |
| Pi | Event bus, keyed status, widget/overlay/shortcut hosting, custom-entry persistence, parent loop, tool signal, and session JSONL | Subagent state meaning, cancellation eligibility, provenance epochs, or evaluator cohort policy |
| Core `subagents` extension | Authoritative active snapshot, event production, control validation, task/run cancellation, final results, telemetry v3, and provenance observation | TUI layout, working-row composition, plan semantics, steering, or final verification judgment |
| `subagents-ui` | Validated in-memory projection, TUI surfaces, explicit confirmation, control requests, receipts, and settled display entries | Scheduler state, child process ownership, route/config decisions, diagnostics, or final outcome |
| `work-timing` | Parent interaction wall/reasoning timing, working row, and timing completion entry | Child activity, subagent UI, or child reasoning |
| Evaluator Skill and script | Explicit input authorization, epoch filtering, redacted aggregation, unavailable evidence, and output bounds | Runtime mutation, configuration reads, plan parsing, semantic blame, retries, or route changes |
| Parent agent and Skills | Task decomposition, factual dependency rationale, delegation choice, synthesis, verification, review adjudication, repair, and final response | Physical scheduling, capability enforcement, or automatic telemetry truth |
| User | Approval, provider cost, active cancellation, explicit evaluation roots, retained generated provenance/diagnostics, and deletion | Automatic completion claims or hidden background control |

Dependencies point from `subagents-ui` to the shared event DTO and Pi APIs, never to runtime implementation state. The core and `work-timing` do not import or call one another. The evaluator consumes persisted parent telemetry and the exact generated provenance manifest read-only; it never imports the active runtime or configuration loader.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| UI extension absent or disabled | Core execution and telemetry continue unchanged |
| Core absent or disabled | UI remains inert and clears its keyed surfaces |
| Malformed/unknown snapshot | UI ignores it without throwing or retaining partial state |
| Malformed/stale cancellation request | Core returns a negative receipt and changes no task |
| Accepted task cancellation | Signal/latch only; final result waits for process/workspace settlement |
| Task cancellation during convergence | Return `too-late`; convergence completes without interruption or rollback |
| Run cancellation while a worker converges | Accept the run request, stop every cancellable branch, allow the critical section to settle, then return the authoritative aborted aggregate |
| Overlay closes or TUI shuts down | Close UI and clear keyed surfaces; do not cancel unless the user explicitly confirmed it |
| Provenance writer crashes or loses its lease | A later observer quarantines the stale lock; the displaced writer fails its token check and cannot replace the manifest |
| Provenance path unsafe, corrupt, locked, or unavailable | Run continues with unavailable provenance; current-epoch evaluator fails closed |
| Telemetry v1/v2 in current-epoch scan | Exclude as provenance-unavailable; do not infer from mtime or prose |
| Multi-session scan exceeds a bound or finds malformed input | Fail without partial metrics or output overwrite |
| `totalMs` is zero or entry data is invalid | Normalize existing durations and render the reasoning share as unavailable |
| Pi cannot deliver live shortcuts/overlays during an active tool | Return `needs_design_decision`; do not move status into the working row or add a background controller silently |

## Explicit non-goals and future phases

Out of scope:

- child steer, follow-up messages, attach, resume, continuation, or stdin control;
- background tasks, missions, schedules, workflow scripts, dynamic roles, nested delegation, automatic retries, watchdogs, or acceptance loops;
- replacing subprocess children with in-process Pi sessions;
- importing, vendoring, or depending on community `pi-subagents`;
- a generic UI compositor or any second writer to `setWorkingMessage()` or `setFooter()`;
- persisting active UI state, cancellation queues, scheduler topology, locks, workspaces, or resumable run state;
- automatic plan parsing, task-ID retention in evaluator output, semantic plan blame, or a Skill-owned task graph;
- reading Pi settings, credentials, route files, child diagnostics, prompts, or external files during evaluation;
- provider calls, package installation, global settings changes, commit, push, publication, or deployment.

A future parent-declared plan-evidence contract requires separate design once representative plans show that manual ready-set comparison is too costly. A future steer design must preserve capability limits, acknowledgement semantics, bounded queues, process cleanup, and parent authority; it may select bidirectional IPC or in-process children only after comparing those boundaries.

## Oracle strategy and acceptance evidence

Use event-contract examples, scheduler state-transition tests, fake extension contexts, deterministic TUI components, disposable private provenance directories, concurrent manifest fixtures, streaming multi-session JSONL fixtures, redaction negatives, and existing package probes. No provider call is required.

Acceptance requires:

- every active core run emits bounded full snapshots with correct requested/admitted/launched/active/settled counts, aggregate turns, elapsed time, and task phases before final close;
- snapshots, receipts, custom entries, status, widget, overlay, telemetry, evaluator output, and probes contain none of the prohibited prompt/content/path/model fields;
- `subagents-ui` is inert in RPC/JSON/print modes, does not call `setWorkingMessage` or `setFooter`, and clears status/widget/overlay state on settlement and shutdown;
- the built-in footer preserved by `session-id-footer` still displays keyed subagent status;
- the disposable no-network Pi 0.84.4 gate proves `Ctrl+Alt+F` can open and rerender the inspector during an active blocked fake-provider tool call before any production implementation edit, while `/subagents-ui` reaches the same view when idle input is available;
- pending and running task cancellation, whole-run cancellation, dependency blocking, unrelated-branch continuation, stale targets, repeated requests, workspace cleanup, child termination, and the child-execution/convergence race have deterministic state-transition evidence: task cancellation either wins before convergence and prevents it or loses after atomic entry and returns `too-late`, while run cancellation always remains accepted and never interrupts the critical section;
- cancellation receipts never claim settlement and final run/task status remains in the ordinary tool result;
- extension/configuration content transitions create fresh opaque epochs, unchanged observations reuse them across processes, changed-back observed content creates another epoch, old loaded cores retain their old extension epoch, and a superseded core changing configuration becomes provenance-unavailable without overwriting current state;
- provenance lock contention, writer crash, stale-lock quarantine, displaced-owner token rejection, bounded stale cleanup, and unsafe/corrupt paths are covered; provenance files remain constant-size, private, atomic, non-symlinked, and contain no raw source/configuration bytes;
- every schema-three run carries start time and provenance availability, retains all schema-two counters, and records effective caps only from the configuration actually used;
- exact-session evaluation retains schema-one/two compatibility, while current-epoch mode requires explicit root/manifest authority and aggregates only matching schema-three runs across old and new session files;
- zero-match current cohorts return zero, unavailable provenance and scan-limit cases fail closed, output remains non-overwriting mode 0600, and no path, fingerprint, epoch ID, task ID, prompt, selector, or excluded-run detail is emitted;
- evaluator plan eligibility remains unavailable without approved structured evidence and no metric labels plan or runtime semantics from worker count alone;
- collapsed timing entries show total wall time, reasoning duration, and rounded bounded share; expanded entries add last-turn reasoning; historical version-one and zero-total fixtures remain readable;
- package registration, independent removal, TypeScript checks, deterministic tests, required offline probes, Markdown boundaries, and `git diff --check` pass.

The selected executable oracle mix is contract tests for DTO/schema compatibility, model/state-transition tests for cancellation and scheduling, filesystem component tests for provenance, streaming integration tests for cohort selection, fake-TUI component tests for surface ownership, and existing deterministic package integration checks. Golden transcript or prose snapshots are rejected because they would freeze presentation rather than behavior.

## Truth impact and implementation surface

Verified implementation must update:

- `AGENTS.md` for the eighth independently removable extension, event/control boundary, provenance state, telemetry/evaluator current-epoch behavior, and unchanged no-steer lifecycle;
- `README.md` for package inventory, subagent status/inspection/cancellation UX, current-epoch evaluation, and collapsed work-timing summary;
- `docs/architecture/subagents.md` for lifecycle events, cancellation, provenance, telemetry schema three, evaluator modes, privacy, failure, and removal behavior;
- a new `docs/architecture/subagents-ui.md` for TUI-only ownership, event DTO consumption, custom entry, shortcut/overlay, cancellation requests, and independent removal;
- the evaluator Skill, metric reference, script, and tests for the approved read-only manifest exception and explicit multi-session mode;
- package extension registration and deterministic package tests.

Expected new or changed runtime surfaces include:

- a shared bounded subagent event/control contract under `extensions/subagents/`;
- scheduler and entrypoint control integration;
- a provenance module and configuration-source snapshot seam;
- `extensions/subagents-ui/` and its tests;
- `extensions/work-timing/index.ts` and `tests/work-timing.test.ts`;
- telemetry/evaluator contracts and fixtures.

The completed one-sentence `plan-change` clarification exists in the separate `agent-skills` repository's authored and generated `plan-change/SKILL.md`. It is verified by that repository's full generation/check workflow and is not a writable dependency of the future `pi-extensions` implementation plan.

## Recovery and removal

Use fix-forward recovery. Event/UI failures are repaired in their producer or consumer without changing scheduler truth. Cancellation failures retain the smallest state-transition fixture and never recover by killing unrelated tasks, interrupting convergence, or reporting settlement early. Provenance/evaluator failures retain bounded synthetic manifests and sessions and never recover by reading configuration directly, using mtime as authority, widening the epoch, or returning partial current-health metrics.

Removing `subagents-ui` removes its status, widget, overlay, shortcut, and custom-entry renderer without changing `csheng_subagents`. Existing custom entries remain harmless session data and render generically when the renderer is absent. Removing core subagents stops new events, control handling, epochs, telemetry, children, and diagnostic retention; it does not delete existing diagnostics or the tiny provenance manifest. Removing `work-timing` remains independent and does not affect subagent UI.

Telemetry schemas one and two remain readable in exact-session evaluation, so no migration or rollback rewrite is required. Runtime schema three is a hard cutover for new runs. A guarded rollback is not planned because no external system, deployment, or mutable repository data is changed; if Pi's public event, shortcut, custom UI, or session contracts cannot support the selected behavior, stop with `needs_design_decision`.

## Review decision

A bounded independent design review was required because the design introduces a persisted provenance boundary, runtime telemetry schema three, cross-extension events, live task cancellation, and multi-session scanning. The reviewer returned `needs revision before implementation planning` with five material candidates. Parent adjudication accepted all five and applied one focused artifact repair, including the rechecked terminal-safe `Ctrl+Alt+F` inspector binding:

- run-level cancellation now remains accepted when one worker is already converging, stops only cancellable branches, waits for the critical section, and distinguishes task-level `too-late`;
- a superseded loaded core now reuses only unchanged cached configuration evidence and becomes provenance-unavailable after a configuration transition rather than overwriting the current pair;
- the multi-session scanner now has exact traversal, file, byte, line, run, aggregate-key, and output ceilings with fail-closed counting semantics;
- provenance locking now has a token-checked thirty-second stale lease, atomic quarantine, bounded cleanup, and displaced-writer protection;
- a disposable no-network Pi 0.84.4 active-tool shortcut/overlay probe is now a mandatory stop-gate before production implementation edits.

A subsequent bounded plan review found that the child-execution-to-convergence transition lacked an explicit linearization point. Parent adjudication accepted that causal clarification: one synchronous run-local control record now orders task/run cancellation against atomic convergence entry, with deterministic race evidence required. This preserves rather than changes the approved cancellation outcome.

Rechecking scope, ownership, control semantics, provenance races, evaluator authorization, boundedness, compatibility, recovery, and downstream planning readiness yields `pass`. No material design finding remains; `review_status = passed_after_repair`.

## Approval

`approval_status = approved` and `decision_state = decided`. The user approved the five recommendations and explicitly requested design and planning. This approval authorizes creation and review of design/plan artifacts only. It does not authorize implementation in `pi-extensions`, provider calls, package installation, user-state mutation outside disposable verification fixtures, commit, push, publication, or deployment.
