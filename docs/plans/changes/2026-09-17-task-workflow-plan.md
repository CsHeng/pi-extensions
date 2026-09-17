# Task Workflow Implementation Plan

Date: 2026-09-17

Status: approved 2026-09-17; **E1 (WF-01..WF-08) complete for reviewed source handoff**. Safe continuation uses an early-armed public command `waitForIdle`. The user's later clarification and implementation approval in session `01a0acfc-af3f-74eb-abbe-1ac0341f1932` superseded the receipt-identity prerequisite: only new native input actually prepared for the model drives alignment. Unknown origin requests non-authorizing alignment without credit refill or a task lock. No host patch is required. See the [E1 report](../../evaluations/2026-09-17-task-workflow-e1-report.md) for final evidence and limits. The user's subsequent “commit push publish, 我要去试试了” authorizes committing/pushing both E1 source repositories and refreshing the existing local Pi package snapshot. WF-09 restart/load confirmation and trial remain user-owned; no agent-run provider experiment or separate Skill installation is implied.

Design owner: [Task Workflow Design](2026-09-17-task-workflow-design.md). Its acceptance IDs and boundaries are authoritative for this proposal; this plan does not rescore them.

## Milestone and delivery endpoints

Implement one owned task-level workflow extension. The main agent supplies intent, cohesive slices, and semantic acceptance; code owns the branch-local ledger, DAG/readiness, revisions, evidence bindings, input alignment, and bounded settlement reconciliation. Reuse the managed subagent executor. `todolist` remains an optional projection, which may be co-located with the workflow; it must not drive its semantics or require a parallel ledger.

- **E1 — source handoff:** reviewed changes in `pi-extensions` and narrowly scoped portable guidance in `agent-skills`, passing deterministic and offline installed-host compatibility checks. This is the authorized and completed implementation package; it is not installation or live-pilot authority.
- **E2 — daily-use pilot:** local package snapshot publication is now authorized, along with source commit/push. The user will restart and try it; actual loaded behavior and AC-10 remain unverified until evidence is supplied. No agent-run real-provider experiment, automatic restart, settings change or separate Skill installation is included in this delivery.

Implementation must not end by claiming E1 success if the actual-host safe re-entry contract cannot satisfy AC-05. In that case, report a precise partial result and the blocking host fact. Already authorized, independent state/evidence work may continue, but a passive-only ledger is not the completed milestone.

The initial operating scope is one active workset per current repository/session branch. No fixed Skill phase graph, independent intent model, rpiv runtime dependency, general permission engine, automatic apply/replay, cross-repository scheduler, or rich TUI redesign is included. The separately recorded plan-mode removal is excluded and not a dependency.

## Repositories, authority, and shared ownership

| Surface | Owner and proposed writes | Current authority |
| --- | --- | --- |
| `pi-extensions` | Active parent; new `extensions/workflow/`, bounded tests/probes, package registration and development dependency pins, affected managed context/timing integration, README/AGENTS and stable architecture after verification. | C2 authorizes these source/test/probe/doc writes through E1, including the later model-preparation clarification. |
| External `agent-skills` | A separate repository-owned slice; authored `src/skills/workflows/implement-change/` and a narrowly necessary `plan-change` reference, generated outputs through its owned pipeline, affected stable guidance if needed. | C2 authorizes the narrowly scoped authored/generated implementation guidance. The existing plan guidance needed no change. |
| Agent directory and installed packages | Existing publisher refreshes the owned local package snapshot. | Subsequent user approval grants this publication only; settings, route, auth, unrelated installation and retained-state changes remain excluded. |
| Live providers | Parent-owned bounded experiment only. | Not authorized by document authoring, offline tests, or E1 source approval. |

The source checkout is not the daily installation. The existing `mise run publish-local-package` copies package sources into the owned local snapshot; it does not edit settings or reload an existing Pi process. No plan task may silently substitute installing the working tree, npm publication, or replacing unrelated loose extensions.

The parent owns shared contracts, package/lockfile changes, source integration, evidence acceptance, and final truth sync. Keep existing dirty changes intact. A writable child owns one repository and an exact dispatch-time write set; a `pi-extensions` managed worker cannot write sibling `agent-skills` files. The external Skill slice stays with the parent or an explicitly compatible repository-local executor.

## Implementation slices

Every slice includes focused tests, its own feedback loop, and in-scope repair. The paths below are bounded write surfaces, not fabricated final file inventories. Exact dispatch files are refined after the shared contract exists. None of the future writable slices is claimed delegation-ready in this plan.

| ID | Cohesive result | Factual predecessors | Owner / write surface | Completion evidence |
| --- | --- | --- | --- | --- |
| WF-01 | Establish the supported public host lifecycle contract and development baseline. | None. | Parent; `package.json`, lockfile, new host conformance fixture/test and a small workflow host-adapter seam if proved. | Synthetic installed/dependency-host traces for ordering, input delivery, cancellation, and unsupported-host behavior; no private Pi API or real inference. |
| WF-02 | Implement the canonical workset/reducer, branch persistence, and namespaced workflow tool. | WF-01's host/persistence facts and parent acceptance of the exposed adapter contract. | One core owner; `extensions/workflow/` contract/reducer/store/tool modules and owning tests. | AC-01/02/03/08 transition, coverage, stale-write, persistence, and replay scenarios. |
| WF-03 | Bind parent and managed execution evidence to current obligations. | WF-02's frozen record/transition contracts. | One evidence owner; workflow evidence/managed-association modules and owning tests. | AC-03/07/08 freshness, provenance, explicit-apply, partial/unknown outcome, and selective reuse scenarios. |
| WF-04 | Implement delivered-input alignment and progress-bounded main-agent reconciliation. | WF-01's verified host adapter contract; WF-02's deficit and state interfaces. | One hook owner; workflow hook/review-policy modules and owning tests. | AC-04/05/06 synthetic lifecycle and policy scenarios; integration with real WF-03 observations is completed in WF-07. |
| WF-05 | Reduce managed-session per-request tail interference without losing recovery safety. | WF-01's actual-host context/recovery facts. | One subagent-context owner; `extensions/subagents/context.ts`, minimal relevant registration changes, and context/continuity tests. | Once-per-input/recovery projection behavior, inspect freshness, disabled-tool/trust tests, unchanged replay/apply/owner checks. |
| WF-06 | Adapt portable implementation guidance to an available workflow tool without mandating it. | WF-02's accepted model-facing semantics. | Parent or one separate `agent-skills` owner; authored implementation guidance and generated counterparts, narrowly affected references. | Owned generation/check pipeline and read-only review of direct-intent, plan, amendment, evidence, and no-extension paths. |
| WF-07 | Integrate the extension and minimal optional presentation; prove package co-load. | WF-02/03/04/05 integrated; WF-06 for the end-to-end guidance scenario. | Parent; workflow index/basic view, `package.json` registration, integration tests/probes, only proven necessary `work-timing` changes. | AC-01 through AC-09 across actual installed-host synthetic-provider runs; UI-off/headless parity; no child workflow load or lifecycle interference. |
| WF-08 | Complete independent implementation review, accepted repair, aggregate verification, and stable truth sync. | WF-07 and the final integrated candidate. | Parent; accepted in-scope repairs and owned docs; independent reviewers are read-only. | E1 report mapping every AC to current evidence or an explicit remaining E2 gap; no unresolved E1 acceptance failure. |
| WF-09 | Publish the now-authorized local snapshot; leave restart/load confirmation and trial evaluation with the user. | WF-08, separate E2 authority, and an actual user restart/load confirmation. | Parent for publisher and evaluation; user owns restart and discretionary settings changes. | Verify published snapshot equality to committed package source. User restart/load and AC-10 evaluation remain pending; do not infer them from a copy. |

### WF-01 — host conformance before continuation code

Use Pi 0.85.1 as the proposed baseline; align the three development Pi package pins and lockfile in one owned change. Read current official docs/source at execution time and revalidate if the installed binary has changed. Version existence, hook signatures, and package compatibility are investigable facts, not questions to send back to the user.

Build the smallest disposable synthetic-provider fixture that exercises the actual host. It must observe normal prompt, steering, queued follow-up, template/Skill-expanded input, identical inputs, image-only input, provider failure, compaction/retry, Escape/abort, and the normal settlement ordering. Exercise settlement consumers registered both before and after workflow, including an asynchronously completing later handler. `isIdle`, a microtask, or a zero-delay callback alone must not pass as a full-dispatch barrier.

Prove an ordinary public main-agent re-entry path that preserves `input` origin, `before_agent_start`, timing initialization, and previous settlement completion. Do not use idle custom-message triggering merely because it starts a turn. Do not solve correlation by matching input text, reading private host fields, or patching Pi methods. Record the specific supported API assumptions in the fixture and adapter, including session custom-entry append behavior and branch replay.

If that proof fails, disable automatic dispatch and return the precise missing public-host contract. Parent may continue independent authorized reducer/evidence work, but must not silently switch to `agent_end` steering, assume timer ordering, patch the installed host, weaken cancellation, or mark AC-05 complete. A materially different continuation protocol is X1 below.

Recovery: fix forward within documented APIs. Keep dependency changes local and review their regression surface; do not upgrade the globally installed Pi or hide a failed compatibility check behind a skip.

### WF-02 — authoritative state and tool

Implement the design's record planes and action semantics, not `rpiv-todo`'s four-state enum. Create IDs and revisions in code. Validate the complete mutation before a single append; stale expected revisions return a bounded current view with no partial change. Opening a plan accepts temporary local keys and allocates stable IDs atomically.

Protect coverage and delivery separately from task status. Required outcomes remain pending when tasks are split, merged, replaced, cancelled, or marked accepted without sufficient workset evidence. Implement explicit carry-forward of valid evidence bindings rather than resetting everything on any state revision. Code computes DAG readiness; the parent still selects work and adjudicates acceptance.

Use non-model Pi custom entries as the only durable workflow state. Read the current branch, not all mutually exclusive history. Cover successful append followed by a lost tool response, failed append without installing new in-memory state, malformed latest snapshot, unknown version, copied fork prefix, reload, compaction, finite snapshot/record limits, and disabled extension. Define actual limits in typed contracts and test their boundaries; do not add automatic history cleanup.

Recovery: fail visibly on unknown/corrupt state and preserve history. No automatic fallback to an older accepted snapshot, replay of a possibly completed external action, or manual model editing of JSONL. Explicit inspect and diagnostic state remain available.

### WF-03 — evidence and executor association

Observe parent tool results and public managed result envelopes, keeping source facts distinct from semantic judgments. Do not parse a free-form report into fabricated transport success, exit codes, authority, or candidate identity. Bind a result to its actual current-owner task/attempt revision before it can support acceptance.

Implement bounded source/input fingerprints and check freshness before assessment. Include oracle/configuration/lockfile/upstream inputs in declared bases; use conservative scope where impact is unknown. Test unavailable scans and known concurrent writes. Hashes prove association, not correctness, and successful child-local checks do not replace required parent integration checks.

Exercise explicit sequence: start task attempt, create/continue child, record report/candidate, parent inspect and apply, record integration, verify relevant parent state, assess, then start a file-dependent successor. Negative fixtures cover unknown outcome, stale owner/episode, partial apply, close/discard, candidate drift, and a report-only dependency mistaken for propagated files. No new child runner, route setting, implicit retry, auto-apply, or direct reads of private child state are introduced.

Recovery: delegate physical recovery to existing managed actions under parent judgment. Preserve historical evidence and mark only affected bindings stale. A state update missing after an observed action prompts reconciliation, not re-execution.

### WF-04 — alignment and settlement obligations

Distinguish received input, actual model-prepared native occurrences, and extension-origin control messages. Input receipt cancels stale review leases but never mutates alignment or creates a lasting review veto after queue withdrawal. Actual participation in public pre-provider context creates `needs_alignment`; unseen/dropped/replaced queues do not. Unknown queued or mixed origin permits explicit alignment under existing authority without granting permission or replenishing review credit. Unambiguous ordinary extension preparation is excluded. Keep one-shot context at safe message boundaries and support streaming preparation that bypasses `before_agent_start`.

Alignment may confirm unchanged intent, amend the workset, answer an unrelated question while keeping the goal, pause, or cancel. Reject new task starts, acceptance, and workset completion under unaligned intent, while allowing inspect, recording in-flight observations, ordinary reading/answers, and cancellation. Do not claim arbitrary shell writes are blocked by this task gate.

At normal settlement compute deficits, not the supposed psychology of stopping. Reuse current evidence. Implement review leases keyed to workset/branch/input generation and a progress fingerprint that ignores cosmetic changes and repeated unchanged results. Honor the finite configured cap; the first pilot allowance is one automatic review, with later increases requiring operator choice. Synthetic messages cannot refresh that allowance.

Negative tests must assert zero provider requests for closed/paused worksets, ordinary Q&A without enrollment, unaligned/queued human input, provider errors, abort, failed compaction, active UI prompts, shutdown, stale leases, repeated/no-progress fingerprints, and managed child teardown. A consumed allowance or lack of progress leaves a visible unfinished disposition, never `completed`.

Recovery: cancel owned callbacks and retain deficits. If safe dispatch is unavailable, expose a typed incompatibility and do not call the milestone complete. Do not create an alternate intent-analyzer route as a fallback.

### WF-05 — managed context as reference, not recurring mission

Keep registration, inspect, result envelopes, owner/branch checks, unknown-request refusal, and explicit candidate/apply guards intact. Remove the every-provider-request tail instruction pattern in favor of bounded once-per-real-input/recovery reference context, refreshed tool results, and on-demand inspect. It must still work when workflow is absent; do not make subagents import the workflow runtime or gate its safety on task enrollment.

Characterize start/reload/fork/tree/compaction behavior before changing context placement. Recovery notices are reference material and do not launch a turn. Retry or overflow recovery must not multiply notices. A prompt index is advisory; inspect and tool execution remain the fresh authority for managed state.

Recovery: preserve safety checks and report an unproven context path rather than removing them to achieve a smaller prompt. Any performance/attention gain remains a live-evaluation hypothesis.

### WF-06 — portable Skills remain semantic guidance

Change authored files under the external repository's `src/skills/workflows/implement-change/`. Touch a `plan-change` reference only if necessary to explain carrying stable semantic task IDs and acceptance meaning; do not make planning output a runtime ledger or add concrete managed handles, hash maintenance, or required Pi-only phases.

When a compatible workflow tool is available, guide the main agent to normalize the tasklist, align changed user intent, use amendments rather than status fiction, and submit actual evidence and explicit dispositions. When it is absent, preserve existing implementation behavior and semantic responsibility. Do not move these Skills into `pi-extensions`, alter their public IDs, add an intent model, or change harness-global instructions.

Run the repository-owned generation/check commands from `agent-skills`:

```bash
python3 scripts/generate-skills-index.py
python3 scripts/flatten-skills.py --target root-flat
python3 scripts/generate-workflow-diagrams.py
bash scripts/check.sh
```

Review the generated diff and reject unrelated churn. Do not hand-edit `skills/` or `skills.index.json`. If the pipeline has materially changed, inspect its current owned entry point instead of assuming these planning-time commands remain authoritative.

Recovery: fix authored guidance and regenerate. Do not modify installed Skills or provider/user settings to make a check pass. Offline checks establish portability/structure, not model adherence or live benefit.

### WF-07 — integration and optional presentation

Register the extension without enrolling a workset at startup. Provide bounded tool rendering/inspect output with enough detail to operate entirely without a widget. A small co-located read-only task view is optional; if present, it uses the same canonical state and does not own transitions. No footer replacement, working-message competition, or separate todo persistence is included.

Prove no dependency on `rpiv-todo`; do not register a conflicting `todo` tool or synchronize its state. Test the chosen co-load story with disposable resources rather than altering the user's installed package/configuration. Test ordinary package use with workflow disabled as well as workflow active with UI off.

Integrate the actual WF-03 observation path with WF-04, not only fakes. Verify timing completes the old interaction exactly once, initializes the new one correctly, and is not cleared by an old settlement handler. Check observer finalization, parent-versus-child load boundaries, managed candidate freeze/shutdown, headless mode, and cancellation during a pending review. Make `work-timing` changes only when a reproduced integration failure requires them; its independent behavior remains protected.

Add temporary-load and installed-host offline probes following this repository's disposable settings/synthetic-provider conventions. Use separate homes/session directories, explicit environment allowlists, readiness signals rather than sleeps, and redacted output. Do not use live settings, auth, child stores, or `PI_OFFLINE=1` as a substitute for eliminating real provider access.

Recovery: keep automatic review off until the actual host co-load passes. Failure does not authorize patching another extension's settings or Pi's UI methods.

### WF-08 — verify, adjudicate, and sync truth

Run the final candidate's narrow checks, then the repository aggregate and existing offline probes. Arrange independent bounded read-only implementation review around state/evidence correctness and lifecycle integration. Reviewers may execute permitted local verification labor but cannot accept the change, apply candidates, expand authority, or decide repairs. Parent adjudicates findings, integrates accepted in-scope repair, and rechecks affected evidence; no fixed worker→reviewer→repair graph or arbitrary iteration cutoff.

Update stable truth only after the corresponding behavior is verified:

- `AGENTS.md`: permit the workflow's task-level ownership without weakening the host-loop boundary or other extensions' non-workflow contracts; update maintained-extension inventory.
- `README.md`, `docs/README.md`, and new `docs/architecture/workflow.md`: commands/tool behavior, activation, optional presentation, state/recovery/removal, supported host, and known verification limits.
- `docs/architecture/subagent-execution.md`: implemented context/recovery behavior, retaining execution/acceptance separation.
- External Skill stable guidance only where its verified portable behavior changed.

Map evidence to AC-01 through AC-09; label AC-10 unverified until WF-09. Record supported host version, exact local candidate, tested co-load, and excluded live/configuration actions. Do not present a source handoff as installed behavior or reduced premature-stop effectiveness.

Final E1 result: **complete for source handoff**. Earlier premature completion and blanket settlement-impossibility claims remain withdrawn. State/evidence repairs, actual model-prepared input alignment, and safe ordinary reconciliation are verified. `npm ci --ignore-scripts`, `npm run check` (535/535 tests, zero skips, typecheck and shell syntax clean), eight offline probes and external Skill checks (111 tests plus generated parity) passed. Independent bounded reviews covered state/evidence, lifecycle and the final input/credit changes; no accepted defect remains. A mixed handled/overlapping receipt can conservatively classify ordinary input as unknown, causing explicit alignment without authority or credit; real-host regressions cover both source orders. See the [E1 report](../../evaluations/2026-09-17-task-workflow-e1-report.md). Subsequent local publication is authorized; restart/load evidence and AC-10 remain outstanding user-trial work.

Recovery: fix forward within scope. Reopen a design decision only when evidence invalidates a real approved boundary, not for ordinary helper choices, test repair, or dispatch-file refinement.

### WF-09 — separately authorized pilot

Current delivery approval covers `mise run publish-local-package` to the existing `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/packages/csheng-pi-extensions` snapshot, plus commits and pushes to both E1 repositories' existing `origin/main`. Publish no unrelated dirty work. Do not install external Skills, edit settings or start a live experiment. The user owns restart and trial; any later agent-run experiment still needs an exact task, provider-call authority and finite allowance.

After authorized `mise run publish-local-package`, require actual restart/load evidence; a file copy does not prove the current process loaded it. Run the bounded pilot with one automatic review initially. Compare manual continue count, actual delivery, false completion/continuation, unchanged test repetition, and incremental usage against suitable task evidence. Report task/model/context differences rather than claiming a causal failure-rate ranking from incomparable sessions.

Any erroneous continuation after explicit cancellation, unintended scope expansion, or invalid-evidence completion is a failed safety result: stop automatic review and preserve evidence. More reviews or a wider live experiment require a new explicit allowance. Disabling the feature is permitted recovery only within the approved pilot controls; editing user settings or removing retained histories is not implied.

## Ordering, parallel work, and convergence

WF-01 is first because actual public-host behavior controls the continuation/input adapter contract, not because explorer work is universally required. WF-02 then establishes the shared records and tool contract. The parent accepts those interfaces before declaring independent write slices.

After that point, WF-03 and WF-04 may proceed independently against the frozen interfaces, with actual integration reserved for WF-07. WF-05 can run independently after WF-01; WF-06 can run independently after WF-02 in its own repository. These are potential flat groups, not ready dispatches or promises of speedup. If an interface is still changing or shared files collide, retain/coalesce the work rather than inventing independence.

Before actual writable delegation, refine exact files, one repository owner, scope, locks/shared resources, safe isolation, verification, completion evidence, and failure policy. Use provider-neutral execution/reasoning profiles only if the dispatch requires them; this plan grants no concrete model override. Prefer a cohesive worker carrying code, tests, and local repair together. Parent retains package/lockfiles/shared contracts and all cross-repository integration.

Use flat `csheng_subagent_sessions` batches for independent bounded work. Explicitly apply an accepted candidate before dispatching a successor that consumes its files. Hard predecessor edges convey reports, not those files, and cannot replace parent acceptance/authority decisions. Continue a relevant same-task worker/reviewer when useful and supported; do not prefill handles or replay unknown requests. Close records explicitly when no longer needed, with user-authorized retention/discard semantics.

## Verification map

| Boundary and oracle | Fixture / owning suite | Lane and authority | Failure diagnosis |
| --- | --- | --- | --- |
| Coverage, DAG, revisions, transitions, completion predicate; model/example oracle | New workflow reducer/contract tests, Node runner | Fast; no credentials | Core owner; prevents E1 completion. |
| Evidence provenance and freshness; contract/scenario oracle | Disposable Git + actual tool/managed-envelope fixtures | Fast/merge; local temporary data | Evidence owner; unknown facts remain unknown. |
| Native branch persistence and replay; state-transition oracle | Disposable Pi session files and actual session API | Merge; no real user sessions | Core/host adapter owner; no fallback that loses history. |
| Delivered intent, settlement, re-entry, cancellation; lifecycle scenario oracle | Synthetic provider with real dependency and installed host | Merge; no real provider calls | Host/hook owner; unsafe re-entry disables automatic dispatch and blocks full E1 acceptance. |
| Managed context and workflow association; contract/continuity oracle | Existing subagent suites plus new integration cases | Merge; no external child-state inspection | Subagent-context/integration owner. |
| Timing/observer/UI-off/headless isolation; user-visible scenario oracle | Existing timing/TUI harness and narrow co-load probe | Merge; temporary settings, installed CLI | Parent integration owner. |
| Portable Skills and documentation | Owned generation/parity/prose/link checks and bounded semantic review | Fast; two repository roots, no runtime settings | Skill/docs owner; no exact prose snapshot assertions. |
| Package loading and real premature-stop benefit | Published owned snapshot + approved task comparison | Release/pilot; E2 and provider authority | Parent; disclose AC-10 result and safety failures. |

Run focused future workflow suites using the existing runner, then these current aggregate/offline gates from `pi-extensions`:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
```

The implementation adds the two workflow probes to the same offline lane after their owning scripts exist. `npm ci` uses the approved development lockfile and installs only project-local dependencies; it is not a global installation. Multi-skill print-mode probes and live subagent E2E are not silently added: they can cross real provider preflight and require separately matching authority. Existing live observer checks are deliberate, not a replacement for deterministic co-load evidence.

The source handoff includes the runtime checks listed above, bounded independent review, local Markdown links, `git diff --check`, and the repository's prose checker. Preserve unrelated dirty surfaces; the external repository's only task changes are its authored/generated implementation guidance.

## Review and planning result

Independent design and plan reviewers inspected these artifacts read-only on 2026-09-17 in one flat batch. Both returned `pass` without material candidate findings; the parent accepted the verdicts within their bounded document scope. The plan review confirmed the source/pilot distinction, early lifecycle proof, conditional parallelism, evidence freshness, and authority/recovery boundaries. No repair-driven rereview was needed. This review did not execute WF-01 or establish runtime compatibility.

Document-only validation passed: tracked and new-file whitespace checks, eight local Markdown links, and the prose checker (`markdown_files=40`, `files_with_hard_wrap=0`). The existing dirty source/Skill-evaluator surfaces were preserved; the external `agent-skills` checkout remained unchanged. No runtime implementation, installation, or live experiment was performed.

The previous demand for a queued receipt/source host API is superseded by the user's later clarification and approval: align actual model-prepared input, not receipt bookkeeping. Queued source remains unknown but does not prevent alignment under existing authority or create new review credit. This public-hook implementation requires no host patch/upgrade. The later local snapshot publication approval does not establish restart/load success or authorize an agent-run provider experiment.

## Implementation-approval summary

- **C1 — documentation:** author and review the design/plan documents. Completed and approved 2026-09-17.
- **C2 — E1 decision (granted 2026-09-17 by the user's approval of these documents followed by `implement-change`):** authorize WF-01 through WF-08 together: local source/test/probe changes in `pi-extensions`, project-local dependency alignment, the specifically scoped authored/generated guidance in `agent-skills`, offline installed-host checks with disposable data, independent review, accepted repair, and stable truth sync. Endpoint: reviewed source handoff, not installed or live-validated behavior.
- **C2a — effective-input clarification (granted in the same session):** the user stated that only messages actually prepared for the model count, not edited/undelivered queues, then instructed “那就改啊，改完推进验收”. The current request resumes that work through E1 closure. Supersedes the queued-identity hard-lock/host-patch prerequisite; does not authorize global changes or E2.
- **C3 — delivery approval (granted by “commit push publish, 我要去试试了”):** commit/push the task-owned changes in `pi-extensions` and `agent-skills` to their existing `origin/main`, and publish the existing local Pi package snapshot using the repository publisher. The user owns restart and trial. This does not grant npm publication, settings/provider changes, separate Skill installation, or an agent-run real-provider experiment.
- **E3 — continuous execution after C2:** the agent owns investigation, exact in-range file refinement, schemas/IDs/hashes generated by code, ordinary local tests, compatible bounded delegation, candidate integration, review adjudication, and accepted repair through E1. Do not ask approval again for those execution products or local choices. Continue independent authorized work when only one affected boundary is blocked.
- **X1 — real pause condition:** a proved public-host gap requires private APIs, a host patch/upgrade beyond the approved dependency surface, different continuation semantics, or weakened cancellation/lifecycle guarantees. Return the smallest evidence-backed decision; do not hide it as a skipped test or declare passive-only success.
- **X2 — real pause condition:** new goals, broader repository/write scope, changed required acceptance/delivery, unsupported retained-state migration, credential/access needs, or a new external side effect. Pause the affected action, not unrelated authorized work. Review success and generated metadata do not supply missing permission.
- **Remaining exclusions after C3:** npm-publish, unrelated/global installation, user settings/routes/provider changes, agent-run live provider calls, production deployment, destructive cleanup, automatic child apply/retry, plan-mode removal, and moving Skills into this package. Source commit/push and the named local snapshot publish are now authorized, not pending permission.
