+++
artifact_kind = "plan"
plan_version = 1
approval_status = "approved"
approval_basis = "The user approved this plan and explicitly requested implement-change on 2026-09-04."
decision_state = "decided"
approved_design = "docs/plans/changes/2026-09-04-subagent-operator-observability-and-evaluation-design.md"
approved_design_sha256 = "ed7146100edba08bd6685a6d69c9811b6e6f9e4e8119414e6c4928e53b8930de"
implementation_authority = true
implementation_status = "in_progress"
truth_sync_required = true
truth_sync_status = "pending"
parallel_execution_proposed = true
review_required = true
review_status = "passed_after_repair"
implementation_review_required = true
+++
# Subagent operator observability and current-epoch evaluation implementation plan

## Milestone objective

Implement the approved `2026-09-04-subagent-operator-observability-and-evaluation-design.md` without turning `csheng_subagents` into a background or resumable agent runtime.

The completed milestone will:

- publish bounded versioned lifecycle snapshots and cancellation receipts from the authoritative foreground runtime;
- add an independently removable TUI-only `subagents-ui` extension with keyed status, a bounded `belowEditor` panel, a live overlay, `Ctrl+Alt+F`, explicit cancellation confirmation, and one context-free settled summary entry;
- support whole-run and pending/running per-task cancellation while preserving dependency blocking, unrelated branches, diagnostics, cleanup, and non-interruptible worker convergence;
- issue opaque effective extension/configuration epochs through a constant-size private manifest and write runtime telemetry schema three;
- retain exact-session evaluation and add explicitly authorized, fail-closed current-epoch aggregation across parent Pi sessions;
- keep plan eligibility unavailable without approved plan evidence and avoid semantic blame from worker counts alone;
- show total parent reasoning duration and rounded wall-time share in collapsed and expanded `work-timing` entries;
- preserve `work-timing` as the sole working-row owner, `session-id-footer` as the sole footer factory owner, and the parent Pi as synthesis, verification, review, repair, continuation, and final-response owner.

This plan does not authorize implementation. It also does not authorize provider calls, package installation into Pi user state, route/configuration mutation, commit, push, publication, deployment, or deletion of existing diagnostics/provenance.

## Approval and prerequisite state

The user approved the design direction and explicitly requested design and planning. The design is approved and passed one bounded review after a focused repair. This plan is `ready_for_approval`; repository mutation in `pi-extensions` remains unauthorized until the user explicitly approves implementation.

The separate small `agent-skills` clarification is already complete outside this plan:

- authored `src/skills/workflows/plan-change/SKILL.md` now requires a concrete predecessor artifact, shared resource, or parent-owned decision for every serial dependency between delegation-ready tasks and rejects narrative order as a dependency;
- `skills/plan-change/SKILL.md` was regenerated with `scripts/flatten-skills.py --target root-flat`;
- the skills index and workflow diagrams were regenerated;
- `bash scripts/check.sh` passed all gates, including 98 tests;
- only the authored and generated `plan-change/SKILL.md` files changed in that repository.

That sibling-repository change is not an implementation dependency or writable surface for this plan.

The current `pi-extensions` worktree already contains user changes in `AGENTS.md`, `README.md`, `package.json`, `tests/package.test.ts`, and untracked `session-id-footer`/`work-timing` source and tests. Future implementation must preserve these changes and edit shared files only during parent-owned integration. No reset, checkout, cleanup, staging, or commit is authorized.

## Frozen design decisions

- Event names are `csheng.subagents.snapshot.v1`, `csheng.subagents.cancel.request.v1`, and `csheng.subagents.cancel.receipt.v1`.
- Full snapshots, not replayed deltas, carry one bounded active run and at most ten task projections.
- No event carries prompts, objectives, child output, stderr, tool arguments, model selectors, repository/external/diagnostic paths, credentials, or environment values.
- `subagents-ui` uses `csheng.subagents.status`, `csheng.subagents.panel`, `/subagents-ui`, `Ctrl+Alt+F`, and custom entry type `csheng-subagents-run`.
- `subagents-ui` never calls `setWorkingMessage()` or `setFooter()` and is inert outside TUI mode.
- A control receipt proves only acceptance/rejection of a request. Ordinary task/run results prove settlement and outcome.
- A task-targeted cancellation during convergence returns `too-late`. A run cancellation is accepted, stops all cancellable work, permits an already converging worker to settle, and produces an aborted aggregate.
- No text steering, retry, resume, continuation, background work, mission, dynamic role, nested delegation, or child stdin is added.
- Effective extension/configuration transitions use opaque epochs backed by a private constant-size manifest, not mtime or session creation time.
- A superseded loaded core never overwrites a newer extension epoch and becomes provenance-unavailable if it observes a configuration transition.
- New calls use runtime telemetry schema three. Exact-session evaluation keeps schema-one/two support; current-epoch evaluation selects only matching schema-three runs.
- Multi-session current-epoch mode requires an explicit sessions root and exact provenance manifest and applies one cohort to all metrics.
- The scanner uses the exact design limits: depth 8, 20,000 entries, 4,096 candidate sessions, 64 MiB per session, 1 GiB total input, 1 MiB per line, 100,000 parsed runs, 1,000 detailed runs, 256 route keys, 256 error keys, and 4 MiB encoded output.
- Runtime/evaluator evidence does not determine whether an approved plan was conservative. Plan eligibility remains unavailable without separately approved structured evidence.
- `work-timing` entry schema remains version one; reasoning share is derived during rendering, unavailable at zero total, and presentation-bounded to 0–100 percent without altering stored duration.

Any need to change these decisions returns `needs_design_decision` rather than widening a task.

## Oracle strategy

Use a mandatory real-host compatibility gate, contract examples, scheduler state-transition tests, fake-Pi extension/component tests, disposable private-filesystem tests, streaming multi-session fixtures, redaction negatives, generated package checks, stable-truth review, and one bounded implementation review. No network or provider credential is needed.

| Protected boundary | Oracle | Fixture/environment | Owning suite | Failure diagnosis owner |
| --- | --- | --- | --- | --- |
| Active shortcut/overlay host capability | Real Pi 0.84.4 PTY compatibility probe | Disposable agent dir, deterministic local fake provider and blocking tool, clean environment | Preflight gate | active parent / Pi contract |
| Event/control DTOs and telemetry v3 | Contract examples and invalid-shape tables | In-memory fixtures | subagent contract/event tests | shared contract owner |
| Task/run cancellation | Model/state-transition tests | Controlled scheduler executors and worker phases | scheduler/extension tests | scheduler and entrypoint |
| Provenance epochs and locking | Filesystem/concurrency component tests | Disposable private dirs, injected clock/randomness, simulated writer crash | provenance tests | provenance owner |
| Configuration snapshot coherence | Parser/load examples | Packaged/user byte fixtures | routing/config tests | config loader |
| TUI projection and removal | Fake extension context/component tests | TUI/headless modes, fake event bus, controlled overlay | subagents-ui tests | UI extension |
| Current-epoch selection | Streaming integration/contract tests | Nested disposable parent-session JSONL and exact manifest | evaluator tests | evaluator owner |
| Reasoning share | Rendering examples | Existing entry data plus historical/invalid cases | work-timing tests | work-timing owner |
| Package/stable truth | Package contract, docs checks, offline probes, review | Current repository | full gate | active parent |

Oracle edits that weaken exact cancellation status, accept stale/unknown control targets, interrupt convergence, widen event content, expose fingerprints/epochs/paths, treat mtime as cohort authority, emit partial scan results, silently scan a default root, make provenance failure block execution, or let another extension write the working row/footer require explicit design review.

## Acceptance trace

| Acceptance ID | Design requirement | Owner tasks | Primary evidence |
| --- | --- | --- | --- |
| OOE-A1 | Bounded full lifecycle snapshots with no sensitive content | `OOE-100`, `OOE-500` | event contract and extension update tests |
| OOE-A2 | Independently removable TUI consumer and non-conflicting surfaces | `OOE-600`, `OOE-800` | TUI/headless/removal/package tests |
| OOE-A3 | One non-authoritative settled summary entry | `OOE-600`, `OOE-800` | custom entry persistence/render tests |
| OOE-A4 | Inspector opens and rerenders during foreground work | `OOE-G0`, `OOE-600`, `OOE-800` | real-host gate and component integration |
| OOE-A5 | Explicit run/task cancellation and receipt semantics | `OOE-400`, `OOE-500`, `OOE-600` | scheduler, runtime, and UI state transitions |
| OOE-A6 | No steering, continuation, background work, or second ledger | `OOE-100`, `OOE-500`, `OOE-800` | schema negatives and stable truth |
| OOE-A7 | Private effective extension/configuration epochs and crash-safe lock | `OOE-300`, `OOE-500` | disposable filesystem/concurrency tests |
| OOE-A8 | Runtime telemetry schema three with coherent provenance/caps | `OOE-100`, `OOE-500` | contract and all failure-path fixtures |
| OOE-A9 | Explicit bounded current-epoch multi-session evaluation | `OOE-700` | streaming selection/limit/redaction tests |
| OOE-A10 | Honest unavailable plan eligibility | `OOE-700`, `OOE-800` | metric contract and docs review |
| OOE-A11 | Collapsed reasoning total and share, schema-v1 compatibility | `OOE-200` | renderer examples and historical entries |
| OOE-A12 | Independent package behavior and stable truth converge | `OOE-800`, `OOE-900` | full gate, probes, docs checks, review |

## Task graph

```text
explicit implementation approval
└── OOE-G0 active-TUI host capability gate
    └── OOE-G1 preserve the pre-edit dirty-tree baseline
        ├── OOE-100 freeze event, control, phase, and telemetry-v3 contracts
        │   ├── OOE-300 provenance and coherent config snapshots
        │   ├── OOE-400 scheduler cancellation
        │   └── OOE-600 standalone subagents-ui consumer
        └── OOE-200 work-timing rendering

OOE-300 + OOE-400 -> OOE-500 core runtime integration
OOE-500 -> OOE-700 current-epoch evaluator
OOE-500 + OOE-600 -> OOE-750 cross-extension UI/control integration
OOE-200 + OOE-700 + OOE-750 -> OOE-800 package and stable truth
OOE-800 -> OOE-900 full verification and implementation review
```

Every edge has a concrete reason:

- `OOE-G0` must prove the required live Pi surface before production edits can rely on it.
- `OOE-G1` must snapshot the already dirty shared files after the host gate and before any approved edit so later convergence can distinguish preserved user bytes from this milestone.
- `OOE-100` freezes DTOs and schema types consumed by the independent UI, provenance, and scheduler slices; `OOE-200` does not depend on those contracts and shares only the mandatory host and dirty-tree gates.
- `OOE-500` needs both the provenance API and scheduler control API to bind one authoritative active run.
- `OOE-700` needs the final schema-three producer and manifest shape before it can select cohorts.
- `OOE-750` needs both producer/control integration and the independently built consumer.
- stable truth/package registration follows verified behavior and converged integration.
- full review follows one exact diff and complete deterministic evidence.

`OOE-100` and `OOE-200` are independent after `OOE-G1`. After `OOE-100`, `OOE-300`, `OOE-400`, and `OOE-600` are mutually independent and may also overlap unfinished `OOE-200`: their production/test write sets are disjoint, and only the latter three consume the frozen contract. They form one flat ready set whenever those factual prerequisites are satisfied; narrative ordering must not create hard edges among them. Serial execution remains a valid capacity fallback.

No delegated implementation has been requested. The plan therefore records parallel eligibility and exact write sets but assigns no execution/reasoning profiles and grants no worker authority. Verification, review adjudication, repair choice, truth acceptance, and the final response remain parent-owned.

## OOE-G0 — Prove active shortcut and overlay compatibility

**Depends on:** explicit user approval to implement this plan

**Execution:** serial mandatory stop-gate; no production repository mutation

**Repository owner:** `pi-extensions` parent

**Write set:** none; use one disposable directory only

**Work:**

- Confirm the approved design hash and installed Pi version before the probe.
- Create a temporary Pi agent directory, session directory, extension, and PTY driver outside the repository.
- Register a deterministic local fake provider that emits one blocking tool call without network access or credentials.
- Register a temporary `Ctrl+Alt+F` shortcut whose handler opens an overlay; make a controlled lifecycle event request a rerender while the tool remains blocked.
- Launch Pi 0.84.4 in a pseudo-terminal with `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE=1`, `--no-extensions`, explicit temporary extension loading, `--no-skills`, `--no-prompt-templates`, and `--no-session` under an explicit minimal environment allowlist.
- Wait on readiness markers rather than sleeps, send the shortcut sequence, verify shortcut dispatch, overlay open, live rerender, clean close, and tool/process settlement, then remove the entire disposable directory.
- Emit only pass/fail booleans and stable failure codes; never print environment, provider configuration, transcript, raw key stream, or temporary paths.

**Verification:**

```bash
sha256sum docs/plans/changes/2026-09-04-subagent-operator-observability-and-evaluation-design.md
pi --version
# Run the disposable PTY probe produced under the implementation session's temporary directory.
git status --short
```

**Done when:**

- the design hash is `ac471461ebdbfd3e36f7636daf9a8135d699b5728f2cb33745cc64fa8396ede1`;
- Pi reports 0.84.4;
- the shortcut and overlay remain interactive and rerender before the blocking tool settles;
- the probe makes no network call, reads no credential, persists no user session, and leaves no repository or agent-directory change.

**Failure policy:** return `needs_design_decision` before any production edit. Do not substitute a queued command, `setWorkingMessage`, `setFooter`, background process, Pi internal API, or live provider.

## OOE-G1 — Preserve the pre-edit dirty-tree baseline

**Depends on:** `OOE-G0`

**Execution:** serial mandatory ownership gate; no repository mutation

**Repository owner:** active parent

**Write set:** none; use one private disposable directory outside both repositories

**Work:**

- Record `git status --porcelain=v2 -z`, HEAD identity, index state, file type/mode, byte length, and SHA-256 for every currently tracked-dirty or untracked path in `pi-extensions` without printing file content or paths outside the final bounded inventory.
- Copy the exact current bytes of every regular dirty/untracked path into a mode-0700 private baseline directory with mode-0600 files; record symlink text without following it and reject special files.
- Bound the baseline to 1,000 paths and 64 MiB total. If either limit is exceeded, stop with `manual_checkpoint` rather than omitting evidence.
- Include the already modified shared package/truth files, untracked session-footer/work-timing files, and the newly authored design/plan artifacts. Do not inspect or snapshot the sibling `agent-skills` worktree; its completed check evidence is already recorded and is not an implementation dependency.
- Keep the baseline until `OOE-900` compares final bytes and changed paths against pre-existing state plus declared task write sets. Remove it only after final evidence is recorded. If the implementation session loses the baseline, stop and re-establish ownership with the user rather than reconstructing prior bytes from the final diff.

**Verification:**

```bash
git status --porcelain=v2
git diff --check
# Verify private baseline manifest/copies and their path/byte ceilings without printing copied content.
```

**Done when:** every pre-existing dirty/untracked path has exact private evidence and no repository, index, worktree, or sibling repository changed.

**Failure policy:** return `manual_checkpoint` for an unbounded/special-file baseline or concurrent user edit during capture. Never stage, reset, stash, commit, or overwrite current work to simplify the baseline.

## OOE-100 — Freeze lifecycle, control, execution-phase, and telemetry contracts

**Depends on:** `OOE-G1`

**Execution:** serial foundation

**Repository owner:** `pi-extensions`

**Locks:** `subagent-public-contract`

**Write set:**

- `extensions/subagents/events.ts` (new)
- `extensions/subagents/contracts.ts`
- `tests/subagents-events.test.ts` (new)
- `tests/subagents-contract.test.ts`

**Red-green work:**

- Add exact constants for the three event names and version-one snapshot/request/receipt DTOs.
- Define run UI phases, bounded task execution phases, aggregate counts, turns, elapsed/inactivity, active fixed-tool names, cancellation-requested state, and receipt outcomes.
- Validate unknown versions, extra fields, unsafe IDs, impossible counts, over-ten task arrays, unknown roles/phases/statuses/tools, negative/nonfinite durations, and malformed cancellation targets before any consumer or core mutation.
- Keep task IDs invocation-local and bounded in active in-memory events; exclude them from completion entries and evaluator output.
- Define `RunTelemetryV3` as the new exact producer shape while retaining every schema-two field and meaning. Add start time, provenance availability/opaque epochs, and optional effective global/per-role caps.
- Keep the model-facing `SubagentToolSchema`, fixed roles, child capability manifest, diagnostic references, and task result compatibility unchanged.
- Add no steer text, prompt, retry, continuation, background, persistence, route/configuration, or UI field to the tool schema.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-events.test.ts tests/subagents-contract.test.ts
npm run typecheck
git diff --check -- extensions/subagents/events.ts extensions/subagents/contracts.ts tests/subagents-events.test.ts tests/subagents-contract.test.ts
```

**Done when:**

- `OOE-A1`, `OOE-A6`, and the contract prerequisites for `OOE-A5`/`OOE-A8` are executable;
- malformed event/control data cannot reach state mutation;
- existing task/result/telemetry-v2 fixtures remain readable where compatibility is required;
- no forbidden content field can be represented by the DTO.

**Recovery:** fix forward inside the contract slice. A need for text control, durable event replay, changed tool input, or schema-two semantic reinterpretation returns `needs_design_decision`.

## OOE-200 — Render reasoning duration and wall-time share

**Depends on:** `OOE-G1`

**Parallel group:** `post-gate-independent`

**Repository owner:** `pi-extensions`

**Locks:** `work-timing-renderer`

**Write set:**

- `extensions/work-timing/index.ts`
- `tests/work-timing.test.ts`

**Red-green work:**

- Change the common settled-entry base rendering to `Worked for <total> • reasoning <duration> (<share>)` in collapsed and expanded states.
- Round the share to the nearest integer percentage, render an unavailable marker when total is zero, and presentation-clamp the share to 0–100 percent without changing stored durations.
- Keep expanded-only `last turn` rendering.
- Add historical/missing-field, zero-total, invalid-duration, and reasoning-greater-than-total fixtures through the existing normalization boundary.
- Preserve version-one entry data, live `Working... R ... / ΣR ... • total ...`, interval cleanup, `agent_settled` timing, context-free persistence, and headless exclusion.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/work-timing.test.ts
npm run typecheck
git diff --check -- extensions/work-timing/index.ts tests/work-timing.test.ts
```

**Done when:** `OOE-A11` passes without a new entry type/version or any subagent import/event dependency.

**Recovery:** fix forward in renderer/tests. Do not infer child reasoning, derive time from tokens, rename `work-timing`, or change the working-row ownership.

## OOE-300 — Implement private effective-revision provenance

**Depends on:** `OOE-100`

**Parallel group:** `operator-foundations`

**Repository owner:** `pi-extensions`

**Locks:** `subagent-provenance-store`, `subagent-config-source`

**Write set:**

- `extensions/subagents/provenance.ts` (new)
- `extensions/subagents/config.ts`
- `tests/subagents-provenance.test.ts` (new)
- `tests/subagents-routing.test.ts`

**Red-green work:**

- Split configuration source reading from parsing so one immutable package/user byte snapshot supplies both the fingerprint and the effective route configuration used by a run.
- Represent user-config absence explicitly in the fingerprint and retain invalid source bytes long enough to assign a configuration epoch before returning the existing typed parse diagnostic; never expose those bytes.
- Fingerprint sorted relative runtime filenames and bytes under the shipped `extensions/subagents/` directory once per loaded core instance. Reject special/symlinked fingerprint inputs as provenance-unavailable without blocking the extension.
- Implement the constant-size current-pair manifest beneath `getAgentDir()` with strict schema, safe private ancestors, regular mode-0600 file, atomic same-directory replacement, and no raw source/configuration content.
- Implement the two-second lock wait, thirty-second stale lease, random owner token, atomic quarantine, pre-replace token check, matching-owner cleanup, and maximum-eight stale artifact cleanup exactly as approved.
- Exercise two concurrent same-fingerprint observers, extension/configuration transitions, transition back to old bytes, invalid config, process crash, stale reclamation, displaced writer, unsafe mode/owner/type/symlink, truncated/corrupt manifest, replacement failure, and cleanup bounds.
- Cache one loaded extension epoch. When another extension epoch supersedes it, reuse only unchanged cached configuration evidence; a changed configuration produces unavailable provenance and cannot mutate the current manifest.
- Expose a narrow injected provenance interface to `OOE-500`; do not import scheduler, UI, evaluator, diagnostics, or route-resolution state.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-provenance.test.ts tests/subagents-routing.test.ts
npm run typecheck
git diff --check -- extensions/subagents/provenance.ts extensions/subagents/config.ts tests/subagents-provenance.test.ts tests/subagents-routing.test.ts
```

**Done when:**

- `OOE-A7` prerequisites pass under deterministic clocks/randomness and real disposable filesystem operations;
- one run cannot parse different config bytes from those represented by its epoch;
- a crash or superseded process cannot overwrite current provenance;
- unavailable provenance does not change route result or extension availability.

**Recovery:** fail provenance closed and fix forward. Never recover with mtime authority, an unbounded history, raw config persistence, unsafe chmod, default-config substitution, or execution failure.

## OOE-400 — Add scheduler-owned task cancellation

**Depends on:** `OOE-100`

**Parallel group:** `operator-foundations`

**Repository owner:** `pi-extensions`

**Locks:** `subagent-scheduler-control`

**Write set:**

- `extensions/subagents/scheduler.ts`
- `tests/subagents-scheduler.test.ts`

**Red-green work:**

- Introduce one run-local synchronous control record that classifies current task status/phase, changes phase, latches task/run cancellation, and aborts one pending/running task without exposing internal maps.
- Make `enterConvergence(taskId)` the atomic linearization point before any convergence await or filesystem apply. It succeeds only when no task cancellation won first; once it succeeds, task cancellation returns `too-late`. Run cancellation always latches aggregate abort, fans out only to tasks outside convergence, and leaves an entered critical section uninterrupted.
- Give each cancellable launched task a derived controller while retaining the external run signal. Run abort fans out through the same control record; task abort affects only its target.
- Add a wake-up mechanism so cancelling a pending task is observed immediately even when the scheduler is awaiting another active promise.
- Mark a cancelled pending task `aborted` with the existing stable cancellation code and no launch. Let ordinary dependency propagation mark its dependents blocked while unrelated ready branches continue.
- Deterministically race task cancellation and run cancellation immediately before/after `enterConvergence`: task cancellation either wins and prevents convergence or loses with `too-late`; run cancellation is accepted in both orders, prevents other launches, and never interrupts entered convergence.
- Ensure repeated cancellation, unknown IDs, already-settled tasks, cancellation racing launch, external run abort, timeout/storage abort, and executor rejection settle exactly once and release locks, role capacity, child counts, heartbeat, and listeners.
- Keep current aggregate compatibility: any aborted task or run cancellation yields aggregate `aborted`; successful/failed non-cancelled behavior is unchanged.
- Own the atomic control/phase transition mechanism here; `OOE-500` reports workspace/child/convergence boundaries through that mechanism and owns the worker operation performed after a successful transition.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-scheduler.test.ts
npm run typecheck
git diff --check -- extensions/subagents/scheduler.ts tests/subagents-scheduler.test.ts
```

**Done when:** scheduler state-transition evidence covers the mechanical part of `OOE-A5`, including dependency blocking and unrelated continuation, without a control queue or durable state.

**Recovery:** fix forward against one minimal graph fixture. Do not cancel unrelated tasks, manufacture dependency success, retry, roll back siblings, or weaken cleanup waiting.

## OOE-500 — Integrate lifecycle events, cancellation, provenance, and telemetry v3

**Depends on:** `OOE-300`, `OOE-400`

**Execution:** serial core convergence

**Repository owner:** `pi-extensions`

**Locks:** `subagent-entrypoint`, `subagent-active-run`, `subagent-telemetry`

**Write set:**

- `extensions/subagents/activity.ts` (new)
- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `tests/subagents-extension.test.ts`
- `tests/subagents-render.test.ts`
- `tests/subagents-host-contract.test.ts`

**Red-green work:**

- Capture the loaded extension epoch when the extension factory initializes and capture one coherent configuration source snapshot/provenance result for every tool invocation without changing graph/trust/admission/config error precedence.
- Populate schema-three telemetry on graph rejection, trust failure, active-run rejection, repository admission failure, relational validation failure, prompt bound failure, invalid config/route, diagnostic failure, scheduler outcome, cancellation, and unexpected runtime failure.
- Preserve all schema-two counters and add start time, provenance availability/epochs, and effective caps only when the exact used config is valid.
- Build bounded full activity snapshots from authoritative scheduler results and execution-phase state. Emit at accepted start, every scheduler update/activity callback/heartbeat, cancellation-affecting transition, and final aggregation.
- Track queued, workspace preparation, child execution, convergence critical section, and settled phase through the scheduler-owned synchronous control record without including workspace or path data. Call atomic convergence entry before any convergence await/apply; if task cancellation already won, skip convergence, clean up, and return aborted.
- Listen for validated current-run cancellation requests. Return negative receipts for malformed/stale/unknown/already-settled targets; return task `too-late` during convergence; otherwise invoke scheduler task control or the existing run controller and emit an immediate receipt plus updated snapshot.
- On run cancellation, atomically latch aggregate abort, stop scheduling and cancellable branches, exclude a worker whose convergence entry already won, await all process/workspace/diagnostic cleanup, and preserve an aborted aggregate. Race fixtures must prove both event orders.
- Check task cancellation after worker workspace creation and before child launch so a latched preparation-phase request cleans the workspace and never launches. Keep convergence non-interruptible.
- Treat event publication as an optional projection: absence of listeners or a validated consumer does not affect execution. Ensure the package-owned listener never throws into the core path.
- Extend `/subagents` with bounded active-run and provenance-availability evidence without printing epochs, fingerprints, task IDs, config content, or paths.
- Preserve existing tool name, commands, progress/result bounds, diagnostics, routes, capability guard, one-active-run rule, worker CAS convergence, `tool_result` error mapping, Escape behavior, and shutdown waiting.

**Focused verification:**

```bash
node --experimental-strip-types --test \
  tests/subagents-events.test.ts \
  tests/subagents-extension.test.ts \
  tests/subagents-render.test.ts \
  tests/subagents-host-contract.test.ts \
  tests/subagents-scheduler.test.ts \
  tests/subagents-provenance.test.ts
npm run typecheck
git diff --check -- extensions/subagents/activity.ts extensions/subagents/index.ts extensions/subagents/render.ts tests/subagents-extension.test.ts tests/subagents-render.test.ts tests/subagents-host-contract.test.ts
```

**Done when:**

- `OOE-A1`, `OOE-A5`, `OOE-A6`, and `OOE-A8` pass through the real extension integration seam;
- every failure path has schema-three provenance semantics and no sensitive projection;
- cancellation receipts and final result semantics remain distinct;
- shutdown leaves no child, timer, listener-owned run state, workspace, or active diagnostic marker.

**Recovery:** fix forward in the owning integration surface. A need to modify child stdin, Pi internals, route config, convergence atomicity, or result authority returns `needs_design_decision`.

## OOE-600 — Build the independent TUI consumer

**Depends on:** `OOE-100`

**Parallel group:** `operator-foundations`

**Repository owner:** `pi-extensions`

**Locks:** `subagents-ui`

**Write set:**

- `extensions/subagents-ui/index.ts` (new)
- `extensions/subagents-ui/component.ts` (new)
- `extensions/subagents-ui/render.ts` (new)
- `tests/subagents-ui.test.ts` (new)

**Red-green work:**

- Register event listeners, `/subagents-ui`, `Ctrl+Alt+F`, and custom entry renderer without importing runtime implementation state.
- Validate every snapshot/receipt through the frozen shared contract. Ignore malformed, unknown-version, stale-run, regressing, or post-final snapshots without throwing or retaining partial state.
- Capture TUI context only in TUI mode. Keep RPC/JSON/print modes free of status, widget, overlay, shortcut action, timers, and completion entries.
- Render keyed footer status `csheng.subagents.status` with active/total, aggregate turns, and elapsed. Render a bounded `belowEditor` panel `csheng.subagents.panel` with active task summaries and an overflow count.
- Implement an overlay with at most ten tasks, bounded scrolling/selection, current receipt, close behavior, and live rerender on new snapshots. Show only approved activity fields.
- Require explicit confirmation before emitting a run or task cancellation request. Bind each request to current run/target plus a fresh request ID and display receipt status without claiming final cancellation.
- Append exactly one version-one `csheng-subagents-run` entry for each final snapshot in TUI mode. Omit task IDs and retain only approved aggregate projection fields. Make duplicate final snapshots idempotent.
- Clear keyed status/widget and close/release overlay state on final snapshot, session switch, reload, or shutdown. Closing the overlay alone never cancels work.
- Prove neither source nor fake UI calls `setWorkingMessage` or `setFooter`.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-ui.test.ts
npm run typecheck
git diff --check -- extensions/subagents-ui/index.ts extensions/subagents-ui/component.ts extensions/subagents-ui/render.ts tests/subagents-ui.test.ts
```

**Done when:** `OOE-A2`, `OOE-A3`, and component prerequisites for `OOE-A4`/`OOE-A5` pass without the core extension loaded.

**Recovery:** fix forward inside the UI extension. Do not import active controller/scheduler objects, add polling, persist active state, expose content/path/model data, or take over shared unkeyed UI surfaces.

## OOE-700 — Add explicit current-epoch multi-session evaluation

**Depends on:** `OOE-500`

**Parallel group:** `post-core-consumers`

**Repository owner:** `pi-extensions`

**Locks:** `subagent-evaluator-contract`

**Write set:**

- `.agents/skills/evaluate-subagent-runs/SKILL.md`
- `.agents/skills/evaluate-subagent-runs/references/metric-schema.md`
- `.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts`
- `tests/subagents-evaluator.test.ts`

**Red-green work:**

- Refactor parsing into bounded run-record extraction plus selected-record aggregation so one cohort owns every numerator and denominator.
- Preserve exact-session path/ID resolution and schema-one/two/legacy evidence, but hard-cut evaluator output to metric schema three with an explicit selection-mode source contract.
- Add a mutually exclusive current-epoch CLI mode requiring an exact sessions root and exact provenance-manifest path. Never default either filesystem path and never accept current-epoch mode with `--session`.
- Validate the manifest as a regular non-symlink private file beneath private non-symlink ancestors, consume only its current opaque epoch IDs and activation times, and never emit its path, fingerprints, or IDs.
- Traverse without following symlinks, enforce every approved depth/entry/file/byte/line/run/key/output limit, stream JSONL, and fail the whole call before stdout/output-file success when any bound or parse rule fails.
- Select only schema-three runs matching both epochs and starting at or after the later activation. Count scanned/matched sessions and selected/excluded/provenance-unavailable runs without listing session identities or excluded details.
- Return authoritative zero aggregates when no run matches. Never fall back to latest observed, mtime-only, telemetry v1/v2, legacy prose, assistant tool arguments, or an older epoch.
- Keep exclusive mode-0600 report writes and refusal to overwrite.
- Add effective-cap aggregates while keeping semantic plan eligibility explicitly unavailable. Do not infer a conservative plan, omitted worker, or runtime underuse from requested width, hard edges, caps, or peak alone.
- Update the Skill default interpretation: exact named session stays exact; current installed/configured health requires explicitly authorized current-epoch inputs; missing root/manifest authority stops for clarification.
- Retain all existing redaction sentinels and add fingerprints, epoch IDs, activation paths, session paths, task IDs, raw configuration, objectives, child output, stderr, selectors, and excluded-run content.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-evaluator.test.ts
npm run typecheck
node --experimental-strip-types .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts --help
git diff --check -- .agents/skills/evaluate-subagent-runs tests/subagents-evaluator.test.ts
```

**Done when:** `OOE-A9` and `OOE-A10` pass, exact-session compatibility remains explicit, and current-epoch mode cannot read an implicit or widened input set.

**Recovery:** fix forward against disposable sessions/manifests. Do not weaken bounds, emit partial metrics, inspect Pi SQLite/settings/credentials/diagnostics, or infer missing provenance.

## OOE-750 — Verify cross-extension UI and control integration

**Depends on:** `OOE-500`, `OOE-600`

**Parallel group:** `post-core-consumers`

**Repository owner:** `pi-extensions`

**Locks:** `subagents-ui-integration`

**Write set:**

- `tests/subagents-ui-integration.test.ts` (new)
- `tests/session-id-footer.test.ts`

**Work:**

- Instantiate the core producer and UI consumer on one fake Pi event bus and prove initial/running/heartbeat/final snapshots produce the expected keyed surfaces and one settled custom entry.
- Exercise confirmed pending/running task and whole-run cancellation end to end, including receipt-before-final semantics, dependent blocking, unrelated continuation, convergence `too-late`, and run cancellation while a sibling converges.
- Prove disabling either extension leaves the other safe and that headless contexts execute the core without TUI state.
- Exercise `session-id-footer` with `csheng.subagents.status` present and prove the built-in footer status projection and session ID remain visible without a second footer owner.
- Assert no call reaches `setWorkingMessage` from UI/core and no call reaches `setFooter` outside `session-id-footer`.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-ui-integration.test.ts tests/subagents-ui.test.ts tests/session-id-footer.test.ts
npm run typecheck
git diff --check -- tests/subagents-ui-integration.test.ts tests/session-id-footer.test.ts
```

**Done when:** `OOE-A2` through `OOE-A5` pass across the real shared event contract and independent removal paths.

**Recovery:** fix forward in integration fixtures or the already owned producer/consumer slice. Any required direct extension import, shared mutable singleton, working-row/footer takeover, or background controller returns `needs_design_decision`.

## OOE-800 — Register the extension and synchronize stable truth

**Depends on:** `OOE-200`, `OOE-700`, `OOE-750`

**Execution:** serial parent-owned convergence

**Repository owner:** `pi-extensions`

**Locks:** `package-surface`, `stable-truth`, `dirty-worktree-convergence`

**Write set:**

- `package.json`
- `tests/package.test.ts`
- `tests/repository-boundary.test.ts`
- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`
- `docs/architecture/subagents-ui.md` (new)

**Work:**

- Add `./extensions/subagents-ui/index.ts` as the eighth packaged extension without renaming or reordering existing compatibility identifiers unnecessarily.
- Extend package/boundary tests for the new independently removable entry and prohibit forbidden imports or lifecycle ownership.
- Merge only this milestone's truth into the already modified `AGENTS.md`, `README.md`, package, and test surfaces; preserve all unrelated user edits and current session-footer/work-timing work.
- Document event/control ownership, TUI surfaces and keys, custom entry type, shortcut/overlay semantics, explicit cancellation receipts, critical-section behavior, and no steer/continuation.
- Document the provenance directory/manifest, generated-runtime-not-project-truth status, unavailable behavior, removal semantics, telemetry schema three, exact/current-epoch evaluator modes, scan authorization/bounds, and schema-one/two exact-session compatibility.
- State that plan eligibility remains unavailable without explicit approved-plan evidence and that the separate `agent-skills` clarification changes plan prose only, not runtime authority.
- Update work-timing truth to show collapsed total/reasoning/share and expanded last-turn evidence while preserving parent-only reasoning semantics and Working-row ownership.
- Record community Fleet/control ideas as inspiration only if useful to explain the selected boundary; do not add a runtime dependency, copied code, or volatile capability catalogue to stable truth.

**Focused verification:**

```bash
node --experimental-strip-types --test \
  tests/package.test.ts \
  tests/repository-boundary.test.ts \
  tests/subagents-ui-integration.test.ts \
  tests/session-id-footer.test.ts \
  tests/work-timing.test.ts \
  tests/subagents-evaluator.test.ts
python3 /home/csheng/.agents/skills/organize-docs/scripts/normalize-markdown-prose.py \
  --root "$(git rev-parse --show-toplevel)" \
  --mode check \
  --immutable-manifest contracts/markdown-prose.toml
bash /home/csheng/.agents/skills/organize-docs/scripts/check-doc-boundaries.sh
git diff --check
```

**Done when:** `OOE-A12` truth/package prerequisites pass and every stable statement describes executable behavior rather than planned behavior.

**Recovery:** stable truth follows verified runtime. Repair runtime or return to design; do not document aspirational behavior, overwrite unrelated changes, or rewrite historical plans.

## OOE-900 — Run complete verification and bounded implementation review

**Depends on:** `OOE-800`

**Execution:** serial parent-owned verification, adjudication, and closeout

**Repository owner:** `pi-extensions`

**Locks:** `full-verification`, `implementation-review`, `final-diff`

**Write set:** none unless one accepted review finding is repairable inside an earlier declared write set

**Conditional focused-repair surface:** exact production, test, evaluator, package, and stable-truth files already owned by `OOE-100` through `OOE-800`. A new dependency, config field, global setting, script, package source, Pi core patch, or user-state path requires plan/design revision.

**Work:**

- Reconfirm design hash, implementation authority, Pi version, and complete dirty-tree inventory.
- Compare the final `pi-extensions` state with the private `OOE-G1` baseline. Every post-baseline byte change must belong to a declared task write set, while every unrelated pre-existing byte must remain preserved. Treat later user edits as a new ownership checkpoint rather than a failure. Do not make the sibling `agent-skills` worktree a blocking final input; rely on its already recorded generation/check evidence.
- Run focused suites together, then clean dependency installation and the repository-owned complete deterministic gate.
- Run required temporary and installed plan-mode, subagent, and Herdr probes. Do not run multi-skill mention probes or live subagent E2E without separate provider-call authority.
- Run docs boundaries and `git diff --check`.
- Perform one bounded independent `review-change`/`review-implementation` evaluation over the approved design, approved plan, exact converged implementation diff, and verification evidence.
- Parent-adjudicate every material candidate. Apply at most one focused in-scope repair, then rerun affected focused checks, the complete gate, required offline probes, docs checks when touched, and diff checks.

**Complete deterministic verification:**

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
python3 /home/csheng/.agents/skills/organize-docs/scripts/normalize-markdown-prose.py \
  --root "$(git rev-parse --show-toplevel)" \
  --mode check \
  --immutable-manifest contracts/markdown-prose.toml
bash /home/csheng/.agents/skills/organize-docs/scripts/check-doc-boundaries.sh
git diff --check
git status --short
```

**Done when:**

- `OOE-A1` through `OOE-A12` pass;
- the real-host gate evidence remains valid for Pi 0.84.4;
- the final path/byte comparison against `OOE-G1` proves declared implementation outputs are present and unrelated pre-existing user changes are preserved, after which the private baseline is removed;
- no accepted review finding remains after zero or one focused repair;
- exact changed paths and preserved pre-existing work are distinguishable;
- no provider call, Pi installation, route/config mutation, real session/provenance/diagnostic mutation, commit, push, publication, or deployment occurred.

**Recovery:** fix forward in the task owning the failure and rerun its focused plus complete evidence. Return `needs_plan_change` for an undeclared file/dependency or `needs_design_decision` for event, cancellation, provenance, evaluator, privacy, or TUI-host boundary failure. One non-convergent repair returns `non-convergent`; it does not authorize a second review loop.

## Work-package readiness

- `milestone_objective`: independent active subagent observability/control, current-effective-revision evaluation, and reasoning-share display under the existing foreground runtime.
- `non_goals`: steer, continuation, background orchestration, in-process children, dynamic roles, community runtime dependency, plan parsing, second working/footer owner, provider calls, installation, publication, and deployment.
- `oracle_strategy`: real-host PTY gate, contract examples, scheduler model tests, filesystem/concurrency provenance tests, streaming cohort integration, fake-TUI components, redaction negatives, package probes, and one implementation review.
- `acceptance_oracles`: `OOE-A1` through `OOE-A12` and each task's focused commands.
- `review_budget`: one completed design review, one plan review before approval, one implementation review after convergence, and at most one focused repair at each review point.
- `failure_policy`: stop before production edits if the active TUI gate fails; otherwise fail closed for control/provenance/evaluator authority and fix forward inside owned slices.
- `parallel_policy`: `OOE-100` and `OOE-200` are independently ready after the shared `OOE-G1` baseline; after `OOE-100`, `OOE-300`, `OOE-400`, and `OOE-600` are mutually independent and may overlap `OOE-200`; `OOE-700` and `OOE-750` form the post-core flat group. Their write sets are disjoint, `events.ts` remains owned only by `OOE-100`, and every serial edge has the stated causal prerequisite.
- `subagent_ready`: false because the user requested design/plan, not delegated implementation. A later approved execution may reassess exact slices without changing factual dependencies or delegating parent-owned convergence.
- `external_prerequisites`: none after the no-network Pi 0.84.4 gate passes. Credentials and live provider access are neither required nor authorized.
- `approval_status`: pending; design approved, implementation authority false.

## Execution continuity and contingencies

After explicit implementation approval, expected continuous ranges are:

- `E1`: `OOE-G0` host gate, `OOE-G1` dirty-tree baseline, and the independently ready `OOE-100` contract foundation/`OOE-200` timing slice;
- `E2`: independent `OOE-200` timing plus, after the contract foundation, the flat `OOE-300`, `OOE-400`, and `OOE-600` slices;
- `E3`: `OOE-500` core convergence;
- `E4`: independent `OOE-700` evaluator and `OOE-750` UI integration;
- `E5`: `OOE-800` truth/package convergence and `OOE-900` final verification/review.

Typed contingencies:

- `X1 = active_tui_contract_unavailable`: shortcut/overlay cannot open and rerender during active foreground work on Pi 0.84.4.
- `X2 = event_contract_leaks`: bounded snapshots/receipts require prohibited content or listener failure can affect execution.
- `X3 = cancellation_non_convergent`: pending/running task cancellation cannot settle once, preserve unrelated branches, or protect convergence.
- `X4 = provenance_race`: stale/superseded writers can overwrite the current pair or coherent config bytes cannot be tied to the run.
- `X5 = provenance_storage_unavailable`: private atomic constant-size state cannot be maintained without widening user-state authority.
- `X6 = evaluator_unbounded`: exact current-epoch selection cannot remain streaming, redacted, explicitly authorized, and fail closed under all limits.
- `X7 = ui_ownership_conflict`: the required experience needs `setWorkingMessage`, `setFooter`, direct runtime imports, polling, or persisted active state.
- `X8 = dirty_tree_conflict`: shared package/truth files cannot preserve pre-existing user changes without an ownership decision.
- `X9 = scope_expansion_required`: implementation needs a new dependency, global/user config change, Pi core patch, provider call, install, or undeclared persisted surface.
- `X10 = non_convergent`: one accepted implementation repair does not restore focused and complete verification.

`X1`, `X3`, `X4`, `X6`, or `X7` returns `needs_design_decision`. `X8` or an undeclared but design-consistent file returns `needs_plan_change` or `manual_checkpoint`. No contingency authorizes hidden fallback, historical cohort widening, child steering, cancellation rollback, destructive reset, or another repair loop.

## Recovery and authority boundary

Default recovery is fix forward. The milestone adds no migration that rewrites old session/tool results: telemetry schema one and two remain exact-session-readable, new runs hard-cut to schema three, and the current-epoch mode simply excludes old/unavailable provenance. The provenance manifest stores only the current pair and can be explicitly removed by the user; removal makes current-epoch evaluation unavailable until the runtime safely recreates it.

Cancellation does not roll back successful or converged work. A cancelled run preserves final task states and started-child diagnostics so the parent can decide fix-forward action. The UI custom entry is a projection and can disappear with extension removal without losing authoritative tool results.

Plan approval, when granted, will authorize only declared repository write sets and disposable verification state. It will not authorize modification of real Pi settings, routes, credentials, parent sessions, diagnostics, or provenance; the real provenance path may be exercised only through a separately authorized installed/runtime probe. Deterministic repository tests use disposable agent/session roots.

## Truth-sync handoff

`OOE-800` owns stable product truth only after focused runtime and integration evidence passes. Historical design/plan artifacts remain stage evidence and are not runtime inputs. The new design supersedes only current stable statements about tool-row-only observability, telemetry schema two as the newest producer, one-session-only evaluation, no dedicated cancellation UI, and collapsed timing entries omitting reasoning.

The separate `agent-skills` source/generated change is already verified but uncommitted. It remains a sibling-repository truth change owned by that repository and is not copied into `pi-extensions` docs beyond the bounded cross-repository fact needed to explain plan-eligibility semantics.

## Plan review decision

A bounded independent plan review was required because execution order must protect a real-host stop-gate, shared event/telemetry contracts, task cancellation and convergence, cross-process provenance, bounded multi-session input, independent UI ownership, dirty-tree convergence, and parent-owned verification. The reviewer returned `needs revision before implementation approval` with four material findings. Parent adjudication accepted all four and applied one focused design/plan repair:

- the design and `OOE-400`/`OOE-500` now define one synchronous control-record linearization point at convergence entry and require deterministic task/run cancellation races in both event orders;
- new mandatory `OOE-G1` captures a bounded private byte-for-byte baseline of all pre-existing dirty/untracked `pi-extensions` paths before edits and makes final preservation mechanically comparable;
- `events.ts` is now written only by contract-freezing `OOE-100`; core snapshot construction moves to `activity.ts`, preserving the contract consumed concurrently by `OOE-600`;
- the sibling `agent-skills` worktree is no longer a final blocking input; its completed generation/check evidence remains recorded without granting ongoing external-read authority.

Rechecking task scope, dependency causes, parallel write sets, control linearization, baseline ownership, oracle placement, authority, recovery, truth sync, and final evidence yields `pass`. No material plan finding remains; `review_status = passed_after_repair`.

## Approval request

`decision_state = ready_for_approval`. Approving this plan would authorize repository-local implementation only across the declared `pi-extensions` write sets and disposable no-network verification fixtures. It would not authorize provider calls, Pi installation, mutation of real user configuration/sessions/diagnostics/provenance, commit, push, publication, or deployment.
