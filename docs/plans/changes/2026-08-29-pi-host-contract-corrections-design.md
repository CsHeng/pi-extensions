+++
artifact_kind = "design"
design_version = 1
approval_status = "approved"
approval_basis = "The user explicitly approved this design, its implementation plan, and repository-local implementation on 2026-08-29."
decision_state = "approved"
design_depth = "design-full"
truth_impact = "high"
truth_sync_required = true
review_required = true
review_status = "passed_after_repair"
+++
# Pi host contract corrections design

## Objective

Correct the maintained `plan-mode` and `subagents` extensions where current implementation or verification does not satisfy Pi's session, tool-result, model-schema, package, output, rendering, and shutdown contracts. Remove the exact internal metadata proven to have no current responsibility while preserving the useful role, routing, configuration, and profile concepts.

The milestone is corrective rather than additive. It preserves the three independent extension boundaries, the host Pi loop's authority, the subagent DAG and isolation architecture, package-default routes, and existing removal semantics.

## Current truth and observed defects

### PM — Plan-mode branch state

`extensions/plan-mode/index.ts` restores its latest custom state by scanning `ctx.sessionManager.getEntries()` during `session_start`. It does not handle `session_tree` and therefore does not reapply the state of the newly active branch after tree navigation.

Pi session history is a tree. The active branch, not append order across the complete session tree, owns current branch-local extension state. A later state on an abandoned branch must not override the selected leaf.

The current persisted representation also stores `toolsBeforePlan: null` for a default-state entry. That is sufficient during one linear toggle sequence but is not independently sufficient to restore the exact default tool set after switching from a plan branch to a default branch. Legacy default state can be derived from the nearest earlier valid plan entry on that branch, but new state should carry an explicit restorable tool set.

### SA — Subagent host contracts

The subagent tool returns an extra `isError` property from `execute()`. Pi's tool result contract does not consume that property. A non-throwing execution reaches the agent core as a successful transport result unless the official `tool_result` event changes `isError`; current direct fake-tool tests therefore prove only the presence of an inert field.

The model-visible role and semantic-profile schemas use unions of literals. Pi's extension contract requires `StringEnum` for model-facing string enums so schemas remain compatible with providers that do not reliably accept the union representation.

The package imports `typebox` as a normal dependency even though Pi package guidance assigns host core packages to peer dependencies. The current host is Pi `0.84.4`, while development dependencies remain pinned to `0.84.3`.

Each child output is capped, but `formatRunResult()` concatenates all retained outputs. At the ten-task hard limit, the model-visible tool text can exceed Pi's default 50 KiB and 2,000-line result boundary by an order of magnitude. Structured `details` remain bounded per task, but that does not protect model context.

`session_shutdown` aborts the active controller and returns immediately. It does not wait for the active scheduler, child TERM-to-KILL path, workspace cleanup, and extension state reset to settle before the shutdown handler completes.

The approved original runtime plan required elapsed-time rendering. Current result rendering includes role, status, route, profile, paths, errors, and output but omits task duration.

### SA — Orphaned implementation metadata

The following internal representations have no current consumer or independent responsibility:

- `RoleDefinition.name` duplicates the key used to retrieve the fixed role.
- `RoleDefinition.canWrite` duplicates role-discriminant policy and does not drive graph admission, child tools, path policy, workspace isolation, or tests.
- the successful `RouteResolution.model` member returns a registry model object after route selection even though callers consume only the serialized effective route;
- `EffectiveSubagentConfig.configPath` exposes a path on the effective configuration although only the loader-local path is needed to read the optional user override; removing it also makes the `agentDir` parameters on `defaultConfig()`, `cloneConfig()`, and `parseConfig()` obsolete;
- `enterPlan(ctx, persist)` retains an unreachable false branch.

The role system, exact role tools, path restrictions, route selection, effective route evidence, and user configuration remain required. Removing redundant representations must not remove those concepts or create another policy authority merely to justify existing fields.

## Selected correction boundary

The design contains two independently testable tracks under one host-conformance milestone:

- **PM track:** make plan-mode state branch-aware and self-sufficient for branch restoration while retaining backward compatibility with current persisted custom entries.
- **SA track:** conform the existing subagent tool to Pi's result, schema, package, output, and shutdown contracts; complete elapsed rendering; and remove proven orphaned metadata.

The tracks may be implemented independently and converge only at stable truth and full package verification. `multi-skill-mentions` is regression evidence only and receives no behavior or source change.

## PM selected design

### Active-branch ownership

Plan-mode restoration reads only `ctx.sessionManager.getBranch()`. The latest applicable plan-mode custom entry on that branch owns the selected profile and its restoration tool set.

Restoration runs:

- on `session_start`, before the next model turn;
- on `session_tree`, after Pi changes the active leaf;
- after explicit `/plan` and `/default` commands through the same application helpers.

Tree navigation must not append a new entry for a valid restored state. Invalid latest state continues to fail closed to plan mode and may append one repaired current-format entry to the selected branch, preserving the existing visible fail-closed contract.

### Persisted state version

New entries use a versioned state that records the exact restorable default tool set for both profiles:

```text
version = 2
profile = plan | default
restoreTools = string[]
```

For `plan`, `restoreTools` is the complete tool set captured on first entry. For `default`, it is the exact tool set restored by `/default`. Re-entering plan mode remains idempotent and does not overwrite the captured list.

Current unversioned entries remain readable:

- legacy `plan` with a string-array `toolsBeforePlan` maps directly to version 2;
- legacy `default` with `toolsBeforePlan = null` derives its restoration set from the nearest earlier valid plan entry on the same active branch;
- when no prior plan entry exists, restoration uses the baseline active tool set captured before plan-mode applies session state at startup;
- malformed latest state fails closed and is never silently treated as default.

No migration rewrites historical session files. New entries are appended only by an explicit profile transition or invalid-state repair.

### Startup flag precedence

`--plan` is a startup override. During `session_start`, branch state is restored first and the flag then enters plan mode using that branch's restorable default tool set. The flag is not reapplied on later `session_tree` events, so an explicit `/default` remains effective during the running session.

## SA selected design

### Domain result versus host transport status

`SubagentRunResult.status` remains the authoritative domain outcome:

| Domain status | Pi tool-result `isError` |
| --- | --- |
| `succeeded` | `false` |
| `partial` | `true` |
| `failed` | `true` |
| `aborted` | `true` |

The tool `execute()` returns only a typed Pi `AgentToolResult`: model-visible `content` plus structured `details`. It does not return `isError`.

The extension registers an official `tool_result` handler scoped to `csheng_subagents`. When the event contains a recognized `SubagentRunResult`, the handler maps the table above into Pi's transport status. It leaves other tools and malformed or unrelated details unchanged. This preserves structured failure evidence without converting every domain failure into a thrown exception with empty details.

A host-facing component oracle must exercise the registered result hook through Pi's extension runner or equivalent official event seam. Direct invocation of the tool definition remains useful for domain behavior but cannot be the transport-status oracle.

### Provider-compatible model schema

All model-visible string enums in `SubagentToolSchema` use Pi's exported `StringEnum` helper:

- `explorer | reviewer | worker`;
- `fast | balanced | deep` execution profiles;
- `light | standard | deep` reasoning profiles.

Internal configuration parsing may continue to use ordinary TypeScript arrays and explicit runtime validation. The schema oracle verifies the emitted JSON Schema uses an enum representation rather than `anyOf` literal unions and retains existing TypeBox validation behavior.

### Package ownership and development baseline

Pi host core packages imported by extension source are peers with version `"*"` and exact development dependencies for local typechecking:

- `@earendil-works/pi-coding-agent`;
- `@earendil-works/pi-tui`;
- `@earendil-works/pi-ai` after adopting `StringEnum`;
- `typebox`.

The development baseline aligns with the current supported Pi host, `0.84.4`. The private package continues to rely on Pi package installation for peer resolution and does not bundle a second copy of host core packages.

A clean `npm ci --ignore-scripts` followed by `npm run check` is the reproducibility oracle. Inherited `node_modules` state is not completion evidence.

### Bounded model-visible aggregate

Per-task retained output remains capped at the existing 50 KiB boundary in structured details. The complete model-visible `content` additionally obeys Pi's public default limits:

- at most 50 KiB UTF-8;
- at most 2,000 complete lines.

The renderer first reserves a compact summary for the run and every admitted task, including role, status, elapsed duration, effective route when present, convergence, changed-path count or bounded path evidence, and typed error code when present. It then allocates the remaining byte and line budget fairly across non-empty task outputs and emits explicit omission evidence for truncated bodies.

The final invariant must hold for one through ten tasks, multibyte UTF-8, very long lines, long diagnostics, and maximum retained child outputs. A final safety check may use Pi's public truncation utilities, but it must not silently remove all evidence for later tasks.

Structured details remain the authoritative bounded per-task result. The model-visible rendering is a synthesis aid and does not replace details.

### Elapsed rendering

Final task summaries display deterministic elapsed duration derived from `TaskResult.durationMs`. Progress updates display elapsed duration whenever it is known at an emitted transition. This is completion-duration evidence, not a continuously ticking timer; the correction adds no background interval or durable UI state.

### Shutdown convergence

The extension tracks both the active abort controller and a promise representing complete settlement of the active graph. `session_shutdown` aborts once and awaits that promise. The promise resolves only after scheduler settlement, child process close or bounded TERM-to-KILL escalation, worker cleanup, listener unlinking, active-child reset, and active-run reservation release.

The shutdown path remains idempotent. Repeated shutdown or an already settled run returns without spawning work, widening authority, or deleting persisted user state.

### Metadata simplification decisions

Remove the exact redundant members:

- `RoleDefinition.name`;
- `RoleDefinition.canWrite`;
- successful `RouteResolution.model`;
- `EffectiveSubagentConfig.configPath` and the induced unused `agentDir` parameters on config construction and parsing helpers;
- the unused `persist` parameter from plan-mode entry.

Retain:

- `RoleName` and the fixed `ROLES` map;
- exact role tool arrays and prompts;
- role-discriminant graph, path, and workspace policy;
- `EffectiveRoute.model`, which is the consumed serialized model identifier;
- loader-local `configPath` used to read the optional override;
- effective route and config source diagnostics.

No dynamic role system, generic capability framework, policy table injection, or new compatibility layer is introduced.

## Alternatives

### Broaden review or keep all fields until another consumer appears

Rejected. A useful role or routing concept does not make every internal representation necessary. Retaining unowned fields creates competing policy surfaces and future drift.

### Make `canWrite` the new universal role authority

Rejected for this correction. Current fixed-role enforcement already has concrete owners in graph admission, tool allowlists, path policy, and workspace isolation. Rewiring all of them through one boolean would widen the change and reduce distinctions such as exact paths, tools, and convergence authority.

### Throw for every non-successful subagent run

Rejected because Pi converts thrown tool failures to generic error details, while the parent needs typed per-task and telemetry evidence for partial, failed, and aborted runs. The official `tool_result` hook preserves both transport status and domain details.

### Keep per-task caps without a total cap

Rejected because model context receives the aggregate text. A mathematical ten-task bound near 500 KiB does not satisfy Pi's tool-output guidance.

### Use only global session append order

Rejected because a session tree can contain later entries outside the active branch. Simplifying the scan with `findLast()` would preserve the wrong owner.

### Rewrite historical session entries or stage plans

Rejected. Session state is append-only and backward-readable; historical design and implementation plans remain stage evidence. New corrective artifacts and current stable docs own the correction.

## Scope

In scope:

- branch-aware plan-mode state restoration and versioned backward-compatible state parsing;
- `session_tree` handling and startup-flag precedence;
- removal of the dead plan-mode persistence parameter;
- subagent model-facing enum conformance;
- Pi peer and development dependency ownership;
- tool-result transport status through the official event seam;
- complete model-visible aggregate bounds;
- elapsed-duration rendering;
- awaited idempotent session-shutdown cleanup;
- removal of the four identified subagent metadata members;
- deterministic tests, package checks, existing offline probes, and stable truth synchronization.

Out of scope:

- changes to `multi-skill-mentions` behavior;
- changes to task DAG topology, concurrency ceilings, routing preference, semantic profile vocabulary, child prompts, writable isolation, CAS convergence, telemetry schema, evaluator schema, or live E2E semantics except where existing tests require adaptation to the corrected rendering;
- new roles, child shell, background runs, durable graphs, retries, rollback, model fallback, Skill loading, or a generic permission framework;
- migration of historical JSONL session files in place;
- real-provider calls, package installation, user route-file creation, global Pi settings changes, provider/model changes, commit, push, publication, or deployment.

## Truth impact

After verified implementation:

- `docs/architecture/plan-mode.md` must describe active-branch ownership, `session_tree` restoration, versioned state, legacy interpretation, and startup-flag precedence.
- `docs/architecture/subagents.md` must describe host error mapping, total model-visible bounds, elapsed rendering, awaited shutdown convergence, and package/schema ownership at the extension boundary.
- `README.md` should change only where its bounded-output, session-state, or local-development claims need precision.
- `AGENTS.md` already requires bounded output, complete cleanup, extension independence, and clean-install validation; update it only if implementation establishes a new durable working rule.

Historical artifacts under `docs/plans/changes/` remain unchanged.

## Oracle strategy

Use red-green component, contract, persisted-state compatibility, and host-event conformance tests, followed by clean-install package verification and existing offline probes.

Protected boundaries and primary oracles:

| Boundary | Oracle |
| --- | --- |
| Active session branch owns plan profile | Branch fixtures with conflicting off-branch later entries and `session_tree` switches |
| Legacy session compatibility | Version 1 plan/default and malformed-state fixtures |
| Pi transport error status | Official extension result-event component test plus typed tool return shape |
| Provider-compatible tool schema | Emitted enum-schema contract and existing runtime schema validation |
| Model-visible output limit | Maximum ten-task UTF-8 and line-limit renderer fixtures retaining every task summary |
| Shutdown cleanup | Delayed child/workspace settlement fixture proving the handler does not resolve early |
| Elapsed display | Deterministic duration rendering examples |
| Package ownership | Manifest assertions and clean `npm ci --ignore-scripts` from lockfile |
| Extension regression | `npm run check` plus all six temporary/installed offline probes |

No live provider or ambient credential is required. Existing opt-in live E2E remains outside deterministic implementation acceptance.

## Acceptance evidence

- Plan mode restores only the active branch on startup and every tree navigation.
- Switching between a plan branch and a default branch restores each branch's exact active tool profile.
- Current unversioned state remains readable; malformed current-branch state fails closed visibly.
- The startup flag applies once and does not override later explicit default selection during tree navigation.
- Subagent `execute()` results contain no inert `isError` property; Pi transport status follows the explicit domain-status table through the official event seam.
- Model-facing role and profile schemas emit provider-compatible string enums.
- Imported Pi core packages are peers and exact development dependencies align to `0.84.4`.
- Maximum aggregate model-visible content remains within both Pi default byte and line limits while preserving a summary for every admitted task.
- Final rendering includes deterministic task elapsed duration.
- `session_shutdown` does not resolve before active child and workspace cleanup settles.
- The five identified dead parameters or members are absent while role, route, config loading, and path/workspace enforcement behavior remains covered.
- Stable docs describe verified current behavior, and historical stage artifacts remain untouched.
- Clean install, full tests, shell syntax checks, `git diff --check`, and all required offline probes pass.

## Recovery

Use fix-forward recovery within the owning track and preserve the smallest failing branch, event, schema, renderer, shutdown, or manifest fixture.

Do not weaken branch isolation, error mapping, enum shape, output limits, cleanup settlement, role/path authority, or package peer checks to make tests pass. If Pi `0.84.4` cannot support asynchronous `tool_result` mapping, branch events, or awaited shutdown as documented, stop with `needs_design_decision` and retain redacted host evidence.

No guarded rollback is required because the plan will not install the package or mutate user/global state. Removal of the package extension remains the later installation recovery boundary.

## Review decision

A bounded design review was required because this correction changes persisted session interpretation, model-visible tool schema and output, tool failure semantics, and shutdown convergence. Direct review was used because the available bounded subagent runtime is rooted in the sibling `agent-skills` repository and cannot receive a writable or review scope in this repository.

The review checked this artifact against current plan-mode and subagent architecture truth, the exact affected source contracts, package metadata, tests, and Pi `0.84.4` public extension, session, package, and tool-output documentation. One focused repair made the cleanup consequence explicit: removing `EffectiveSubagentConfig.configPath` also removes the now-unused `agentDir` parameters from config construction and parsing helpers while retaining `loadConfig(agentDir)` as the user-file location owner.

Rechecking the two-track ownership, legacy-state recovery, structured failure evidence, aggregate diagnosability, package dependency direction, shutdown convergence, and role/path authority produced `pass`. `review_status = passed_after_repair`; no remaining material scope, contract, compatibility, recovery, or oracle finding remains.

## Approval

`approval_status = approved`. The user explicitly approved this design, its implementation plan, and repository-local implementation on 2026-08-29. Local clean dependency installation and deterministic verification are authorized. Live provider calls, Pi package installation, user configuration mutation, commit, push, publication, and deployment remain unauthorized.
