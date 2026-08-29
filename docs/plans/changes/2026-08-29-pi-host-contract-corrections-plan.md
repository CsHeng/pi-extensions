+++
artifact_kind = "plan"
contract_version = 1
design_ref = "2026-08-29-pi-host-contract-corrections-design.md"
design_sha256 = "ba436e9f3011466f9c62313fd9f84736a597b18e593b6bd22bcfef2186f9c405"
design_approval_status = "approved"
approval_status = "approved"
approval_basis = "The user explicitly approved both repository designs, both implementation plans, and implementation using subagents where the repository boundary permits on 2026-08-29."
decision_state = "approved"
implementation_authority = "granted"
implementation_status = "needs_plan_change"
verification_status = "blocked_by_temporary_multi_skill_probe"
truth_sync_status = "completed"
implementation_review_status = "passed_after_repair"
truth_sync_required = true
parallel_execution_proposed = false
implementation_review_required = true
plan_review_required = true
plan_review_status = "passed_after_repair"
+++
# Pi host contract corrections implementation plan

## Milestone objective

Implement the approved correction boundary in `2026-08-29-pi-host-contract-corrections-design.md`: make plan-mode state follow the active Pi session branch, conform the existing subagent tool to Pi's result/schema/package/output/shutdown contracts, complete elapsed rendering, remove the exact orphaned metadata selected by design, synchronize stable truth, and preserve all three independent extension boundaries.

The milestone changes no `multi-skill-mentions` behavior, child authority, route preference, DAG semantics, concurrency ceiling, writable isolation, convergence algorithm, telemetry schema, evaluator schema, or live-provider policy.

## Approval and prerequisite state

Satisfied at plan authoring time:

- The user bounded this repository's requested artifact to all previously identified `pi-extensions` corrections.
- Current `pi --version` is `0.84.4`.
- `pi list` reports the installed local package source as this repository, so installed-package probes can observe repository changes without another installation action.
- Pi `0.84.4` public documentation and installed types expose `getBranch()`, `session_tree`, `tool_result`, `StringEnum`, shared output truncation constants, peer-package guidance, and asynchronous extension events.
- Repository-local deterministic tests and RPC probes require no provider credentials or model calls. The temporary multi-skill print-mode probe was expected to share that property; the implementation outcome records the contrary preflight evidence.

Execution prerequisites satisfied:

- The user approved the referenced design and this plan.
- The user separately authorized the bounded repository-local implementation.

Implementation must recheck `pi --version` and `pi list` before mutation. If the host version or installed source changed, stop with `manual_checkpoint` or `needs_plan_change`; do not install or update Pi or the package implicitly.

This plan does not authorize real-provider calls, package installation, user route-file creation, global or project Pi settings changes, provider/model changes, commit, push, publication, or deployment.

## Frozen contract decisions

### Plan mode

- Active state is derived only from `ctx.sessionManager.getBranch()`.
- Restoration runs on `session_start` and `session_tree`.
- New persisted state is version 2 with `profile` and exact `restoreTools` for both plan and default profiles.
- Current unversioned plan/default entries remain readable; legacy default derives tools from the nearest earlier valid plan entry on the active branch or the startup baseline.
- Malformed latest active-branch state fails closed and may append one repaired version-2 entry.
- `--plan` applies once during startup after branch restoration and is not reapplied during later tree navigation.
- Explicit `/plan` and `/default` transitions remain idempotent and append state only when a transition or invalid-state repair occurs.

### Subagents

- Domain `succeeded` maps to host `isError = false`; `partial`, `failed`, and `aborted` map to `true` through the official `tool_result` seam.
- Tool `execute()` returns typed `AgentToolResult` content/details only and never an inert `isError` member.
- Model-facing role and semantic-profile enums use `StringEnum`.
- `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, and `typebox` are peer dependencies with `"*"`; exact development dependencies align to Pi `0.84.4` and `typebox` `1.3.7`.
- Complete model-visible result content is at most Pi's default 50 KiB and 2,000 complete lines and retains a compact summary for every admitted task.
- Structured details retain the existing per-task output bound and remain authoritative.
- Final summaries display `durationMs` as deterministic elapsed evidence; no ticking timer is added.
- `session_shutdown` aborts once and awaits complete active-run settlement.
- Remove `RoleDefinition.name`, `RoleDefinition.canWrite`, successful `RouteResolution.model`, `EffectiveSubagentConfig.configPath`, the induced unused config-construction `agentDir` parameters, and the plan-mode `persist` parameter. Retain the fixed role map, exact tools/prompts, role-discriminant enforcement, `EffectiveRoute.model`, loader-local user config path, and route-source diagnostics.

## Oracle strategy

Use red-green state, contract, component, and host-event tests at the smallest realistic boundary, followed by clean-install package verification and existing offline Pi probes.

| Protected boundary | Evidence class | Owning suite | Failure diagnosis owner |
| --- | --- | --- | --- |
| Active session branch owns plan profile | Stateful component examples | `tests/plan-mode.test.ts` | plan-mode implementation |
| Legacy persisted state remains recoverable | Compatibility examples | `tests/plan-mode.test.ts` | plan-mode state parser |
| Provider-compatible tool schema | Schema contract | `tests/subagents-contract.test.ts` | subagent contracts/package |
| Pi transport error status | Host extension-event component | new host-contract test plus extension tests | subagent entrypoint |
| Aggregate model-visible bound | Renderer properties/examples | new renderer test | subagent renderer |
| Awaited shutdown cleanup | Controlled asynchronous component | `tests/subagents-extension.test.ts` | subagent entrypoint/lifecycle |
| Elapsed output | Deterministic rendering examples | renderer test | subagent renderer |
| Core package peer ownership | Manifest and clean install | `tests/package.test.ts`, lockfile, `npm ci` | package metadata |
| Extension independence and regression | Full suite and offline probes | repository checks and scripts | package integration |

The host-event oracle must execute the registered `tool_result` handler through Pi's public `ExtensionRunner.emitToolResult()` seam. A direct call to the tool's `execute()` may verify domain content/details but is not sufficient evidence for final Pi `isError` behavior.

No live provider, ambient credential, production session, or external repository is needed. Existing live E2E remains a separately authorized release/runtime lane and is not run by this implementation plan.

## Acceptance trace

| Acceptance ID | Requirement | Implementation owner | Primary oracle |
| --- | --- | --- | --- |
| PHC-A1 | Startup restoration uses only the active branch | `PHC-100` | Conflicting full-tree/active-branch fixture |
| PHC-A2 | Tree navigation restores plan and default branches exactly | `PHC-100` | `session_tree` switch scenarios |
| PHC-A3 | Legacy and malformed plan state follow the frozen compatibility policy | `PHC-100` | Version-1 and invalid-state fixtures |
| PHC-A4 | Startup flag applies once and explicit default remains effective | `PHC-100` | Flag plus later tree-switch scenario |
| PHC-A5 | Model-facing enums and package peers conform to Pi `0.84.4` | `PHC-200` | Schema shape, manifest tests, clean install |
| PHC-A6 | Selected orphaned members disappear without weakening role/routing/config behavior | `PHC-200` | Typecheck and existing contract/routing tests |
| PHC-A7 | Pi transport error status follows the frozen domain mapping | `PHC-300` | Official host-event component test |
| PHC-A8 | Aggregate model-visible content remains within byte and line limits while retaining every task summary | `PHC-300` | Ten-task UTF-8/line renderer fixtures |
| PHC-A9 | Final rendering includes deterministic elapsed duration | `PHC-300` | Renderer examples |
| PHC-A10 | Shutdown waits for child/workspace settlement and state release | `PHC-300` | Delayed cleanup fixture |
| PHC-A11 | Stable truth and package behavior remain coherent | `PHC-400` | Full checks and all required offline probes |
| PHC-A12 | No material implementation-review finding remains | `PHC-500` | One bounded independent review and adjudication |

## Task graph

```text
preflight ── PHC-100 plan-mode branch state ── PHC-200 schema/package/metadata ── PHC-300 result/render/shutdown ── PHC-400 truth/full verification ── PHC-500 review convergence
```

The foundation source and test write sets are disjoint, but this plan deliberately executes them serially. `PHC-200` replaces the local dependency graph and lockfile, while every foundation task uses the shared `node_modules` tree for typecheck and host fixtures. Serial order prevents a clean install from racing another task's test process and gives `PHC-300` the final Pi `0.84.4` development baseline.

No delegated implementation is requested by this plan.

## Preflight — Establish reproducible current-host evidence

**Mutation authority:** environment-local dependency installation only after implementation is explicitly authorized; no package or Pi installation

**Work:**

- Confirm both repository and host facts before changing source.
- Install exactly the current lockfile into local `node_modules` so stale inherited dependencies cannot masquerade as source failure.
- Run the current deterministic baseline. Existing tests are expected to pass because the new regressions are not yet encoded; record that distinction.
- Reproduce the aggregate rendering gap with a bounded scratch invocation and confirm the current returned `isError` field is not part of Pi's typed `AgentToolResult` contract.

**Commands:**

```bash
pi --version
pi list
npm ci --ignore-scripts
npm run check
git status --short
```

**Done when:**

- Pi reports `0.84.4`.
- The installed package source is this repository.
- `npm ci --ignore-scripts` succeeds from the tracked lockfile.
- Baseline status and any failure are recorded without editing tests to hide environment drift.

**Failure policy:** stop before source mutation when host/source ownership changed, lockfile installation fails for reasons unrelated to the planned manifest correction, or baseline has an unrelated failure that prevents diagnosis.

## PHC-100 — Make plan-mode state active-branch aware

**Depends on:** preflight and approved design/plan

**Execution:** serial, repository-local

**Repository owner:** `pi-extensions`

**Locks:** `plan-mode-state`, `plan-mode-tests`

**Write set:**

- `extensions/plan-mode/index.ts`
- `tests/plan-mode.test.ts`

**Red-green work:**

1. Replace the fake context's `getEntries()` seam with `getBranch()` and add failing scenarios before changing implementation.
2. Add a fixture where a later custom entry exists outside the selected branch; prove it cannot control startup state.
3. Add two active branches with distinct plan/default states and trigger `session_tree` switches in both directions.
4. Add legacy unversioned plan and default fixtures, including default derivation from the nearest prior valid plan entry.
5. Add no-entry startup-baseline and malformed-latest-state fail-closed fixtures.
6. Add a startup-flag scenario followed by explicit `/default` and tree navigation to prove the flag is not reapplied.

**Implementation:**

- Define the version-2 persisted state with `version`, `profile`, and copied `restoreTools`.
- Capture the startup baseline before applying persisted state.
- Parse one active branch in reverse while retaining enough legacy history to derive a default restoration list.
- Centralize application of restored plan/default state without appending valid restored state.
- Handle `session_start` and `session_tree` through the same branch restoration function, with the startup flag passed only by `session_start`.
- Preserve fail-closed missing-tool behavior and status/notification behavior.
- Remove the unused `persist` parameter and keep explicit command transitions responsible for persistence.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/plan-mode.test.ts
npm run typecheck
git diff --check -- extensions/plan-mode/index.ts tests/plan-mode.test.ts
```

**Done when:**

- `PHC-A1` through `PHC-A4` pass.
- The implementation has no `getEntries()` state lookup and registers `session_tree`.
- Valid navigation adds no custom entry; explicit transitions and invalid repair append version-2 state only.
- Plan mode still exposes exactly the four builtin read-only tools and restores the exact branch-owned default tool list.

**Recovery:** fix forward using the smallest branch fixture. Do not fall back to global append order, rewrite session files, or discard invalid-state fail-closed behavior.

## PHC-200 — Correct model schema, package ownership, and orphaned contract metadata

**Depends on:** `PHC-100`

**Execution:** serial, repository-local

**Repository owner:** `pi-extensions`

**Locks:** `subagent-contracts`, `subagent-routing-config`, `package-manifest`, `package-lock`, `node-dependencies`

**Write set:**

- `extensions/subagents/contracts.ts`
- `extensions/subagents/roles.ts`
- `extensions/subagents/config.ts`
- `extensions/subagents/routing.ts`
- `tests/subagents-contract.test.ts`
- `tests/subagents-routing.test.ts`
- `tests/package.test.ts`
- `package.json`
- `package-lock.json`

**Red-green work:**

- Add schema assertions that each model-facing role/profile field emits a direct JSON Schema `enum` and not an `anyOf` literal union while existing `Check()` acceptance/rejection behavior remains intact.
- Extend manifest tests to require all four imported Pi core packages as peers with `"*"`, matching exact local development packages, and an aligned `0.84.4` Pi development baseline.
- Preserve role tool/prompt tests and route/config behavior tests while removing assertions or helper parameters that exist only for the selected dead metadata.

**Implementation:**

- Import `StringEnum` from `@earendil-works/pi-ai` and use it for role, execution-profile, and reasoning-profile fields in the model-visible tool schema.
- Keep TypeBox object, array, optional, string, and runtime `Check()` usage under the `typebox` peer.
- Move `typebox` from normal dependencies to peer dependencies and exact dev dependencies.
- Add `@earendil-works/pi-ai` to peer and dev dependencies; align Pi coding-agent and TUI dev dependencies to `0.84.4`.
- Regenerate `package-lock.json` from the edited manifest without running package lifecycle scripts.
- Remove `RoleDefinition.name` and `RoleDefinition.canWrite`; retain role-key lookup, exact tools, and prompts.
- Remove successful `RouteResolution.model`; retain the registry model as a local resolver variable and return only the consumed `EffectiveRoute`.
- Remove `EffectiveSubagentConfig.configPath`.
- Simplify config helpers to `defaultConfig()`, `cloneConfig(config)`, and `parseConfig(value, options?)`; retain `loadConfig(agentDir = getAgentDir())` as the sole owner of the loader-local optional user path.
- Update tests and call sites without exposing raw configuration paths.

**Manifest convergence:**

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
```

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-contract.test.ts tests/subagents-routing.test.ts tests/package.test.ts
npm run typecheck
git diff --check -- package.json package-lock.json extensions/subagents/contracts.ts extensions/subagents/roles.ts extensions/subagents/config.ts extensions/subagents/routing.ts tests/subagents-contract.test.ts tests/subagents-routing.test.ts tests/package.test.ts
```

**Done when:**

- `PHC-A5` and `PHC-A6` pass.
- Google-compatible enum shape is structural test evidence rather than a live provider call.
- A clean install resolves every direct import without relying on another package's nested dependency.
- No selected dead member or induced helper parameter remains.
- Exact role tools, prompts, route selection, profile mapping, source diagnostics, scoped-model enforcement, and user override loading retain deterministic coverage.

**Recovery:** fix forward in the manifest/contracts slice. Do not restore ordinary dependencies for Pi core packages, retain an inert field for hypothetical future use, or add a second role-policy authority.

## PHC-300 — Correct result transport, aggregate rendering, elapsed evidence, and shutdown convergence

**Depends on:** `PHC-200`

**Execution:** serial, repository-local

**Repository owner:** `pi-extensions`

**Locks:** `subagent-entrypoint`, `subagent-renderer`, `subagent-session-lifecycle`

**Write set:**

- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `tests/subagents-extension.test.ts`
- `tests/subagents-host-contract.test.ts` (new)
- `tests/subagents-render.test.ts` (new)

**Red-green work:**

- Replace direct assertions on `execute().isError` with domain-result assertions and a host-event test that initially demonstrates non-throwing failed results arrive with `isError = false` before extension result interception.
- Exercise the registered `tool_result` handler through Pi's public `ExtensionRunner.emitToolResult()` and cover `succeeded`, `partial`, `failed`, `aborted`, another tool, and malformed details. Build the fixture from the public `createExtensionRuntime`, `discoverAndLoadExtensions`, `ExtensionRunner`, and `SessionManager.inMemory()` exports with a non-network model-registry stub; do not call the handler array directly for this oracle.
- Construct maximum ten-task outputs containing ASCII, multibyte UTF-8, more than 2,000 lines, and an overlong single line; assert final content byte and line bounds, every task summary, and explicit truncation evidence.
- Add deterministic duration-format examples and verify final summaries contain elapsed evidence.
- Replace the shutdown test with a controlled run whose abort and cleanup settle in separate steps; prove the shutdown promise remains pending until complete cleanup and active-run release.

**Implementation:**

- Type final and progress tool results as Pi `AgentToolResult` values so an extra `isError` member becomes a compile-time excess-property failure at owned construction seams.
- Remove every `isError` member returned by tool `execute()`.
- Add a narrow `SubagentRunResult` runtime guard for `tool_result` details and a pure mapping from domain status to Pi transport status.
- Register one result handler scoped to `csheng_subagents`; do not modify content/details or intercept another tool.
- Refactor rendering into bounded run/task summaries plus fair allocation of remaining byte and line budgets across non-empty task output.
- Keep each mandatory task summary compact: bounded task ID, role, status, elapsed duration, bounded one-line route, convergence, changed-path count, and typed error code. Put error messages, changed-path detail, and child output into the fairly allocated body rather than allowing them to make the mandatory summary unbounded.
- Use Pi's public `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, and truncation helpers where they preserve complete lines and the every-task-summary invariant.
- Reserve all mandatory summaries first, divide the remaining byte and line budgets across non-empty task bodies, emit explicit per-task omission evidence, and enforce the final byte/line postcondition.
- Add deterministic duration formatting from `durationMs`. Show elapsed in final task summaries and in transition progress when duration is known, without timers.
- Track an active-run settlement promise alongside the active abort controller. Resolve it only after the existing scheduler/process/workspace `finally` path resets active state.
- Make `session_shutdown` abort idempotently and await the captured active-run promise. Ensure a concurrently completing run cannot cause the handler to await a later run.

**Focused verification:**

```bash
node --experimental-strip-types --test tests/subagents-extension.test.ts tests/subagents-host-contract.test.ts tests/subagents-render.test.ts
npm run typecheck
git diff --check -- extensions/subagents/index.ts extensions/subagents/render.ts tests/subagents-extension.test.ts tests/subagents-host-contract.test.ts tests/subagents-render.test.ts
```

**Done when:**

- `PHC-A7` through `PHC-A10` pass.
- Domain details remain available for partial and failed runs while final Pi tool messages carry the intended transport error status.
- No model-visible run result exceeds Pi's default bytes or lines, and all admitted tasks retain summary evidence.
- The ten-task aggregate test would fail against the current approximately 500 KiB renderer.
- Shutdown completion proves cleanup ordering rather than only observing an abort signal.
- No background interval, retry, durable run state, or new cleanup authority is added.

**Recovery:** fix forward against the smallest event, renderer, or delayed-cleanup fixture. Do not throw away structured details, globally intercept tool results, drop later task summaries, increase Pi output limits, or let shutdown return before cleanup.

## PHC-400 — Synchronize stable truth and run complete deterministic verification

**Depends on:** `PHC-100`, `PHC-200`, `PHC-300`

**Execution:** serial, parent-owned convergence

**Repository owner:** `pi-extensions`

**Locks:** `stable-extension-truth`, `dependency-install`, `offline-probes`, `full-verification`

**Write set:**

- `docs/architecture/plan-mode.md`
- `docs/architecture/subagents.md`

**Expected unchanged:**

- `README.md`; its current user-facing statements remain true after the correction and need no implementation narration;
- `AGENTS.md`; it already requires branch-minimal state, bounded output, complete cleanup, extension independence, and clean-install validation;
- `docs/architecture/multi-skill-mentions.md` and all multi-skill source;
- historical design and plan artifacts other than this correction pair;
- live E2E scripts and evaluator schema.

If implementation evidence proves an expected-unchanged surface is factually stale, stop with `needs_plan_change` rather than editing it opportunistically.

**Work:**

- Run the focused suites together before truth synchronization.
- Update plan-mode stable truth with active-branch ownership, `session_tree`, version-2 state, backward compatibility, invalid-state behavior, and one-time startup flag precedence.
- Update subagent stable truth with the domain/transport status distinction, official result-event mapping, provider-compatible schema ownership, total model-visible limit, elapsed rendering, awaited shutdown convergence, and simplified internal metadata boundary.
- Keep package and dependency details concise; stable docs should state ownership rather than copy lockfile versions except where the supported Pi baseline is operational truth.
- Confirm the current README and AGENTS statements remain true without editing them.
- Do not rewrite historical stage artifacts that previously recorded implementation completion.
- Reinstall exactly the corrected lockfile, run the complete deterministic suite, and run all repository-required temporary and installed offline probes.
- Confirm the installed package source still points to this repository before installed probes; do not reinstall if it does not.

**Verification:**

```bash
node --experimental-strip-types --test tests/plan-mode.test.ts tests/subagents-contract.test.ts tests/subagents-routing.test.ts tests/subagents-extension.test.ts tests/subagents-host-contract.test.ts tests/subagents-render.test.ts tests/package.test.ts
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-multi-skill-mentions-probe.sh
bash scripts/run-installed-multi-skill-mentions-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
git diff --check
git status --short
```

**Done when:**

- `PHC-A11` passes.
- Stable docs describe verified current behavior and no stage-history rewrite appears.
- Clean install and full package checks pass from the corrected lockfile.
- Plan-mode, multi-skill, and subagent temporary/installed probes all pass without provider calls or configuration mutation.
- Diff inspection shows no raw route file, prompt, credential, external file content, temporary workspace, session data, or unrelated source change.

**Recovery:** fix forward in the owning prior task or stable document, then rerun its focused oracle and all declared full checks. If an installed probe no longer targets this repository, stop with `manual_checkpoint`; installation is not authorized.

## PHC-500 — Perform bounded independent implementation review and converge

**Depends on:** `PHC-400`

**Execution:** serial, parent-owned adjudication

**Repository owner:** `pi-extensions`

**Locks:** `host-contract-implementation-review`

**Review target:**

- exact implementation diff from `PHC-100` through `PHC-400`;
- approved design and plan acceptance trace;
- declared verification evidence;
- Pi `0.84.4` public session, extension tool-result, model-schema, package, and output contracts as justified supporting truth.

**Review questions:**

- Can any full-tree or stale-branch state still control the active plan profile?
- Can a valid default branch fail to recover its exact tools?
- Does any non-throwing subagent failure still rely on an inert return property?
- Can schema serialization regress to a provider-incompatible union?
- Can any model-visible aggregate exceed the byte or line limit or hide a later task completely?
- Can shutdown resolve before scheduler, child, workspace, or active-run cleanup?
- Did metadata removal weaken role, route, config, path, or workspace authority?
- Did package core dependencies remain peers and clean-installable?
- Did any change couple the independent extensions or alter multi-skill behavior?

**Repair boundary:**

At most one focused repair may touch only files already owned by the causal `PHC-100`, `PHC-200`, `PHC-300`, or `PHC-400` task. The implementing parent adjudicates every finding. A new file, new authority, live provider requirement, historical migration, public behavior expansion, or second repair returns `needs_design_decision`, `needs_plan_change`, or `non-convergent` as appropriate.

**Verification after any accepted repair:**

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

- `PHC-A12` passes.
- One bounded independent review completes and all findings are adjudicated.
- No accepted material finding remains after at most one focused repair.
- Full deterministic verification remains green.

**Recovery:** stop with typed evidence rather than broadening scope or repeating review/repair loops.

## Work-package readiness

- milestone objective: correct current Pi host-contract and truth mismatches without adding product capability.
- non-goals: multi-skill changes, DAG/routing/isolation redesign, live providers, installation, user/global mutation, or new lifecycle machinery.
- oracle strategy: state compatibility, schema contract, official host event, renderer bounds, asynchronous cleanup, clean install, regression probes, and one implementation review.
- review budget: one independent implementation review and at most one focused repair.
- failure policy: fix forward inside the owning task or stop with a typed design/plan/manual state.
- parallel policy: serial; the shared local dependency tree and host fixture make clean-install and typecheck isolation more valuable than source-edit concurrency.
- subagent readiness: not claimed because delegated implementation was not requested; exact repository ownership and write sets are nevertheless explicit.
- external prerequisites: none while Pi remains `0.84.4` and the installed package source remains this repository.

## Execution continuity and contingencies

Expected continuous ranges after approval and explicit implementation authority:

- `E1`: preflight;
- `E2`: `PHC-100..PHC-300` in declared serial order;
- `E3`: `PHC-400..PHC-500` serial convergence.

Typed contingencies:

- `X1 = host_version_changed`: Pi is no longer `0.84.4` or documented event/schema contracts changed.
- `X2 = installed_source_changed`: installed probes no longer target this local repository.
- `X3 = legacy_state_unrecoverable`: current persisted default state cannot be deterministically restored from its active branch and startup baseline.
- `X4 = host_event_oracle_unavailable`: the official extension runner cannot exercise result interception without a live provider or unapproved dependency.
- `X5 = shutdown_non_convergent`: abort cannot settle children and workspace cleanup through the existing bounded process contract.
- `X6 = scope_expansion_required`: correction requires a role redesign, DAG change, migration command, live provider, package installation, or another extension's source.
- `X7 = non_convergent`: the single accepted implementation repair fails declared verification.

Any observed `X*` stops mutation with the smallest redacted evidence and routes to the matching design, plan, or manual decision. It does not authorize fallback to global session order, generic thrown errors, larger output limits, dependency bundling, hidden installation, or weakened cleanup.

## Truth-sync handoff

After behavior verification, synchronize only current stable truth in:

- `docs/architecture/plan-mode.md`;
- `docs/architecture/subagents.md`;
- `README.md` when its current user-facing claims need correction.

`AGENTS.md` changes only for a newly proven durable repository rule. Historical plans remain stage evidence and are not rewritten. No Skill repository is a truth-sync target of this plan.

## Authority boundary

The separate explicit implementation request authorized only the declared repository-local write sets and deterministic verification. Neither approval nor implementation authorizes:

- `pi install`, `pi update`, or changing user/project settings;
- creating or editing `csheng-subagents.json`;
- provider/model changes or real model calls;
- commit, push, publication, deployment, or remote mutation;
- changes to `agent-skills` or another repository.

## Review decision

A bounded direct plan review was required because the plan changes persisted state compatibility, host transport semantics, model-facing schema, package ownership, output context, and shutdown convergence. Direct review was used because the available bounded subagent runtime is rooted in the sibling `agent-skills` repository and cannot receive this repository's review scope.

The review checked this plan and its exact design against current test/package conventions and Pi `0.84.4` contracts. It found four execution-readiness defects: the host-event oracle and test-file choice were optional, mandatory per-task summaries lacked a concrete bound strategy, stable-truth write sets were conditional, and the proposed parallel tasks raced the shared `node_modules` and package-lock convergence boundary.

One focused repair made `tests/subagents-host-contract.test.ts` mandatory and named the public `ExtensionRunner.emitToolResult()` fixture, bounded mandatory summary fields before fair body allocation, froze stable truth to the two architecture documents while routing any newly proven README/AGENTS drift to `needs_plan_change`, and serialized the foundation tasks around the final Pi `0.84.4` dependency baseline.

Rechecking task coherence, dependencies, exact write sets, host-level oracles, clean-install sequencing, authority, truth sync, review budget, and recovery produced `pass`. `plan_review_status = passed_after_repair`; no remaining material finding remains.

## Implementation outcome

`PHC-100` through `PHC-300` implemented the approved active-branch plan state, version-2 and legacy recovery, provider-compatible schemas, Pi peer ownership, metadata removal, official transport-status interception, bounded aggregate rendering, elapsed evidence, and awaited shutdown convergence. `PHC-400` synchronized only the two declared architecture documents. `README.md`, `AGENTS.md`, multi-skill source, live E2E surfaces, and historical stage artifacts remain unchanged.

Clean `npm ci --ignore-scripts`, `npm run check`, 72 tests, typecheck, shell syntax checks, plan-mode temporary and installed probes, the installed multi-skill probe, subagent temporary and installed probes, and `git diff --check` pass against Pi `0.84.4`. `pi list` still points to this repository. The one focused implementation-review repair strengthened the delayed-cleanup fixture to prove active-run reservation release and strengthened the aggregate oracle to require actual summary lines; all affected and full checks pass.

The required `scripts/run-temporary-multi-skill-mentions-probe.sh` remains blocked before its extension observer runs: its isolated `PI_CODING_AGENT_DIR` contains no provider credential, and Pi exits with the no-API-key diagnostic even under `PI_OFFLINE=1`. The script and multi-skill implementation were expected unchanged, and using ambient credentials or a live provider is unauthorized. Repairing or replacing that oracle requires a new script write set, so `PHC-A11` cannot close under this plan and `implementation_status = needs_plan_change`. No source rollback is indicated; the corrected host-contract implementation and its deterministic package suite remain verified.

## Approval

`approval_status = approved`. The user explicitly approved the design, this plan, and repository-local implementation on 2026-08-29. Live provider calls, Pi package installation, user configuration mutation, commit, push, publication, and deployment remain unauthorized.
