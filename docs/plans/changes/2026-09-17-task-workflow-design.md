# Task Workflow Design

Date: 2026-09-17

Status: approved 2026-09-17; E1 source implementation (WF-01..WF-08) authorized. Subsequent user approval authorizes source commit/push and local snapshot publication; restart and trial remain user-owned, and AC-10 is unverified. Independent read-only review passed. The later user clarification and implementation approval in session `01a0acfc-af3f-74eb-abbe-1ac0341f1932` defines effective input as new messages actually prepared for the model, not received/queued drafts. The current continuation request carries that E1 scope forward. This is a design-full stage artifact, not a description of installed behavior.

Companion: [implementation plan](2026-09-17-task-workflow-plan.md).

## Objective and settled direction

Build an owned task-level workflow extension for long engineering work. The main agent translates a plan or ordinary user intent into structured tasks and acceptance obligations; TypeScript maintains their state, dependencies, revisions, evidence bindings, and continuation bookkeeping. At new input and normal settlement, the runtime makes unresolved obligations visible to the main agent instead of treating its last response as task completion.

`todolist` is an optional presentation of workflow state, analogous to `subagents-ui` over `subagents`. It is not the workflow's data model, completion policy, scheduler, or required dependency. Co-location and strong coupling inside one extension are acceptable when they simplify maintenance. Disabling the presentation must leave every workflow operation available through the tool.

The following directions were settled in the preceding discussion and are covered by the E1 approval:

- Own a task-level workflow rather than keep `rpiv-todo` as the controlling ledger or build only a thin adapter.
- Keep one authoritative task state. Reuse the existing managed subagent executor, not a second child runner.
- Let the main agent interpret intent, choose cohesive slices, adjudicate evidence, and decide repair. Do not introduce an independent intent-analysis model.
- Accept plans of different shapes and direct natural-language requests. Do not require `plan.md`, a fixed Skill sequence, or a user-authored machine schema.
- Support amendment, splitting, merging, replacement, suspension, cancellation, and retirement, not just append-only tasks.
- Keep the external `agent-skills` repository portable and separately owned. The extension does not discover or execute Skills itself.
- Reduce managed-session per-request tail interference without weakening inspect, replay, ownership, candidate, or apply checks.
- Keep `plan-mode` removal in its [existing deferred follow-up](../../open-questions.md). It is neither reconsidered here nor a prerequisite.

## Current truth and limits of evidence

The design-time inspected host was Pi 0.85.1 with development pins at 0.84.4; the implemented and tested development baseline is now 0.85.1. The [official extension API](https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/extensions.md) and [agent-session implementation](https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts) establish the lifecycle facts below. Installed-host evidence is recorded in the [E1 report](../../evaluations/2026-09-17-task-workflow-e1-report.md). The table retains the design-time observations that motivated the change.

| Boundary | Current behavior | Consequence |
| --- | --- | --- |
| Pi loop | Pi owns provider turns, tools, queues, retries, compaction, sessions, and cancellation. | Workflow may request another main-agent interaction, not replace that loop. |
| Settlement | `agent_settled` follows automatic retry/compaction/queued continuation. It has no stop-veto return value. | The extension can refuse logical task closure, not erase a final response or make host settlement impossible. |
| Re-entry | Idle `sendMessage(..., { triggerTurn: true })` enters the internal agent prompt directly; it does not run ordinary `before_agent_start`. | A two-line settled follow-up is not an adequate implementation. |
| Input | `input` distinguishes interactive, RPC, and extension sources. Streaming steering/follow-up queues return before ordinary `before_agent_start`. Extension commands run before `input`. | Alignment cannot rely solely on `before_agent_start` or classify every user-role message as human intent. |
| Persistence | Pi supports non-model custom entries and a branch-aware session tree. | The initial ledger can use Pi-owned session files without a second project state file. |
| Managed children | [Managed execution](../../architecture/subagent-execution.md) owns physical execution and candidates; parent acceptance is separate. Hard edges pass reports, not candidate files. | Workflow readiness and semantic acceptance belong above that executor. |
| Existing context | [Managed context](../../../extensions/subagents/context.ts) appends an ephemeral custom index to each provider context. Pi converts custom messages to user-role model messages. | Its position and instructional wording can compete with the current objective even though it does not accumulate indefinitely. |
| Timing and child exit | `work-timing` initializes on `before_agent_start` and finalizes on settlement. Worker tools shut down on settlement. | Parent continuation must preserve timing and must never start a child workflow loop. |

A bounded seven-day audit found 13 premature closeouts in eight long implementation sessions; 11 had unfinished todos, one had no todo, and one had completed todos despite missing delivery. Several closeouts repeated managed-session index concerns. This supports investigating both model behavior and harness obligations, not a causal claim that the index caused the stops or a model failure-rate ranking. No provider A/B experiment established the proposed workflow's benefit.

## Architecture decision

| Option | Benefit | Cost or decisive limitation | Decision |
| --- | --- | --- | --- |
| Keep current Skills and todo, add a reminder | Smallest code change. | No acceptance coverage, revision invalidation, or single task/evidence contract; completed checkboxes can still hide incomplete delivery. | Insufficient for the agreed objective. |
| Owned workflow in one extension, existing subagents underneath | Direct ownership of the needed invariants; no external runtime or duplicated execution backend. | New state machine and host lifecycle adapter need substantial offline verification. | Selected minimum sufficient boundary. |
| Adopt `rpiv-workflow` runtime | Existing structured plan projection, artifact contracts, recovery, and bounded loops. | Its detached session host and lifecycle policies do not directly match private sources, explicit candidates/apply, or portable Skills. Adapting it would introduce another execution/state contract. | Borrow concepts, not a runtime dependency in this milestone. |
| General multi-host workflow platform and separate UI package | Broader reuse and independent deployment. | Interfaces, migrations, and lifecycle ownership exceed the demonstrated need. | Defer until a real second consumer requires them. |

Implementation archetype: in-process Pi extension. Implementation language: TypeScript. Rationale: Pi's extension API, this package, and its deterministic test harness already own that boundary. Existing Bash remains probe glue only; no new daemon, service, database, or package framework is introduced.

The initial source owner is `extensions/workflow/`. Keep the reducer/contracts independent of Pi event objects, with small concrete adapters for session persistence, evidence observations, and hooks. UI can be a module in the same directory and consume the same reducer projections. These are test seams, not a requirement for a plugin architecture or an interface for every helper.

The initial unit of ownership is one active workset per Pi session branch and current repository. A workset is one goal with acceptance obligations, tasks, attempts, and dispositions. Separate repositories keep separate writable execution slices; this milestone does not create a cross-repository scheduler or a global mission store.

## Responsibility and authority

| Owner | Owns | Does not own |
| --- | --- | --- |
| User | Goals, changes of scope, permissions, cancellation, and approval-sensitive delivery. | Mechanical task IDs or hashes. |
| Main agent and portable Skills | Intent normalization, task boundaries, required acceptance, evidence interpretation, delegation choices, repair, review adjudication, and final acceptance. | Editing the ledger by hand or manufacturing transport outcomes. |
| Workflow code | Schemas, identity, revisions, DAG validity/readiness, transitions, evidence bindings, drift checks, persistence, reminder leases, and bounded check obligations. | Deciding whether an implementation is actually correct or granting authority. |
| Managed subagents | Existing role/route selection, child execution, isolation conventions, explicit candidates/apply, replay, and close. | Workflow task acceptance or automatic successor approval. |
| Pi | The actual agent loop, provider interaction, native history, queues, compaction, and cancellation. | This extension's task semantics. |
| Optional task UI | A read-only projection and user controls that call the same workflow operations. | A second ledger, separate task transitions, or exclusive completion authority. |

Authority references point to actual user instructions or trusted task-scoped project policy and describe the covered action and limits. A task, plan, Skill, tool result, review verdict, or stored reference is not permission by itself. The agent must interpret whether authority covers an action; code can require a reference and preserve its provenance, but cannot prove that semantic judgment. Ordinary read-only inspection, answering, and user cancellation remain available while alignment is pending.

The extension is dormant without an enrolled workset. Enrollment is an explicit tool operation by the main agent for ongoing authorized work; it is not inferred from every question or from the presence of a Skill. No fixed phase graph is imposed on research, design, implementation, review, or delivery.

## Task contract

### Model-facing normalization

Expose one namespaced tool, provisionally `csheng_workflow`. The normalized opening payload contains the goal, source references, delivery endpoint, required acceptance criteria, cohesive tasks, factual dependencies, verification obligations, and applicable authority references. Temporary local keys allow one submitted payload to express cross-references; code allocates stable IDs and returns the mapping atomically.

The main agent supplies meaning, not storage mechanics. Code allocates workset/task/criterion/attempt/evidence IDs, stores schema versions, increments revisions, computes fingerprints, and binds observations. Mutating calls echo an integer state revision returned by the tool as a compare-and-swap token; the model neither calculates revisions nor maintains hashes. A stale call returns the current bounded view without partially applying the change.

A plan reference remains semantic input, not an executable Markdown contract. The agent revises plan prose when its meaning changes, not after every task state transition. A source-file digest can detect that a plan changed; the main agent decides whether that changes the normalized goal. Missing optional source files do not silently reconstruct or replace the ledger.

### Canonical records

| Record | Required meaning and binding |
| --- | --- |
| Workset | Stable ID, repository/session origin, goal and goal revision, source/authority references, delivery endpoint, state revision, alignment state, active/paused/closed disposition, review policy. |
| Acceptance criterion (`AC-*`) | Observable required outcome, semantic revision, verification requirement, current disposition, and explicit goal-change provenance if retired or replaced. |
| Task (`T-*`) | Cohesive outcome, semantic revision, acceptance coverage, factual dependencies, repository owner, permitted write surface, execution constraints, completion evidence, and current disposition. |
| Attempt | Code-allocated execution identity bound to task revision and starting source basis; parent-local or managed transport reference; observed running/reported/failed/interrupted/unknown outcome. |
| Evidence | Provenance, observation versus agent/user declaration, criterion/task revisions, input/source basis, check or review identity, result, freshness, and bounded artifact references. |
| Acceptance decision | Main-agent judgment over named current criteria/tasks and evidence, with rationale; rejection, acceptance, or unresolved verification are distinct. |
| Amendment | Reason, source intent reference, affected IDs, replacement relationships, new coverage, and automatically computed invalidations. |

Criterion-to-task coverage is many-to-many. A task can provide partial evidence for a larger integration criterion; a required criterion can span several tasks. Coordination work without direct criterion coverage must name its enabling purpose. Neither a candidate apply nor an accepted task alone closes the workset.

### States and transitions

| Plane | States and essential transitions |
| --- | --- |
| Workset | `active`, `paused`, `closed`; close carries `completed`, `cancelled`, or `superseded`. Paused work resumes explicitly. Closed work never reopens from a hook; further work needs explicit enrollment or a new linked workset. |
| Alignment | `aligned` or `needs_alignment`, bound to delivered input generation and goal revision. Undelivered queued input is not yet a new accepted goal. |
| Task | `pending → running → awaiting_acceptance → accepted`; failed or incomplete work can become `blocked`, return to `pending`, or enter another attempt. `paused`, `cancelled`, and `superseded` retain reason and lineage. |
| Criterion | `unverified`, `accepted`, `stale`, or `retired`. Only an authorized semantic amendment retires a required outcome; task deletion cannot do it. |
| Evidence | `current`, `stale`, or `unavailable`; historical records remain readable. A new binding is needed to reuse evidence for a changed semantic revision. |

Task acceptance requires the declared task outcome and current supporting evidence plus a main-agent judgment. Workset completion additionally requires every current required criterion accepted, the declared delivery endpoint satisfied, no unresolved mandatory verification, no unexplained open attempt, and current input alignment. A `closed/completed` request that lacks these facts fails with a structured deficit, even if every visible task looks finished.

A block records its class (`needs-authority`, missing capability/environment, or evidence-backed non-convergence), evidence, remaining obligation, and next unblock condition. A failed test is not automatically a block; authorized diagnosis and repair remain possible. Pausing or cancelling is not completion and does not fabricate acceptance.

### Amendments and dependencies

Amendment is one validated transaction. It can add, change, split, merge, replace, suspend, cancel, or supersede tasks and change criteria when current user intent actually permits that. It preserves previous revisions and explicit replacement relations. IDs remain stable for a continuing outcome; split/merge replacements receive new IDs with lineage.

The reducer validates known references, acyclicity, current acceptance coverage, and consistent transitions. It rejects removing the last route to a required criterion unless replacement coverage or an authorized criterion amendment is included. Cancelling the whole workset preserves unmet obligations as cancelled, not accepted.

Dependencies mean that a predecessor's declared outcome must be available, not merely that a child process exited successfully. Code computes readiness from accepted current predecessors and explicit integration conditions. The main agent chooses among ready tasks, including parallel independent work; workflow code does not turn a task DAG into an automatic worker/reviewer/repair chain.

Changed acceptance semantics, task inputs, or predecessor contracts invalidate affected decisions and dependents. Cosmetic edits do not. The agent declares the intended amendment; code computes its actual structural scope and fingerprints, checks coverage, and marks affected bindings stale. It does not reset unrelated verified work merely because the global state revision increased.

## Evidence, drift, and acceptance

Evidence has two independent dimensions: provenance and semantic sufficiency. A host-observed tool result is not automatically a passing test; an agent's reading of its output is not a host-observed exit code. Store both honestly. Use native entry/tool-call references and public managed result identities where available, not copied logs presented as fresh execution.

When a verification attempt starts, code captures its declared source/input basis. At evidence submission and acceptance it checks the relevant current basis and known concurrent writes. An explicit scope can include source paths, test/configuration files, lockfiles, and upstream inputs. If reliable narrow impact scope is unavailable, use a conservative repository basis rather than inventing precision. Fingerprinting has finite byte/entry limits and returns `unavailable` when it cannot establish a basis; it never converts incomplete scans into an unchanged verdict.

Unchanged pre/post fingerprints are version-association evidence, not proof against an unobserved outside writer or proof that a test covers the goal. Verification cannot be certified fresh while known parent/apply writers affecting that basis remain active. Commands and environment details are captured only to the extent actually observable; missing structured exit information stays unknown. Required manual or live verification remains unverified without appropriate evidence and authority.

A child report binds to its actual handle, episode, source/candidate, and task revision. A completed apply is an integration fact, not semantic acceptance. Child-local evidence may remain useful when its relevant basis matches, but it does not stand in for a required parent integration check. Partial apply, owner mismatch, unknown request outcome, or source drift blocks the affected integration and is repaired under existing managed-execution rules; workflow does not merge, replay, or reset it automatically.

Evidence reuse is selective. Unaffected criteria retain valid bindings. A semantic revision requires an explicit carry-forward judgment and a new code-checked binding, leaving the original evidence intact. Rerunning the same check against unchanged inputs does not create substantive progress merely because its timestamp or evidence ID changed.

## Main-agent operations and subagents

The proposed tool operations are semantic rather than a generic state patch API:

| Operation | Purpose |
| --- | --- |
| `open` / `inspect` | Normalize and enroll one workset; obtain bounded current state, readiness, deficits, and exact record details on demand. |
| `align` | For a delivered input generation, confirm the existing goal, amend it, pause it, cancel it, or acknowledge an unrelated question without changing it. Alignment can be included atomically in the next mutation. |
| `amend` | Apply the validated revision/lineage/coverage transaction. |
| `start` / `record` | Start an eligible attempt and associate observations, results, or a managed transport reference. |
| `assess` | Record the main agent's acceptance/rejection/unverified judgment using specific current evidence. |
| `pause` / `resume` / `close` | Record a real disposition; `close/completed` enforces the completion predicate. |

Operation names and exact file decomposition can be refined during implementation without changing these semantics. All writes are serialized within the owning branch and use revision checks. A host-observed tool-call identity deduplicates a repeated execution of the same state mutation. A new call containing similar prose is not automatically a replay or a new attempt.

Parent-local execution remains ordinary Pi tools. Delegation remains explicit `csheng_subagent_sessions create/continue/inspect/apply/close`; workflow does not expose a rival subprocess runner or silently wrap retries. The parent links the returned identity to the attempt through the workflow tool. Workflow checks that referenced structured transport facts were actually observed under the relevant owner; it does not accept a fabricated handle as proof of execution.

Use flat batches for independent bounded work. File-dependent successors wait for explicit parent apply and the required integration/acceptance decision before a new dispatch. Report-only hard edges remain eligible only under existing managed rules. Reviewer output is a candidate finding, not an automatic acceptance or repair command. Closing a workset neither applies nor discards child candidates; any outstanding handle disposition must be explicit and remaining resources visible.

## Pi hook protocol

### New-input alignment

Distinguish input receipt from model delivery. On real interactive/RPC input receipt, invalidate any scheduled automatic-review lease immediately. Do not treat a queued follow-up as an already delivered new goal or force the running agent to interpret text it has not received.

Effective input means a new native user-message occurrence actually participating in public pre-provider `context`, after Skill/template expansion. Only then mark the open workset `needs_alignment`; editor drafts, receipt events, withdrawn/replaced queue entries, historical context and retries are not new intent. Ordinary preparation can associate an unambiguous source through `before_agent_start`; queued occurrences bypass it and may have unknown source. Track native occurrences and context participation, never infer receipt identity by text equality or queue order. Multiple identical inputs, image-only input, transformed input, withdrawn/replaced queues and multiple queued messages are mandatory fixtures.

Unknown-source participation still requires main-agent alignment under existing authority; it is not a new permission grant, a review-credit refill, or a reason to lock the task indefinitely. The agent may confirm, acknowledge or amend under actual existing instructions. Mixed-source receipts, including handled inputs, conservatively remain unknown when the public host cannot distinguish abandoned receipts from concurrent preparations. An unambiguous ordinary human preparation replenishes the finite review allowance; unknown enrollment begins without credit and recovery preserves spent credit. Public-hook preparation is the supported observation boundary, not proof of final wire delivery after arbitrary later extension rewrites.

The reminder names the current goal, revision, and required alignment action without deciding the new intent. It appears once for a delivered input, not as a per-request tail directive. At a safe message boundary the context projection attaches to that input, never between an assistant tool call and its results. A lost projection after compaction can be regenerated from pending alignment; a prompt is not the ledger.

Before alignment, workflow rejects starting another task/attempt, accepting results, or completing the workset under the old goal. It still permits inspect, observation recording for already running work, read-only diagnosis, ordinary answers, and cancellation. It does not abort an already running host tool or pretend to sandbox arbitrary shell writes. Parent instructions remain necessary for non-workflow tools.

The extension's own review prompt is extension-origin control context, not a new user goal or authority. Bind its review request to the workset/input generation and exclude unambiguously identified ordinary extension preparation from alignment. Ambiguous preparation may request non-authorizing reconciliation but cannot refill the allowance. Other extensions' messages also do not become human authorization just because they use user-role transport. Commands that intentionally change workflow state invoke the same reducer directly; unrelated slash commands do not reopen tasks.

### Settlement reconciliation

At normal `agent_settled`, compute the difference between the current completion/disposition contract and recorded facts. Do nothing when no workset exists, it is closed/paused, or all remaining obligations have a current explicit waiting disposition. Never guess why the model stopped or launch a second model to diagnose it.

A reconciliation request asks the same main agent to choose among concrete outcomes: record already completed work using valid evidence, continue authorized remaining work, amend/retire obsolete work in line with new intent, record a real block, or cancel. It does not say to rerun every test or repeat the whole plan.

Automatic review is allowed only for a normal successful settlement, no pending human input, no user abort/error/failed compaction/shutdown, current ownership and alignment, an eligible unresolved deficit, and remaining explicit policy allowance. Active user-facing UI prompts also suppress dispatch. Interrupted or unknown execution is inspection/recovery work, never an automatic replay.

The proposed initial policy permits one automatic review in the first opt-in experiment. The runtime supports a configurable finite number per genuine user-input epoch, with one dispatch per deficit/progress fingerprint. Only an operator policy change can increase that allowance; the model cannot award itself more. This is an actual recorded harness limit, not an invented model budget. The long-term mechanism is progress-sensitive and can allow several reviews; it is not permanently limited to one continuation.

Progress fingerprints exclude text edits, timestamps, ID allocation, inspect calls, repeated unchanged evidence, and pending/running toggles. They include newly satisfied obligations, relevant source-basis changes, and material current evidence changes. A repeated fingerprint stops automatic review. A no-progress review, exhausted allowance, or oscillating work under the finite cap records a visible paused-review reason while preserving unfinished tasks. Newly delivered user intent invalidates old review leases; synthetic follow-ups do not reset the allowance.

### Safe re-entry is an executable compatibility gate

Pi 0.85.1 clears its active-run flag before awaiting settlement handlers, then notifies native listeners. Consequently `ctx.isIdle()` alone is not proof that settlement dispatch has finished. A zero-delay timer or microtask queued by an early handler is also not a barrier when a later handler awaits work.

The adapter must prove that a review request cannot initialize a new interaction before the previous settlement consumers finish. Prefer the ordinary public `sendUserMessage` path, explicitly tagged as extension-origin, because it includes normal input and `before_agent_start`; do not silently substitute idle custom-message triggering. Use only documented APIs, never patch Pi methods or reach into its private agent/session fields.

The first implementation slice is a synthetic-host compatibility spike for full settlement ordering, ordinary and streaming input identity, cancellation races, and the co-loaded timing/observer consumers. If public APIs cannot establish a safe re-entry boundary on the supported host, automatic dispatch remains disabled and the slice returns the precise missing host contract. A host patch, private API dependency, weakened cancellation guarantee, or different continuation protocol requires a narrow new design/authority decision. Passive deficits are useful partial behavior but do not satisfy the automatic-continuation acceptance criterion.

This is an explicit technical risk, not an assertion that the current host is already compatible. Do not make safe task semantics depend on solving it: ledger mutations, manual inspection/alignment, and explicit user continuation remain usable. Do not present those partial capabilities as end-to-end completion of this design.

## Persistence and recovery

Use versioned non-model Pi custom entries as the initial sole durable ledger, replayed from the active branch. Pi owns the actual session JSONL file. There is no parallel `.workflow` directory, editable Markdown status file, or `rpiv-todo` synchronization. Tool results and UI are projections; they do not become a second replay source.

Each committed mutation appends one bounded complete state snapshot with its state revision, schema version, and transition identity. The in-memory reducer installs that result only after append succeeds. This relies on Pi's documented append/persistence behavior and does not claim an independent fsync transaction. Replay validates the latest authoritative entry; an unknown schema, invalid latest snapshot, missing referenced evidence, or revision inconsistency disables mutation with a visible recovery error rather than silently rolling back to an older convenient state.

Snapshots contain summaries and references, not full logs, prompts, file bodies, or child histories. Implementation must define finite record/byte limits and reject over-limit mutations without partial state; no automatic deletion or history truncation. Native history owns historical snapshots, while the current projection keeps only the bounded active workset and necessary lineage/evidence references. Inspect supports bounded detail retrieval.

On resume/reload, restore the active branch and recheck project ownership, current source basis, active tools, and host capability. On fork/tree navigation, treat copied state as historical intent, invalidate in-flight attempts and continuation leases, and require explicit alignment before new mutation/continuation. Do not transfer child-owner authority, merge sibling worksets, or equate a copied session prefix with a new execution. Compaction never relies on its prose summary to reconstruct state and never injects a new review into overflow recovery.

A crash between observed tool completion and ledger recording leaves an unrecorded/unknown attempt. Reconcile from owned evidence and explicit parent judgment; never rerun the operation merely because the state update is missing. A crash after append but before the tool result replays the committed transition under its host call identity. Session repair or retained-data deletion is not an automatic recovery action.

Shutdown/reload cancels all instance-owned pending callbacks and observations. Removing the extension leaves native history and applied repository changes intact, removes tools/hooks/UI, and starts no processes. Reinstallation can read supported snapshots but cannot resume automatically. No uninstall path deletes retained work or changes settings.

## Context, optional UI, and migration

Keep context small: static tool guidance, a once-per-delivered-input alignment request, on-demand inspect output, and a bounded deficit review when eligible. No full ledger in every provider request. Rework the subagents index toward once-per-real-turn/recovery reference material plus current tool results and explicit inspect; tool-side freshness and all identity/replay/apply guards stay authoritative. Failed provider requests and compaction must not repeatedly consume or multiply a recovery notice.

The optional `todolist` view renders readiness, current task disposition, stale/unverified acceptance, and block reasons from workflow state. UI-off and headless use have the same semantics. It does not call `setWorkingMessage` or replace the footer. A basic tool rendering/inspection surface is enough for the first milestone; richer widgets or an independently packaged UI can follow without a ledger migration.

Do not register a conflicting replacement `todo` tool. An installed `rpiv-todo` may continue to exist for unrelated use, but active workflow tasks use `csheng_workflow` exclusively. No dual writes, background import, or interpretation of its completed/deleted states as acceptance. An explicit later import may normalize historical items into unverified draft tasks; it is outside the initial milestone.

The proposed development baseline is Pi 0.85.1, verified against both package dependencies and the installed host. Align this repository's development pins and lockfile as a reviewed implementation change, not a claim of backwards compatibility with 0.84.4. No global Pi upgrade, dependency installation, route/settings edits, or package snapshot publish is authorized by this document.

Portable Skill changes are limited to making `implement-change` use an available workflow tool for normalized task state and evidence, while preserving a no-extension fallback and existing semantic ownership. `plan-change` already supplies suitable meaning; it must not emit runtime hashes, handles, or a fixed host schema. Authored changes belong in the external repository's `src/skills/`, with its generated output rebuilt through its owned pipeline.

## Acceptance and validation

The oracle is the public task contract and observable host behavior, not Markdown wording or model self-report. The main agent owns semantic acceptance; deterministic tests own mechanical invariants. No test may weaken a required goal to make a fixture pass.

| ID | Required outcome | Evidence |
| --- | --- | --- |
| AC-01 | Direct intent and existing plans can create a workset without a fixed input format or phase graph. | Tool/reducer scenarios plus portable Skill fallback review. |
| AC-02 | One ledger enforces coverage, DAG readiness, explicit acceptance, and truthful closure. UI absence has no effect. | Reducer transition/model cases and UI-off/headless integration. |
| AC-03 | Revision, split/merge/replacement, and input drift invalidate only affected evidence; retirement cannot silently erase required goals. | Amendment and evidence-binding scenarios including stale concurrent writes. |
| AC-04 | New native input actually prepared for the model requires main-agent alignment; drafts/withdrawn queues/history/retries do not. Known ordinary extension controls are excluded; unknown queued/mixed origin permits alignment under existing authority without credit refill. | Actual-host synthetic-provider traces for ordinary, queued/replaced, repeated, transformed and streaming inputs; no receipt identity guessing or irreversible origin lock. |
| AC-05 | Eligible premature settlement gets bounded main-agent reconciliation without duplicate dispatch, recursive intent handling, or no-progress loops. | Actual-host ordering/queue tests, cap/dedup scenarios, and explicit unsafe-host refusal. Unsafe-host refusal alone does not satisfy useful automatic continuation. |
| AC-06 | Cancellation, provider/compaction failure, shutdown, branch change, and child teardown never cause unauthorized continuation or replay. | Negative lifecycle scenarios, resume/fork fixtures, and managed-worker settlement regression. |
| AC-07 | Managed reports/candidates/apply stay distinct from acceptance; file successors wait for parent integration. | Existing managed tests plus workflow association and explicit-apply scenarios. |
| AC-08 | Ledger recovery, stale evidence, unknown outcomes, unsupported schemas, and resource limits fail visibly without losing retained state. | Disposable native sessions/Git, interrupted-write/replay fixtures, and schema/limit tests. |
| AC-09 | Co-loaded timing, observer, and headless behavior remains correct; reduced context retains current-state safety. | Installed-host offline co-load probe, existing timing/UI suites, and subagent continuity tests. |
| AC-10 | The runtime meaningfully reduces premature implementation stops without hiding incomplete work or causing excessive extra execution. | Separately authorized bounded real-task comparison: manual continue count, actual delivery, false completion/continuation, repeated checks, and added token cost. Not established by offline tests. |

Fast lane: contract/reducer/evidence fixtures with the existing Node test runner. Merge lane: disposable native session/Git and synthetic-provider host scenarios, including the actual installed CLI and known co-loaded extensions without real provider calls. Existing `npm run check` and offline extension probes remain regression gates. Live lane: explicit opt-in tasks, provider authority, and a declared finite experiment allowance; `PI_OFFLINE=1` is not an inference prohibition.

Do not add prose snapshot tests for Skills or these documents. Validate their structure, links, generated parity where applicable, and observable consumer behavior. Code and tests should be implemented together by cohesive slice, not by assigning all tests to a separate worker.

## Delivery, truth impact, and non-goals

The proposed implementation endpoint is reviewed source, portable Skill integration, and passing deterministic/offline installed-host evidence. Daily-use delivery additionally requires an authorized local package snapshot publish, restart, co-load validation, and a bounded live pilot. These are distinct results; source completion does not establish live effectiveness.

Implementation must update the package's root `AGENTS.md` boundary that currently excludes task-level lifecycle ownership. Limit the new exception to the workflow extension; plan-mode, subagents, and other extensions retain their existing independent contracts. Update human-facing README and stable architecture only from verified implemented behavior. This design itself changes no stable runtime truth.

Excluded: replacing Pi's model/tool loop; autonomous child missions; automatic candidate apply or finding adjudication; a generic permission framework; moving Skills into this package; an independent intent model; fixed R/P/I/V stages; a global multi-repository service; adopting the rpiv runtime; rich TUI work as a prerequisite; plan-mode removal; silent todo migration; provider/route changes; automatic cleanup of retained data.

Recovery is fix-forward within the approved task and retained evidence. Disable automatic review on a lifecycle incompatibility, preserve the ledger, and expose the unresolved obligation. Do not silently downgrade a required acceptance criterion, declare manual/live evidence non-blocking, or call a passive-only implementation complete.

## Review and approval

Independent read-only design and plan review ran on 2026-09-17 in one flat two-reviewer batch because persistence, lifecycle re-entry, and authority references interact across modules. Both reviewers returned `pass` with no material candidate findings; the parent accepted those bounded document verdicts. They specifically retained the WF-01 lifecycle/input proof, persistence/evidence fixtures, co-load/child teardown, and AC-10 live effectiveness as unverified implementation evidence. Review success is not implementation authorization.

Approval record (2026-09-17): the user approved this design and its plan and invoked `implement-change`, granting C2/E1: runtime source in `extensions/workflow/` and bounded tests/probes in `pi-extensions`, project-local development dependency alignment, the narrowly scoped authored/generated guidance in the external `agent-skills` repository, offline installed-host checks with disposable data, independent read-only review, accepted repair, and stable truth sync. The later “commit push publish, 我要去试试了” grants task-source commits/pushes in both E1 repositories and publication of the existing local Pi snapshot. Restart and trial remain user-owned; npm publication, separate Skill installation, agent-run provider experiments, settings changes and deployment remain excluded. See the plan's effective C3 approval summary.
