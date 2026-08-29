+++
artifact_kind = "plan"
contract_version = 1
design_ref = "2026-08-29-bounded-subagent-runtime-design.md"
design_sha256 = "e21ef242017cf655d79b6c0a516925c777e745b31065d86e2bf4d0f223fcfb92"
design_approval_status = "approved"
approval_status = "approved"
decision_state = "approved"
implementation_status = "verified"
truth_sync_required = true
parallel_execution_proposed = true
+++
# Bounded subagent runtime implementation plan

## Milestone objective

Implement and verify the bounded foreground subagent runtime defined by `2026-08-29-bounded-subagent-runtime-design.md` without restoring a workflow lifecycle engine or coupling this repository to a Skill collection. The completed package will expose three independent extensions: `plan-mode`, `multi-skill-mentions`, and `subagents`.

The milestone is one coherent product boundary because routing, graph scheduling, child isolation, writable convergence, tool integration, and removal semantics jointly determine whether the new model-callable tool is safe to expose. Tasks preserve reversible increments and converge through one final integration and documentation boundary.

## Approval and prerequisite state

- `C1`: resolved on 2026-08-29; the user approved the bounded subagent runtime design.
- `C2`: resolved on 2026-08-29; the user approved this exact implementation plan. Plan approval authorizes only repository-local mutation within the listed files and deterministic offline verification.
- No account, login, credential, license, remote, publication, deployment, or physical prerequisite blocks deterministic implementation.
- A real-provider child smoke test is optional and outside this plan. It requires a later explicit user request because it consumes configured credentials, model quota, and cost.
- This plan does not authorize package installation, user route-file creation, global Pi settings changes, parent provider or model changes, commit, push, publication, deployment, or mutation of the separate Skill repository.

`C1` and `C2` are explicit, so `decision_state = approved` and `SAR-100` is executable.

## Scope

Repository-local implementation surfaces:

- `extensions/subagents/**`
- `tests/subagents-*.test.ts`
- `tests/fixtures/subagents/**`
- `scripts/run-temporary-subagents-probe.sh`
- `scripts/run-installed-subagents-probe.sh`
- `tests/installed-subagents-probe.test.ts`
- `package.json`
- `package-lock.json`
- `tests/package.test.ts`
- `tests/repository-boundary.test.ts`
- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`

Existing plan-mode and multi-skill files are verification inputs, not expected implementation edits. If implementation evidence proves one must change, stop with `needs_design_decision` rather than silently coupling extensions.

## Implementation constants

`SAR-100` will freeze these first-release hard ceilings as exported, directly tested constants:

- maximum tasks per invocation: `8`
- maximum concurrent children: `4`
- maximum concurrent workers: `2`
- maximum task objective bytes: `16 KiB`
- maximum explicit input bytes per task: `64 KiB`
- maximum injected predecessor output per predecessor: `16 KiB`
- maximum complete child prompt bytes: `128 KiB`
- maximum retained final output per task: `50 KiB`
- maximum retained stderr per task: `16 KiB`
- task timeout: `15 minutes`
- TERM-to-KILL grace period: `5 seconds`

User configuration may lower task, role, and concurrency limits but cannot raise a hard ceiling. A design amendment is required if implementation evidence shows that one of these constants cannot support the accepted use cases safely.

## Task graph

```text
SAR-100
├── SAR-200 ─┐
├── SAR-300 ─┤
├── SAR-400 ─┼── SAR-700 ─── SAR-800
└── SAR-500 ─── SAR-600 ─────┘
```

`SAR-200`, `SAR-300`, `SAR-400`, and `SAR-500` form named parallel group `runtime-foundations` after `SAR-100` freezes shared contracts. Their implementation and test files are disjoint. A capable runtime may execute them concurrently with `max_parallelism = 4`; serial execution remains a valid conservative fallback. `SAR-600` may start as soon as `SAR-500` succeeds. `SAR-700` is the only integration task and waits for every foundation plus snapshot convergence.

No task delegates authority, verification judgment, integration, repair, or continuation. Delegation eligibility below means that a bounded worker may implement the listed disjoint files if the active host has a safe delegation mechanism; the parent remains convergence owner.

## SAR-100 — Freeze public contracts and role capabilities

**Depends on:** none

**Execution:** serial, parent-owned

**Locks:** `subagent-public-contract`, `package-dependencies`

**Touched files:**

- `extensions/subagents/contracts.ts`
- `extensions/subagents/roles.ts`
- `tests/subagents-contract.test.ts`
- `package.json`
- `package-lock.json`

**Work:**

- Add the direct runtime schema dependency required for Pi tool parameters; do not rely on an undeclared transitive package.
- Define task, graph, route, result, usage, status, and typed-error contracts without importing a Skill repository or provider-specific model list.
- Encode the fixed `explorer`, `reviewer`, and `worker` prompts and exact tool allowlists.
- Encode the implementation constants above and byte-oriented validation helpers.
- Reject arbitrary `cwd`, concrete task model, task tool list, command, Skill, extension, retry, background, and nested-graph fields.
- Keep the package extension list unchanged until `SAR-700` supplies a functioning entrypoint.

**Verification:**

```bash
npm ci --ignore-scripts
node --experimental-strip-types --test tests/subagents-contract.test.ts
npm run typecheck
git diff --check -- package.json package-lock.json extensions/subagents/contracts.ts extensions/subagents/roles.ts tests/subagents-contract.test.ts
```

**Done when:**

- All three role capabilities and prohibitions are executable test data rather than prompt-only claims.
- Schema and runtime checks enforce IDs, role fields, path field shape, hard byte limits, and maximum graph size.
- No concrete provider/model ID, known Skill ID, sibling repository path, community package, or recursive subagent capability exists in maintained code.

**Recovery:** fix forward inside this exact slice. A shared-contract change discovered by a parallel successor pauses that group and returns to parent-owned repair rather than allowing divergent local contract edits.

## SAR-200 — Implement user-owned route configuration and deterministic binding

**Depends on:** `SAR-100`

**Parallel group:** `runtime-foundations`

**Delegation eligibility:** allowed, read/write isolated to this slice

**Locks:** `subagent-route-config`, `model-binding`

**Touched files:**

- `extensions/subagents/config.ts`
- `extensions/subagents/routing.ts`
- `tests/subagents-routing.test.ts`

**Work:**

- Resolve `csheng-subagents.json` from Pi's public `getAgentDir()` result without creating or modifying it.
- Parse absent, valid, malformed, symlinked, and role-incomplete configuration into an explicit effective configuration or typed diagnostic.
- Default every role to exact parent model and thinking inheritance and default guidance to `aggressive` as approved by the design.
- Permit ordered role candidates and lower concurrency limits while preventing configuration from raising hard ceilings.
- Resolve candidates against the parent model, current thinking level, `ctx.scopedModels`, authenticated models, and model thinking support.
- Emit explicit `{ provider, model, thinking, source, candidateIndex }` evidence for the selected route.
- Return `route_unavailable` or `invalid_route_config` without fallback not present in the candidate list.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-routing.test.ts
npm run typecheck
git diff --check -- extensions/subagents/config.ts extensions/subagents/routing.ts tests/subagents-routing.test.ts
```

**Done when:**

- Parent inheritance, ordered fallback, scoped-model exclusion, missing authentication, unsupported thinking, invalid configuration, and lower cap behavior have deterministic tests.
- Route resolution never changes the parent model or thinking level and returns arguments suitable for explicit child `--model` and `--thinking` flags.
- Tests use synthetic providers and models only.

**Recovery:** fix forward. Invalid user configuration remains isolated to the subagent tool and diagnostics; it cannot prevent Pi or another extension from loading.

## SAR-300 — Implement DAG admission and ready-task scheduling

**Depends on:** `SAR-100`

**Parallel group:** `runtime-foundations`

**Delegation eligibility:** allowed, read/write isolated to this slice

**Locks:** `subagent-dag`, `subagent-scheduler`

**Touched files:**

- `extensions/subagents/graph.ts`
- `extensions/subagents/scheduler.ts`
- `tests/subagents-scheduler.test.ts`

**Work:**

- Validate complete graphs before execution: IDs, dependencies, acyclicity, role fields, repository-relative scopes, exact worker paths, potential concurrent write overlap, locks, task count, and prompt-size projections.
- Use stable input order for ready ties and an injected task executor for deterministic tests.
- Enforce global, worker, role-route, resource-lock, and write-path concurrency limits.
- Mark dependency failures transitively blocked while continuing unrelated ready branches.
- Inject only bounded predecessor statuses and final outputs into dependent task inputs.
- Produce aggregate `succeeded`, `partial`, `failed`, or `aborted` state without automatic retry or rollback.
- Stop scheduling immediately on abort and await executor cleanup before returning.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-scheduler.test.ts
npm run typecheck
git diff --check -- extensions/subagents/graph.ts extensions/subagents/scheduler.ts tests/subagents-scheduler.test.ts
```

**Done when:**

- Deterministic generated cases cover chains, fan-out, fan-in, cycles, unknown dependencies, failure blocking, independent continuation, lock contention, overlapping write paths, worker caps, global caps, and abort.
- At least one timing-controlled fixture proves actual concurrency greater than one without making wall-clock duration the only oracle.
- No scheduler state survives the invocation.

**Recovery:** fix forward using the smallest failing generated graph. Do not serialize all work as a workaround for an ordering or lock defect.

## SAR-400 — Implement Pi subprocess protocol, bounded output, and cancellation

**Depends on:** `SAR-100`

**Parallel group:** `runtime-foundations`

**Delegation eligibility:** allowed, read/write isolated to this slice

**Locks:** `subagent-process-protocol`, `subagent-temp-artifacts`

**Touched files:**

- `extensions/subagents/protocol.ts`
- `extensions/subagents/runner.ts`
- `tests/subagents-runner.test.ts`
- `tests/fixtures/subagents/fake-pi.mjs`

**Work:**

- Resolve the current Pi invocation using the running executable/script shape with a documented `pi` fallback.
- Build child argv with JSON print mode, no session, disabled discovery, explicit guard extension, exact role tools, explicit model and thinking, and one-run project approval supplied only by the integration layer after parent trust.
- Store role and task prompts plus capability input in private temporary files rather than unbounded command arguments.
- Incrementally parse fragmented and coalesced JSONL, retain only relevant message and usage events, and classify malformed protocol, spawn, exit, stop-reason, timeout, and abort failures.
- Cap final output and stderr by bytes with explicit truncation evidence.
- On abort or timeout, send TERM once, escalate to KILL after five seconds, remove listeners, await process close, and perform idempotent private temporary cleanup.
- Preserve the ambient environment needed by the same Pi installation and its provider authentication. Strip only extension-owned parent dispatch or test-injection markers on a fixed denylist, then add the one child capability-manifest marker; do not attempt a generic secret-name filter that could silently break provider behavior. Never log environment names or values.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-runner.test.ts
npm run typecheck
git diff --check -- extensions/subagents/protocol.ts extensions/subagents/runner.ts tests/subagents-runner.test.ts tests/fixtures/subagents/fake-pi.mjs
```

**Done when:**

- Fixture modes prove split lines, multiple lines per chunk, trailing partial lines, assistant output, usage totals, stderr caps, malformed JSON, non-zero exit, spawn failure, timeout, immediate abort, TERM success, bounded KILL, and cleanup.
- Captured argv proves that concrete model, thinking, role tools, disabled discovery, guard path, and approval mode are explicit and that the subagent extension itself is unavailable.
- No test requires network or provider credentials.

**Recovery:** fix forward. Preserve only the smallest synthetic JSONL fixture or redacted argv evidence; never preserve raw prompts or child environment values in tracked files.

## SAR-500 — Implement child capability manifest and path guard

**Depends on:** `SAR-100`

**Parallel group:** `runtime-foundations`

**Delegation eligibility:** allowed, read/write isolated to this slice

**Locks:** `subagent-path-policy`, `child-capability-guard`

**Touched files:**

- `extensions/subagents/path-policy.ts`
- `extensions/subagents/child-capability-guard.ts`
- `tests/subagents-guard.test.ts`

**Work:**

- Define a versioned mode-0600 capability manifest with snapshot root, role, allowed read roots, and exact write paths.
- Canonicalize an existing target or nearest existing ancestor without treating lexical containment as physical containment.
- Permit only path-bearing calls for the role's exact built-in tools.
- Reject absolute and relative root escape, traversal, symlink escape, missing manifest, malformed manifest, role/tool mismatch, undeclared writes, write-through symlink, deletion, and rename authority.
- Keep extension initialization inert outside a child carrying a valid manifest marker.
- Export pure path-policy functions so deterministic tests do not require a live model.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-guard.test.ts
npm run typecheck
git diff --check -- extensions/subagents/path-policy.ts extensions/subagents/child-capability-guard.ts tests/subagents-guard.test.ts
```

**Done when:**

- Disposable directory cases prove allowed reads and writes plus denial of sibling paths, `..`, absolute paths, symlinks to outside roots, undeclared new files, and writable reviewer or explorer calls.
- The child guard can be loaded explicitly under `--no-extensions` and contains no subagent dispatch tool.

**Recovery:** fail closed and fix forward. Never weaken physical path resolution or convert guard failure into prompt-only guidance.

## SAR-600 — Implement Git-backed private snapshots and CAS convergence

**Depends on:** `SAR-500`

**Execution:** may overlap unfinished independent foundation tasks, but has no shared write surface

**Delegation eligibility:** allowed only if its executor cannot invoke the unfinished runtime recursively

**Locks:** `subagent-snapshot`, `subagent-convergence`

**Touched files:**

- `extensions/subagents/workspace.ts`
- `tests/subagents-workspace.test.ts`

**Work:**

- Find the containing Git root and enumerate tracked plus non-ignored untracked files without copying `.git`, ignored material, external files, sockets, devices, or escaping symlinks.
- Build mode-0700 private snapshots from the current working-tree bytes so staged, unstaged, and eligible untracked state is preserved.
- Record existence, type, mode, and digest baselines for every exact worker write path and require existing parent directories for declared new files.
- Reconcile the complete snapshot after execution and reject deletions, renames, permission changes, symlink writes, or any mutation outside declared paths.
- Apply accepted create-or-modify results through same-directory temporary files, baseline CAS checks, mode preservation, atomic rename, and bounded cleanup.
- Return typed `writable_isolation_unavailable`, `unexpected_worker_change`, or `convergence_conflict` without merging or overwriting parent drift.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-workspace.test.ts
npm run typecheck
git diff --check -- extensions/subagents/workspace.ts tests/subagents-workspace.test.ts
```

**Done when:**

- Disposable Git repositories prove dirty tracked fidelity, staged fidelity, non-ignored untracked inclusion, ignored exclusion, no `.git` copy, exact create and modify, mode preservation, outside-path rejection, symlink rejection, parent drift refusal, partial independent success, and cleanup.
- A non-Git writable task fails closed while a read-only task needs no snapshot.
- No test mutates the real repository or a user configuration file.

**Recovery:** fix forward inside disposable fixtures. A CAS conflict preserves parent state and returns evidence; it never triggers automatic restore.

## SAR-700 — Integrate the extension tool, guidance, lifecycle, and package surface

**Depends on:** `SAR-200`, `SAR-300`, `SAR-400`, `SAR-500`, `SAR-600`

**Execution:** serial convergence task, parent-owned

**Locks:** `subagent-entrypoint`, `pi-package-manifest`, `subagent-live-process-set`

**Touched files:**

- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `tests/subagents-extension.test.ts`
- `package.json`
- `tests/package.test.ts`

**Work:**

- Register `csheng_subagents` with the frozen typed task-array schema and no alternate single, chain, mission, or arbitrary-runtime mode.
- Require `ctx.isProjectTrusted()` before dispatch, resolve routes from current context, create worker snapshots, run the scheduler, converge successful workers, and return structured aggregate details.
- Add configured `off`, `balanced`, or `aggressive` prompt guidance only while the tool is active. Aggressive guidance recommends two-or-more independent bounded slices but never calls the tool automatically.
- Register `/subagents` as a redacted status command showing role routes by source, effective caps, guidance mode, active-child count, and configuration diagnostics without raw configuration.
- Render bounded per-task progress, role, status, elapsed time, and effective route without exposing prompts or paths outside the repository display boundary.
- Track all live children and temporary workspaces per session; make tool abort and `session_shutdown` share one idempotent cleanup path.
- Add `./extensions/subagents/index.ts` as the third package extension without changing the order or behavior of the existing entries.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-contract.test.ts tests/subagents-routing.test.ts tests/subagents-scheduler.test.ts tests/subagents-runner.test.ts tests/subagents-guard.test.ts tests/subagents-workspace.test.ts tests/subagents-extension.test.ts tests/package.test.ts
npm run typecheck
git diff --check -- extensions/subagents package.json tests/package.test.ts tests/subagents-extension.test.ts
```

**Done when:**

- Fake-Pi cases prove registration, parent trust refusal, explicit child approval after trust, route resolution from active context, one-task and mixed DAG execution, bounded progress, worker convergence, partial failure, abort, shutdown cleanup, and extension-off absence.
- No child can see `csheng_subagents`, and no enabled-but-idle session starts a process or mutates a workspace.
- Plan mode still selects exactly its existing four tools and therefore excludes this tool while active.

**Recovery:** fix forward. If integration cannot preserve extension independence or parent trust, stop with `needs_design_decision`; do not modify plan-mode or multi-skill behavior as a workaround.

## SAR-800 — Converge stable truth, probes, full verification, and implementation review

**Depends on:** `SAR-700`

**Execution:** serial, parent-owned

**Locks:** `stable-truth`, `package-probes`, `implementation-review`

**Touched files:**

- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`
- `scripts/run-temporary-subagents-probe.sh`
- `scripts/run-installed-subagents-probe.sh`
- `tests/installed-subagents-probe.test.ts`
- `tests/repository-boundary.test.ts`

**Conditional focused-repair surface:** only the exact causal files already authorized under `SAR-100..SAR-700`; no new file or authority may be introduced by review.

**Work:**

- Add the three-owner boundary map and actor-authority distinction to stable architecture truth without duplicating Pi internals or Skill-specific semantics.
- Clarify in `AGENTS.md` that a non-profile extension may execute one bounded in-memory delegation DAG while profiles remain prohibited from owning task graphs and the package remains prohibited from implementing a second lifecycle engine.
- Update README package surface, opt-in behavior, user route location, enabled-but-idle effects, child model binding, removal semantics, and exact non-goals.
- Add redacted temporary-load and installed-package probes that assert tool and status-command presence, fixed roles and limits, extension-off absence, no child launch during discovery, and no raw configuration or prompt output.
- Extend boundary tests to reject community package dependencies, dynamic role directories, known Skill repository coupling, provider-specific role defaults, and durable workflow-harness mechanics in maintained runtime code.
- Run one bounded implementation review over the complete new extension, tests, manifest changes, probes, and stable docs. Adjudicate candidate findings in the parent and allow at most one focused repair in the originating task's already approved file surface, followed by affected and full verification. A finding that needs another file, authority, or architecture decision stops with the matching typed state.

**Verification:**

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-multi-skill-mentions-probe.sh
bash scripts/run-installed-multi-skill-mentions-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
git diff --check
```

**Done when:**

- Stable docs match verified behavior and make Skills, Pi, and `pi-extensions` ownership independently visible.
- Every deterministic test and all six existing/new probe classes pass without network credentials or provider calls.
- Existing plan-mode and multi-skill behavior and removal semantics remain unchanged.
- The implementation review returns `pass`, or one accepted causally bound repair is applied and both focused and full verification pass.
- The working tree contains no raw prompt, user route configuration, credential, external file content, temporary workspace, or provider-specific role default.

**Recovery:** fix forward before any installation. A failed full probe keeps the extension unapproved for installation; it does not authorize changing global settings or deleting historical stage artifacts.

## Work-package readiness

- `milestone_objective`: deliver one predictable foreground subagent runtime with bounded DAG scheduling, per-role routes, fixed capabilities, isolated writable workers, and parent-owned decisions.
- `non_goals`: durable orchestration, child shell, dynamic roles, automatic review or repair, plan-mode integration, Skill loading, external writes, installation, and provider calls.
- `future_phase`: provider-neutral Skill wording and contract metadata may be updated in the Skill repository under its own approved design or bounded plan after runtime verification; constrained command jobs, durable resume, snapshot optimization, or new roles require their design triggers.
- `decision_status`: `approved`; `C1` and `C2` are resolved and the work package is coherent and execution-ready.
- `oracle_strategy`: schema and contract tests; generated DAG/model tests; fake-Pi component tests; JSONL subprocess tests; disposable-filesystem and Git integration tests; temporary-load and installed-package probes; existing-extension regression; bounded implementation review.
- `acceptance_oracles`: each task's exact commands and `done when` predicates, followed by `SAR-800` full verification.
- `delegation_readiness`: `SAR-200`, `SAR-300`, `SAR-400`, and `SAR-500` are independent after `SAR-100`; `SAR-600` is independently writable after `SAR-500`; integration and truth convergence remain parent-owned.
- `review_decision`: required for this plan and for the converged implementation because the change creates a model-callable concurrent writable boundary.

## Execution continuity

With `C1` and `C2` resolved, expected continuous ranges are:

- `E1`: `SAR-100`
- `E2`: parallel group `runtime-foundations` plus ready `SAR-600`
- `E3`: `SAR-700..SAR-800`

No ordinary task completion creates a human stop. The parent may conservatively serialize an allowed parallel group without changing scope. Known runtime contingencies are:

- `X1 = pi_public_contract_mismatch`: installed Pi cannot express explicit child extension loading, active model/thinking evidence, scoped-model checks, project trust, or shutdown cleanup as designed.
- `X2 = isolation_contract_invalid`: path guards or snapshot reconciliation cannot prevent escape or preserve dirty-tree fidelity without broader authority.
- `X3 = parent_authority_crossed`: implementation requires a graph to make a verification, approval, adjudication, repair, or continuation decision reserved for the parent.
- `X4 = scope_expansion_required`: child shell, deletion, external files, project-owned model routes, Skill loading, durable state, or changes to another extension become necessary.
- `X5 = non_convergent`: the one accepted implementation repair fails focused verification or introduces a repeated material finding.

An observed `X*` stops mutation with preserved redacted evidence and routes back to design or plan amendment. It does not authorize silent fallback, weakened isolation, a community dependency, global settings change, or automatic rollback.

## Recovery policy

Default recovery is fix forward. Preserve the smallest failing contract case, graph, synthetic model route, JSONL stream, disposable path tree, or Git fixture and repair only the owning task slice. Rerun the focused command before its dependents and rerun the full suite at `SAR-800`.

There is no guarded rollback task because this plan does not install the extension or mutate user/global state. Existing repository files may be edited only inside the approved task slices. Do not destructively reset the checkout, delete tracked history, commit, push, publish, deploy, or modify provider/model settings as recovery.

## Truth-sync handoff

After verified implementation, update exactly these stable truth owners in this repository:

- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`

The architecture document owns the extension-side three-boundary map, tool and role contract, route ownership, scheduling, child isolation, convergence, failure behavior, verification, non-goals, and removal. It links conceptually to Pi and Skills as external owners but does not copy their mutable implementation details.

The separate Skill repository is not a stable truth target of this plan. If its provider-neutral delegation wording or `may_spawn_agent` metadata needs adjustment, create and approve a repository-local plan there after `SAR-800`; do not mutate it as an undeclared external touch.

## Review decision

A bounded plan review was required. The target was this plan plus the exact referenced design; supporting evidence was limited to current package scripts, package metadata, test conventions, `AGENTS.md`, README, existing architecture documents, Pi's public extension/CLI contracts, and the historical workflow-harness artifacts needed to prove non-reintroduction.

No independent subagent runtime currently exists, so `review-change` and `review-plan` were applied directly. The focused repair replaced an underspecified environment-sanitization requirement with a fixed extension-marker policy that preserves provider authentication and made the implementation-review repair surface explicitly inherit only the causal files already approved under `SAR-100..SAR-700`. Rechecking scope, dependencies, parallel independence, touched surfaces, executable oracles, authority, recovery, and truth ownership produced verdict `pass` with no remaining material candidate finding. `C1` and `C2` were subsequently resolved, so no design, plan, implementation-detail, authority, or external prerequisite blocks repository-local execution.

## Implementation outcome

Implementation completed and deterministic verification passed on 2026-08-29. A direct bounded implementation review covered the complete repository diff because no independent subagent runtime existed before this change.

The review returned three causally bound candidates: concurrent parent tool calls could bypass per-run concurrency and write controls; a non-Git worker in a mixed graph failed unrelated read-only work before scheduling; and an unrelated tracked deletion caused snapshot creation to fail instead of preserving its absent working-tree state. All three dispositions were `accepted`. One focused repair added a session-wide active-run reservation, moved writable Git discovery into each worker task, preserved independent read-only branches, skipped tracked paths absent from the current working tree, added regression tests, and synchronized the one-active-graph stable contract.

Focused and declared verification then passed without another review: `npm run check` passed 49 tests; temporary and installed probes passed for plan mode, multi-skill mentions, and subagents; `git diff --check` passed; and an offline Pi RPC probe loaded `child-capability-guard.ts` explicitly under `--no-extensions` with no model call. No accepted finding remains.

Outcome: `pass`. No real-provider smoke test, package installation, user route-file creation, global settings mutation, parent model change, commit, push, publication, or deployment was performed during that implementation slice.

## Authorized live-E2E and installation follow-up

The user subsequently authorized real-provider validation in a disposable repository under `~/tmp` and global installation into the current Pi agent environment. The repository now owns an opt-in `e2e:subagents` runtime lane that loads all three package extensions together, invokes `explorer`, `reviewer`, and `worker` in one graph, requires exact inherited parent routing, verifies worker convergence, bounds capture and process lifetime, removes the disposable repository, and emits only a fixed redacted summary. It is excluded from `npm test` and requires `CSHENG_SUBAGENTS_LIVE_E2E=1`.

The first live run exposed a redundant worker-prose marker assertion even though the stronger worker file-content and convergence oracles passed; fix-forward removed only that duplicate prose assertion while retaining successful worker status, exact file content, and `convergence = applied`. A bounded review then found two live-harness risks: package co-load checks did not prove command/tool source provenance, and timeout rejection could begin cleanup before the Pi process group closed. Both findings were accepted in one focused repair. The observer now verifies package-owned source paths, and timeout/output termination waits for process close and cancels kill escalation before repository cleanup.

After repair, both temporary-package and installed-package live E2E runs passed with three successful roles, one shared `source = parent` route, and applied worker convergence. `pi install /Users/csheng/workspace/playground/pi-extensions` installed the local package source in the user Pi package scope. The optional `csheng-subagents.json` route file remains absent, so all roles use the active Pi default provider, model, and thinking level without copying or reading `~/.codex/agents/*.toml`. No parent model setting, credential, user route file, commit, push, publication, or deployment was changed.

## Approval

`approval_status = approved`. The user approved the design and this plan together on 2026-08-29 and explicitly requested `implement-change`. Repository-local implementation and deterministic offline verification were authorized; all separately excluded actions remain unauthorized.
