+++
artifact_kind = "plan"
contract_version = 1
design_ref = "2026-09-02-subagent-observability-and-diagnostic-sessions-design.md"
design_sha256 = "1bb1ea46e94ad56fb7c05f5a6f82fa5fde20c099dcf917cd576b279b6b16242c"
design_approval_status = "approved"
approval_status = "approved"
decision_state = "decided"
implementation_authority = true
implementation_status = "verified"
implementation_review_status = "passed_after_repair"
truth_sync_required = true
truth_sync_status = "completed"
parallel_execution_proposed = true
plan_review_required = true
plan_review_status = "passed_after_revision"
implementation_review_required = true
+++
# Subagent observability and diagnostic sessions implementation plan

## Milestone objective

Implement the approved scope formalized by `2026-09-02-subagent-observability-and-diagnostic-sessions-design.md`: persist one standard Pi session JSONL per launched child under the dedicated parent/run/task hierarchy, keep those sessions out of ordinary `/resume`, provide a user-only read-only diagnostic timeline, propagate bounded live child activity and heartbeat updates to the parent, and fail a Pi-settled child that does not close within a short grace period.

The milestone changes diagnostic evidence and liveness only. It preserves the foreground in-memory scheduler, fixed roles, route resolution, graph admission, worker snapshots, convergence, parent authority, telemetry schema two, evaluator metric schema two, and package independence.

## Approval and prerequisite state

The user approved the repaired design and this plan and explicitly requested repository mutation on 2026-09-02. Independent design and plan review findings are incorporated in the frozen decisions below.

No account, login, credential, license, remote, or physical prerequisite blocks deterministic implementation. Pi 0.84.4 is the current documented and installed development baseline. Provider calls are unnecessary for deterministic acceptance.

The working tree already contains unrelated in-progress Herdr work, including modifications to `AGENTS.md`, `README.md`, package surfaces, tests, and new files. Implementation must preserve it byte-for-byte outside causally shared truth edits. Stable-truth convergence is parent-owned and serial; if the two approved changes cannot be merged without changing the Herdr design, stop with `manual_checkpoint` rather than overwrite or reset either change.

This plan does not authorize provider calls, Pi/package installation, user route-file mutation, global settings changes, commit, push, publication, deployment, or deletion of existing diagnostic sessions.

## Frozen design decisions

- Root: `<getAgentDir()>/subagent-sessions/<parent-session>/<run>/<task>.jsonl`; the normal path is `~/.pi/agent/subagent-sessions/...`.
- Launch: retain `--mode json -p`, omit `--no-session`, and pass one explicit pre-created private `--session` path.
- Discovery: ordinary `/resume` remains unchanged because the diagnostic root is outside Pi's default `sessions/` tree.
- Inspection: `/subagents-debug [reference|--all]` reads metadata only and never opens, migrates, resumes, deletes, or copies raw session content into model context. Discovery is capped at 20 scopes; exact task streaming accepts at most 1 MiB per line and renders at most 200 timeline entries and 64 KiB.
- Explicit escape hatch: a user may run `pi --session <path>` or browse a run directory, accepting that Pi opens an ordinary continuable session and that a worker's original snapshot is gone.
- Retention defaults: thirty days, a 512 MiB total-root admission ceiling, 32 MiB per child file, and a reserved 256 MiB allowance per run.
- Cleanup and admission: under an extension-owned cross-process allocation/cleanup lock, every active or stale-active marker reserves 256 MiB. Expired then oldest settled runs are pruned until settled bytes plus existing reservations plus one new reservation fit beneath 512 MiB. Stale markers remain visible and reserve capacity until explicit user action.
- Liveness: project only bounded event metadata, send event-driven updates plus one five-second run heartbeat, and expose elapsed/inactivity evidence without raw payloads.
- Settlement: `agent_end` is informative only; `agent_settled` starts a ten-second process-exit grace; failure to close uses existing TERM then five-second KILL escalation and returns `child_exit_stalled`. A first-cause-latched typed cancellation reason preserves user-abort, timeout, diagnostic-limit, and exit-stall precedence.
- Storage failure: never fall back to an unrecorded child or truncate a Pi session; return typed diagnostic storage failures and preserve existing bytes.
- Durability boundary: session files are retained evidence, not durable graph, workspace, lock, retry, convergence, or mission state.
- Schema compatibility: add task-level diagnostic/activity fields without changing runtime telemetry schema two or evaluator metric schema two.

A change to any frozen value, fallback behavior, resume boundary, or raw-content policy requires plan or design revision rather than opportunistic implementation.

## Oracle strategy

Use red-green contract, security-sensitive filesystem, protocol state-transition, controlled subprocess, scheduler/component, host-update, and read-only inspection tests. The protected boundary is new and stateful; exact examples plus state-transition matrices are stronger than snapshots or prose tests. No live provider is needed.

| Protected boundary | Oracle | Fixture/environment | Owning suite | Failure diagnosis owner |
| --- | --- | --- | --- | --- |
| Diagnostic result/activity contract | Type and schema examples | In-memory task fixtures | `tests/subagents-contract.test.ts` | contract owner |
| Event projection and settlement signals | Protocol state-transition table | Fragmented/coalesced synthetic JSONL | `tests/subagents-protocol.test.ts` | protocol parser |
| Private path and retention policy | Filesystem security/property examples | Disposable agent directory, symlinks, modes, fake clock | `tests/subagents-diagnostics.test.ts` | diagnostic store |
| Pi child launch and close behavior | Controlled subprocess integration | Extended fake Pi modes | `tests/subagents-runner.test.ts` | runner |
| Parent progress and heartbeat | Scheduler/component examples | Injected clock and controlled child callbacks | scheduler/extension tests | scheduler and entrypoint |
| User-only read-only inspection | Command component examples | Versioned session fixtures and byte-identical checks | diagnostics/extension tests | diagnostic reader/command |
| Pi host rerender seam | Host contract plus onUpdate observation | Public extension runtime and fake tool execution | extension/host tests | entrypoint/host adapter |
| Redaction and schema stability | Negative contract examples | Sensitive sentinel fixtures | evaluator/render/probe tests | evaluator and renderer |
| Stable truth | Review plus doc-boundary and diff checks | Current repository | full gate | parent truth-sync owner |

Oracle edits that delete negative path cases, weaken exact error codes, broaden permissions, remove byte bounds, accept raw content, treat `agent_end` as final, or replace event-driven assertions with sleeps require explicit review. Timing tests use injected clocks or readiness signals; fixed sleeps are not completion evidence.

## Acceptance trace

| Acceptance ID | Requirement | Owner task | Primary evidence |
| --- | --- | --- | --- |
| SOD-A1 | Every launched child receives one private explicit Pi session path and no `--no-session` | `SOD-300`, `SOD-400` | argv plus disposable-session fixture |
| SOD-A2 | Ordinary default session listing omits child sessions while exact files remain valid Pi sessions | `SOD-300`, `SOD-400` | isolated public SessionManager/listing fixture |
| SOD-A3 | Existing/missing ancestors, ownership, modes, symlinks, traversal, and collision behavior fail safely | `SOD-300` | filesystem security matrix |
| SOD-A4 | Retention and child/run limits bound storage without deleting active sessions or truncating files | `SOD-300`, `SOD-500` | fake-clock/byte-budget fixtures |
| SOD-A5 | Child lifecycle/tool events become bounded activity without raw payload leakage | `SOD-200` | protocol transition/redaction matrix |
| SOD-A6 | Parent receives progress before process close and every five seconds while quiet | `SOD-400`, `SOD-500` | controlled callback and heartbeat fixtures |
| SOD-A7 | `agent_end` does not terminate; `agent_settled` starts grace; close stall returns typed failure | `SOD-400` | fake subprocess modes with readiness signals |
| SOD-A8 | Success, failure, abort, timeout, and close-stall outcomes preserve started-child sessions | `SOD-400` | disposable child-session fixtures |
| SOD-A9 | `/subagents-debug` can rediscover current, ephemeral, and crashed-parent sessions and reads exact files without mutation | `SOD-300`, `SOD-500` | byte-identical command and `--all` fixtures |
| SOD-A10 | Model-visible content, progress, evaluator output, and probes expose no session path or raw child content | `SOD-500`, `SOD-600` | sentinel-negative tests and probes |
| SOD-A11 | Escape/shutdown still await child/workspace cleanup while preserving diagnostics and clearing heartbeat/markers | `SOD-500` | delayed cleanup fixture |
| SOD-A12 | Stable truth, package behavior, and independent extensions remain coherent | `SOD-600` | full deterministic gate and implementation review |

## Task graph

```text
preflight -> SOD-100
               ├── SOD-200 protocol projection ─┐
               └── SOD-300 diagnostic store ────┼── SOD-400 runner integration
                                                └── SOD-500 parent integration
                                                     └── SOD-600 truth, full verification, review
```

`SOD-200` and `SOD-300` are safely independent after `SOD-100`: they have disjoint source/test write sets, use only frozen contracts, and share no runtime resource. They may run concurrently; serial execution is a valid fallback. `SOD-400` is the first convergence point. `SOD-500` and `SOD-600` remain serial and parent-owned because they integrate active-run state, renderer behavior, stable truth, unrelated working-tree edits, verification, and review adjudication.

No delegated implementation has been requested. The plan records parallel eligibility but does not grant child mutation authority or prescribe model routes.

## Preflight — Reconfirm host, artifact, and dirty-tree boundaries

**Depends on:** approved design, approved plan, explicit implementation request

**Mutation authority:** none before preflight passes

**Work:**

- Confirm the design bytes still match the recorded SHA-256.
- Confirm Pi remains 0.84.4 and the repository dependency baseline still targets the same public contracts.
- Record the complete working-tree status and isolate unrelated Herdr modifications from this milestone's writes.
- Run the current deterministic suite before adding regression oracles. Existing success does not disprove the observed liveness gap because that path has no current test.
- Confirm no pre-existing `<agent-dir>/subagent-sessions/` path must be altered during repository tests; all tests use a disposable agent directory.

**Commands:**

```bash
sha256sum docs/plans/changes/2026-09-02-subagent-observability-and-diagnostic-sessions-design.md
pi --version
git status --short
npm ci --ignore-scripts
npm run check
```

**Done when:**

- The design hash is `557824eba59f6cc281e3a4000ae4c29695655a1b9bb3376e6ecf3effce40bab0`.
- Pi reports 0.84.4.
- Baseline failures, if any, are causally classified and do not overlap this milestone's oracle.
- No unrelated file will be reset, deleted, overwritten, staged, or committed.

**Failure policy:** return `needs_design_decision` for a changed Pi persistence/event contract, `needs_plan_change` for artifact or write-set drift, and `manual_checkpoint` for an unrelated working-tree conflict that prevents safe convergence.

## SOD-100 — Freeze diagnostic and activity contracts

**Depends on:** preflight

**Execution:** serial foundation

**Repository owner:** `pi-extensions`

**Locks:** `subagent-public-contract`

**Write set:**

- `extensions/subagents/contracts.ts`
- `tests/subagents-contract.test.ts`

**Red-green work:**

- Add failing type/runtime examples for safe relative diagnostic references, bounded activity phases, active tool names, turn counts, elapsed/inactivity values, and storage/exit error codes.
- Add package-owned constants for five-second heartbeat, ten-second settled-exit grace, thirty-day retention, 512 MiB total root, 32 MiB child session, 256 MiB run reservation/session limit, 20 discovered scopes, 200 timeline entries, 1 MiB input lines, and 64 KiB rendered diagnostic output.
- Extend `TaskResult` only with optional diagnostic/activity evidence so historical parent tool results remain readable.
- Keep raw paths, event payloads, prompts, outputs, and error text out of the activity type.
- Keep `TELEMETRY_SCHEMA_VERSION = 2`; add no evaluator metric field.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-contract.test.ts
npm run typecheck
git diff --check -- extensions/subagents/contracts.ts tests/subagents-contract.test.ts
```

**Done when:**

- `SOD-A1`, `SOD-A5`, and schema-compatibility prerequisites are executable.
- Existing task/result fixtures compile unchanged when new optional fields are absent.
- Diagnostic references cannot represent absolute paths or parent traversal.
- No model-facing task input or route configuration field is added.

**Recovery:** fix forward in this slice. Any need to change telemetry version, task input schema, or routing semantics returns `needs_design_decision`.

## SOD-200 — Project child JSON events into bounded liveness state

**Depends on:** `SOD-100`

**Parallel group:** `observability-foundations`

**Repository owner:** `pi-extensions`

**Locks:** `subagent-json-protocol`

**Write set:**

- `extensions/subagents/protocol.ts`
- `tests/subagents-protocol.test.ts` (new)

**Red-green work:**

- Build a table of fragmented and coalesced events covering session header, agent/turn/message lifecycle, tool start/update/end, assistant success/error/aborted stop reasons, retry-shaped multiple `agent_end` events, `agent_settled`, malformed lines, and unknown future events.
- Add an optional activity callback and immutable bounded snapshot while preserving current final output/usage parsing.
- Refresh liveness on every valid JSON object, but copy only approved event type, fixed-role tool name, stop reason, counts, and booleans.
- Track active tools by call ID internally so overlapping starts/ends settle correctly; expose only bounded deduplicated tool names.
- Prove sensitive sentinel payloads never appear in a snapshot or callback.
- Make `agent_end` set settling evidence without finality; make `agent_settled` the sole semantic-settlement signal.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-protocol.test.ts
npm run typecheck
git diff --check -- extensions/subagents/protocol.ts tests/subagents-protocol.test.ts
```

**Done when:**

- `SOD-A5` and the protocol prerequisites for `SOD-A6`/`SOD-A7` pass.
- Existing fragmented assistant output and usage behavior is unchanged.
- Unknown well-formed events refresh activity but cannot widen the projection.
- The parser owns no timers, process signals, filesystem path, or final task status.

**Recovery:** fix forward with the smallest event sequence. Do not retain raw JSON, add a golden transcript, or infer final status from `agent_end`.

## SOD-300 — Implement the private diagnostic store and read-only inspector

**Depends on:** `SOD-100`

**Parallel group:** `observability-foundations`

**Repository owner:** `pi-extensions`

**Locks:** `subagent-diagnostic-store`, `subagent-retention-lock`

**Write set:**

- `extensions/subagents/diagnostics.ts` (new)
- `tests/subagents-diagnostics.test.ts` (new)

**Red-green work:**

- Use a disposable agent directory and fake clock for root/parent/run/task creation, safe segment mapping, permissions, ownership checks where portable, exclusive collisions, and exact relative references.
- Add malicious fixtures for symlinked root/parent/run paths, non-directories, unsafe ownership/modes, traversal-like references, and replacement attempts.
- Implement allocation and cleanup locking that serializes extension-owned root admission across Pi processes without reading settings or credentials.
- Create/remove active markers, skip active runs, prune expired settled runs, then prune oldest settled runs until settled bytes plus active/stale reservations plus a prospective 256 MiB run reservation fit beneath the 512 MiB total-root ceiling.
- Enforce 32 MiB child and 256 MiB run observations without truncating files; return typed capacity decisions to callers.
- Add current-parent and cross-parent discovery capped at 20 returned scopes, including stale active-marker evidence.
- Stream exact task session files read-only with a 1 MiB line ceiling into at most 200 approved transcript/tool-result metadata entries and 64 KiB of rendered output. Verify file bytes and timestamps remain unchanged and no Pi SessionManager open/migration path is called.
- Return paths only to the command-facing caller; keep model/result projection as a relative reference.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-diagnostics.test.ts
npm run typecheck
git diff --check -- extensions/subagents/diagnostics.ts tests/subagents-diagnostics.test.ts
```

**Done when:**

- `SOD-A2`, `SOD-A3`, `SOD-A4`, and inspector prerequisites for `SOD-A9` pass.
- New files and directories are private after effective-mode verification.
- Active or stale-active runs are never pruned automatically.
- Cleanup and lookup remain bounded and confined beneath the canonical diagnostic root.
- The store owns no graph, route, model, workspace, retry, or session-resume behavior.

**Recovery:** fail closed and fix forward. Never chmod an unowned path, follow a symlink, delete an active run, truncate JSONL, or fall back to temporary unpersisted evidence.

## SOD-400 — Integrate Pi session persistence, activity, and close-stall handling in the runner

**Depends on:** `SOD-200`, `SOD-300`

**Execution:** serial convergence

**Repository owner:** `pi-extensions`

**Locks:** `subagent-process-protocol`, `subagent-session-files`

**Write set:**

- `extensions/subagents/runner.ts`
- `tests/subagents-runner.test.ts`
- `tests/fixtures/subagents/fake-pi.mjs`

**Red-green work:**

- Extend fake-Pi modes to emit activity before close, assistant error followed by retry, `agent_end` without settlement, `agent_settled` then prompt close, `agent_settled` while ignoring TERM, file growth past the child ceiling, normal exit, abort, timeout, malformed output, and spawn failure.
- Inject an already allocated diagnostic task session, clock, activity callback, and typed run-cancellation callback through the runner contract; parent/run identity and run allocation remain owned by `SOD-500`.
- Replace `--no-session` with exact `--session <pre-created-file>` while preserving every other isolation and route argument.
- Forward protocol snapshots immediately and check session-file capacity on event/heartbeat observation.
- On `agent_settled`, emit `settled-awaiting-exit`, start the ten-second grace, then reuse TERM/KILL escalation and classify `child_exit_stalled` if close was late. Latch the first typed stop cause so later abort/timeout/signal observations cannot overwrite it.
- Preserve existing timeout and abort precedence, listener/timer cleanup, usage/output parsing, child concurrency callbacks, and private prompt/capability cleanup.
- Retain every started-child session outcome; remove only an unused empty placeholder after spawn failure.
- Prove at least one activity callback occurs before process close without using a fixed sleep as the oracle.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-runner.test.ts tests/subagents-protocol.test.ts tests/subagents-diagnostics.test.ts
npm run typecheck
git diff --check -- extensions/subagents/runner.ts tests/subagents-runner.test.ts tests/fixtures/subagents/fake-pi.mjs
```

**Done when:**

- `SOD-A1`, `SOD-A2`, `SOD-A6`, `SOD-A7`, and `SOD-A8` pass at the real subprocess boundary.
- The runner does not resolve before process close and cleanup.
- `agent_end` alone never starts exit termination.
- Every timer and signal listener is cleared on all final paths.
- No test needs provider credentials, ambient user sessions, or the real diagnostic root.

**Recovery:** fix forward against one fake-Pi mode. Do not weaken timeouts, rely on process-exit polling, copy raw stdout, or change Pi core.

## SOD-500 — Integrate scheduler progress, heartbeat, run retention, rendering, and debug command

**Depends on:** `SOD-400`

**Execution:** serial parent integration

**Repository owner:** `pi-extensions`

**Locks:** `subagent-scheduler`, `subagent-entrypoint`, `subagent-renderer`, `subagent-debug-command`

**Write set:**

- `extensions/subagents/scheduler.ts`
- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `tests/subagents-scheduler.test.ts`
- `tests/subagents-extension.test.ts`
- `tests/subagents-render.test.ts`
- `tests/subagents-host-contract.test.ts`
- `tests/subagents-evaluator.test.ts`

**Red-green work:**

- Extend `ChildLifecycle` with bounded activity delivery and update only the matching running task.
- Add an injected run clock and one five-second heartbeat that recomputes elapsed/inactivity, checks aggregate run bytes, and emits through existing `onUpdate`.
- Prove event-driven progress arrives before child settlement and quiet progress advances only on heartbeat.
- Resolve the parent session identity from `ctx.sessionManager`, allocate and reserve one diagnostic run per admitted batch under the total-root lock, allocate each task session before spawn, and remove the active marker only after all children/process/workspace cleanup settles.
- Abort remaining children with `diagnostic_session_limit` when the aggregate reaches 256 MiB, preserving existing session files and independent final error evidence.
- Extend progress formatting with phase, turns, active tools, elapsed, and inactivity while retaining existing bounded run/task summaries.
- Keep diagnostic paths out of model-visible content and ordinary progress. Persist only relative references in structured task details.
- Register `/subagents-debug [reference|--all]` as a user-only read-only command over the diagnostic store. Render bounded metadata and the exact local path through `ctx.ui`, with the ordinary-session/removed-worker-snapshot warning.
- Ensure unsupported modes or unsafe references fail visibly without reading arbitrary files.
- Preserve domain-to-host `isError`, one-active-run reservation, cancellation, shutdown waiting, route evidence, convergence, and result bounds.
- Add sensitive sentinel fixtures proving evaluator metric schema two, model content, progress, and host events do not copy diagnostic paths or raw session payloads.

**Focused verification:**

```bash
node --experimental-strip-types --test \
  tests/subagents-scheduler.test.ts \
  tests/subagents-extension.test.ts \
  tests/subagents-render.test.ts \
  tests/subagents-host-contract.test.ts \
  tests/subagents-evaluator.test.ts
npm run typecheck
git diff --check -- extensions/subagents/scheduler.ts extensions/subagents/index.ts extensions/subagents/render.ts tests/subagents-scheduler.test.ts tests/subagents-extension.test.ts tests/subagents-render.test.ts tests/subagents-host-contract.test.ts tests/subagents-evaluator.test.ts
```

**Done when:**

- `SOD-A4`, `SOD-A6`, `SOD-A9`, `SOD-A10`, and `SOD-A11` pass.
- The parent can distinguish active tool work, retry/error observation, quiet inactivity, semantic settlement, process closing, and final status.
- No timer, active marker, process, lock, or workspace remains after normal shutdown.
- Diagnostic evidence remains available after abort and after extension in-memory state is gone.
- No child event can alter scheduler topology, locks, route, convergence, or parent authority.

**Recovery:** fix forward in the causal scheduler, entrypoint, renderer, or inspector slice. Do not mark inactivity as failure, expose raw content for convenience, clear an active marker early, or let the debug command mutate a session.

## SOD-600 — Synchronize stable truth, run full verification, and review implementation

**Depends on:** `SOD-500`

**Execution:** serial parent-owned convergence

**Repository owner:** `pi-extensions`

**Locks:** `stable-truth`, `working-tree-convergence`, `full-verification`, `implementation-review`

**Write set:**

- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`
- `tests/repository-boundary.test.ts`

**Conditional focused-repair surface:** only exact files already owned by `SOD-100` through `SOD-500` plus the stable-truth files above. A new dependency, config surface, script, package file, or Pi core change requires plan revision.

**Work:**

- Re-read the working-tree diff and merge only the subagent diagnostic/liveness truth into already modified `AGENTS.md` and `README.md`, preserving unrelated Herdr content.
- Update `AGENTS.md` to permit retained diagnostic evidence while continuing to prohibit durable run orchestration, background missions, replay, and semantic resume.
- Update README with the default root, ordinary `/resume` exclusion, retention defaults, `/subagents-debug`, and explicit ordinary-session escape hatch.
- Update stable subagent architecture with Pi session ownership, private hierarchy, storage limits, live activity, heartbeat, settled-exit grace, read-only inspection, crash/stale-marker behavior, privacy, removal, and non-goals.
- Extend repository-boundary assertions only for machine-verifiable structure or forbidden runtime dependencies; do not freeze Markdown prose.
- Run focused suites together, clean-install dependencies, run the complete deterministic suite, and execute offline plan-mode/subagent temporary and installed probes.
- Do not run multi-skill mention or live subagent provider lanes without separate provider-call authority.
- Perform one bounded independent implementation review over the exact diff, approved artifacts, and verification evidence. The parent adjudicates candidates and may apply at most one focused in-scope repair before rerunning affected and full checks.

**Full verification:**

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
git diff --check
git status --short
```

**Done when:**

- `SOD-A12` passes and every earlier acceptance ID remains green.
- Stable docs describe verified behavior and no historical artifact is rewritten.
- Existing plan-mode, multi-skill-mentions, Herdr, and subagent boundaries remain independent.
- The exact changed-file inventory distinguishes this milestone from preserved unrelated work.
- Review returns `pass`, or one accepted causal repair is applied and all focused/full checks pass.
- No real user session, diagnostic root, route file, credential, provider setting, or installed package is modified by verification.

**Recovery:** fix forward in the owning task, then rerun its focused oracle and the full gate. Stop with `needs_plan_change` if a stable-truth conflict or review finding needs an undeclared file; stop with `needs_design_decision` if Pi-native persistence, privacy, retention, or settlement semantics cannot be preserved.

## Work-package readiness

- `milestone_objective`: durable child diagnostic evidence plus non-silent live liveness under the existing foreground subagent boundary.
- `non_goals`: durable orchestration, automatic semantic retry, attachable child TUI, worker snapshot retention, raw event-log retention, route/convergence changes, provider calls, installation, and deployment.
- `oracle_strategy`: contract examples, protocol state transitions, filesystem security properties, controlled subprocess integration, scheduler/host component evidence, read-only inspection, redaction negatives, stable truth review, and one implementation review.
- `acceptance_oracles`: `SOD-A1` through `SOD-A12` and each task's focused commands.
- `review_budget`: one plan review before approval, one implementation review after convergence, and at most one focused repair at each review point.
- `failure_policy`: fail closed for private storage/session setup, fix forward inside owned slices, or stop with typed design/plan/manual state.
- `parallel_policy`: only `SOD-200` and `SOD-300` may overlap after `SOD-100`; serial fallback is valid. Integration, truth sync, verification, adjudication, and continuation remain parent-owned.
- `subagent_ready`: false until the user explicitly requests implementation with delegation; the factual parallel group and exact write sets are nevertheless frozen.
- `external_prerequisites`: none for deterministic work while Pi remains 0.84.4; provider/live evidence remains separately authorized.
- `approval_status`: `approved`; repository-local implementation authority is true and the total-root reservation decision is frozen.

## Execution continuity and contingencies

After approval and explicit implementation authority, expected ranges are:

- `E1`: preflight and `SOD-100`;
- `E2`: independent `SOD-200` and `SOD-300`;
- `E3`: `SOD-400..SOD-500` serial integration;
- `E4`: `SOD-600` truth, verification, review, and handoff.

Typed contingencies:

- `X1 = pi_contract_changed`: Pi no longer persists an explicit session in JSON print mode, no longer initializes the private empty file, changes session format incompatibly, or omits `agent_settled`.
- `X2 = private_store_unavailable`: safe owner/mode/symlink checks or cross-process cleanup locking cannot be implemented portably through current dependencies.
- `X3 = retention_non_convergent`: active/stale markers or byte accounting cannot prevent active deletion and unbounded growth under concurrent Pi processes.
- `X4 = progress_contract_unavailable`: host `onUpdate` cannot surface event/heartbeat state without changing parent-loop semantics or persisting raw payloads.
- `X5 = worker_resume_confusion`: implementation would imply that reopening a deleted-snapshot worker session continues the original task or convergence authority.
- `X6 = unrelated_work_conflict`: current Herdr changes overlap stable truth in a way that cannot be preserved without a user decision.
- `X7 = scope_expansion_required`: a new dependency, global setting, route field, package surface, Pi core patch, background service, or deletion command becomes necessary.
- `X8 = non_convergent`: the one accepted implementation repair fails affected or full verification.

Any `X*` stops mutation with bounded redacted evidence. It never authorizes silent `--no-session` fallback, raw transcript exposure, active-session deletion, weakened permissions, hidden provider use, destructive reset, or automatic retry.

## Recovery and authority boundary

Default recovery is fix forward. Preserve only disposable fixture directories, synthetic session/event samples, and bounded failure metadata. Real user diagnostic files are never test inputs and are never deleted by repository validation.

Plan approval did not by itself grant implementation. The user's later explicit implementation request authorized only the declared repository write sets and deterministic commands. It did not authorize provider calls, changes beneath the real user agent directory, installation, commit, push, publication, or deployment.

## Truth-sync handoff

Truth synchronization is complete:

- `AGENTS.md` records the durable evidence-versus-orchestration rule;
- `README.md` records user-visible storage, retention, lookup, and explicit Pi-open behavior;
- `docs/architecture/subagents.md` records complete ownership and runtime semantics.

Historical plan artifacts remain stage evidence. The evaluator Skill's metric schema and instructions remain unchanged unless a verified redaction test exposes actual drift; such drift requires `needs_plan_change` because those files are not in this plan's write set.

## Plan review decision

A bounded independent plan review was required because implementation crosses Pi session persistence, private durable storage, subprocess settlement, cross-process coordination, user-only inspection, host progress, and stable truth while unrelated Herdr changes already occupy shared documentation surfaces.

The reviewer originally returned `needs_design_decision` with five material candidates. All five were causally valid:

- the settled-only 512 MiB policy reserves no capacity for concurrently active Pi processes and does not define stale-marker identity against a global bound;
- aggregate storage cancellation currently shares an undifferentiated abort channel, so user abort, timeout, diagnostic limit, and exit-stall results can race into the wrong typed outcome;
- Pi's persisted session stores message/tree entries, not `agent_end`, `agent_settled`, or process close, so the inspector can prove transcript completeness only unless another evidence artifact is added;
- `SOD-400` cannot wire parent session/run identity within its runner-only write set because `index.ts` currently owns those values;
- `/subagents-debug` lacks exact discovery, timeline, field, line, and rendered-byte limits.

Parent adjudication incorporated first-cause-latched typed cancellation, transcript/tool-result-only completeness in the inspector, parent/run identity integration in `SOD-500`, and exact streaming/discovery/render bounds. The user approved the remaining design decision: a total-root 512 MiB admission model reserves the full 256 MiB run allowance for every active or stale-active marker under the cross-process lock and rejects new runs unless settled bytes plus reservations can leave room for the new allowance.

`plan_review_status = passed_after_revision`.

## Implementation review decision

The first independent reviewer process returned no review text and therefore no usable verdict. One bounded corrective review of the converged implementation returned four material candidates. Parent adjudication accepted all four: read-only lookup created an absent root; exact inspection did not revalidate parent/run ancestors against symlinks; event-boundary run overflow stopped only the observing child; and transcript completeness accepted malformed, headerless, missing-stop, or pending evidence.

One focused in-scope repair made discovery non-creating, made inspection require private non-symlink ancestors, propagated run-scope limit events to typed aggregate cancellation, and required a valid first session header plus an untruncated structurally valid transcript ending in terminal `stop` or `length`. Focused tests cover each repaired case. The complete deterministic suite passes 187 tests, all four required offline plan-mode/subagent probes pass, and `git diff --check` passes. No accepted review finding remains; `implementation_review_status = passed_after_repair`.

## Approval request

`approval_status = approved` and `decision_state = decided`. The user explicitly approved both repaired artifacts and authorized repository-local implementation on 2026-09-02. Provider calls, installation, mutation of real diagnostic data, global settings mutation, commit, push, publication, and deployment remain unauthorized.
