+++
artifact_kind = "plan"
contract_version = 4
design_ref = "2026-08-28-workflow-harness-design.md"
design_sha256 = "4d8c202b5f221138c4ee5936b12454b0741db79c5d56d85560ecc3e7f8e1586c"
approval_status = "approved"
truth_sync_required = true
stable_truth_refs = ["AGENTS.md", "README.md", "docs/architecture/workflow-harness.md"]
default_runtime_model_policy = "semantic-routing"
parallel_execution_approved = false

[scope]
impl_file_refs = [".gitignore", "AGENTS.md", "README.md", "docs/architecture", "extensions", "package-lock.json", "package.json", "scripts", "tsconfig.json"]
test_file_refs = ["tests"]
external_impl_file_refs = ["/home/csheng/.pi/agent/settings.json"]

[[tasks]]
task_id = "PWH-100"
depends_on = []
verification_commands = ["npm ci --ignore-scripts", "node --experimental-strip-types --test tests/package.test.ts tests/repository-boundary.test.ts", "npm run typecheck", "git diff --check -- .gitignore AGENTS.md README.md docs/architecture extensions/workflow-harness/index.ts package.json package-lock.json tsconfig.json tests/package.test.ts tests/repository-boundary.test.ts"]
scope_slice = "Bootstrap the independent private Pi package and its stable ownership boundary. Add one workflow-harness extension entry, deterministic Node and TypeScript tooling, repository guidance, architecture truth, and package-boundary tests without importing implementation or fixtures from another checkout."
executor_mode = "main"
parallel_group = "none"
parallel_policy = "forbidden"
delegation_policy = "forbidden"
execution_profile = "deep"
reasoning_profile = "deep"
isolation = "controller-checkout"
resource_locks = ["pi-package-manifest", "repository-truth", "node-lockfile"]
convergence_required = true
review_budget = 1
task_review_depth = "full"
done_when = ["The repository identifies itself as a Pi extension package rather than as an adapter for any Skill collection.", "The package exposes exactly one extension entry named workflow-harness and contains no second installed surface.", "TypeScript source and tests resolve against Pi's public extension types, the dependency lock is reproducible, and no Python or sidecar runtime is required.", "Stable documentation assigns lifecycle, graph, tool-policy, review, replay, and settlement ownership to this repository and describes Skills only as optional Pi-discovered workers.", "Boundary tests reject a known Skill ID, repository path, generated semantic contract, sibling lookup, or cross-repository test fixture."]
failure_policy = "fix_forward"
rollback_trigger = ""
rollback_target = ""
rollback_verification = ""

[tasks.scope]
impl_file_refs = [".gitignore", "AGENTS.md", "README.md", "docs/architecture/workflow-harness.md", "extensions/workflow-harness/index.ts", "package-lock.json", "package.json", "tsconfig.json"]
test_file_refs = ["tests/package.test.ts", "tests/repository-boundary.test.ts"]
external_impl_file_refs = []

[[tasks]]
task_id = "PWH-200"
depends_on = ["PWH-100"]
verification_commands = ["node --experimental-strip-types --test tests/graph.test.ts tests/graph-properties.test.ts tests/proposal-freeze.test.ts tests/session-state.test.ts", "npm run typecheck", "git diff --check -- extensions/workflow-harness tests/graph.test.ts tests/graph-properties.test.ts tests/proposal-freeze.test.ts tests/session-state.test.ts"]
scope_slice = "Implement the provider-owned deterministic core: frozen proposal evidence, typed task-graph schema and admission, serial readiness, exact scopes and locks, bounded attempts, versioned session state, and active-branch replay. Keep Pi event wiring and semantic worker dispatch outside this slice."
executor_mode = "main"
parallel_group = "none"
parallel_policy = "forbidden"
delegation_policy = "forbidden"
execution_profile = "deep"
reasoning_profile = "deep"
isolation = "controller-checkout"
resource_locks = ["task-graph-schema", "session-state-schema", "proposal-digest", "replay-model"]
convergence_required = true
review_budget = 1
task_review_depth = "full"
done_when = ["Frozen proposals record only bounded messages and explicitly referenced workspace artifacts with stable digests.", "The graph schema records IDs, dependencies, scopes, locks, isolation, executable verification, completion evidence, review policy, attempt limit, and recovery without requiring a Skill-authored format.", "Deterministic admission rejects duplicates, unknown dependencies, cycles, unreachable tasks, unsafe paths, conflicting locks or writes, invalid parallel shape, missing oracles, and unbounded attempts.", "Ready-task selection is serial by default and cannot advance a dependent before every dependency is accepted.", "Replay reconstructs only the active Pi branch and is idempotent across retry, resume, fork, and compaction.", "Generated graph property cases cover ordering, cycles, lock conflicts, scope containment, and terminal-state invariants rather than only example fixtures."]
failure_policy = "fix_forward"
rollback_trigger = ""
rollback_target = ""
rollback_verification = ""

[tasks.scope]
impl_file_refs = ["extensions/workflow-harness"]
test_file_refs = ["tests/graph.test.ts", "tests/graph-properties.test.ts", "tests/proposal-freeze.test.ts", "tests/session-state.test.ts"]
external_impl_file_refs = []

[[tasks]]
task_id = "PWH-300"
depends_on = ["PWH-200"]
verification_commands = ["node --experimental-strip-types --test tests/activation.test.ts tests/skill-discovery.test.ts tests/normalization.test.ts tests/review-policy.test.ts tests/non-reentry.test.ts", "npm run typecheck", "git diff --check -- extensions/workflow-harness tests/activation.test.ts tests/skill-discovery.test.ts tests/normalization.test.ts tests/review-policy.test.ts tests/non-reentry.test.ts"]
scope_slice = "Bind capture and semantic child dispatch to Pi's public command and message surfaces. Implement pass-through activation, exact Skill-source correlation, description-based capability resolution, typed proposal normalization, authorized root formal-role admission with stable stage instance IDs, independent standalone review, generic fallback, and non-reentrant child markers."
executor_mode = "main"
parallel_group = "none"
parallel_policy = "forbidden"
delegation_policy = "forbidden"
execution_profile = "deep"
reasoning_profile = "deep"
isolation = "controller-checkout"
resource_locks = ["managed-activation", "pi-skill-discovery", "child-dispatch", "review-reason-ledger"]
convergence_required = true
review_budget = 1
task_review_depth = "full"
done_when = ["Ordinary prompts and tool use remain pass-through until an explicit harness entry, typed graph, or observable root design, planning, or implementation Skill selection starts managed capture.", "Explicit Skill input is observed before expansion, and model-driven selection correlates only with an exact opaque path from the current Pi command snapshot.", "Capability resolution consumes only current public Skill names and descriptions, returns one candidate or none through a typed result, and refreshes after Skill reload.", "Only an explicit root role request, approved graph root declaration, or observable resolved root Skill selection can assign formal status; Skill identity, task size, worker output, and child dispatch cannot.", "Free-form planning or implementation requests stay read-only until a typed graph passes structural and semantic completeness checks.", "Each admitted formal design, planning, and implementation instance has a stable ID and creates exactly one consumable implicit-review reason for its frozen target across retry and replay.", "Paired tests use the same synthetic worker in formal-root and non-formal-child contexts; the former reviews once and the latter does not gain a formal review reason.", "A semantic worker's attempted review child is intercepted and coalesced with the same-target formal reason, producing one review dispatch and one typed result rather than duplicate reviews.", "Non-formal single-task work with no other reason proceeds directly to verification, while standalone review creates no upstream stage.", "Review uses a compatible discovered worker or a generic fallback and can neither re-enter root capture nor invoke another review workflow."]
failure_policy = "fix_forward"
rollback_trigger = ""
rollback_target = ""
rollback_verification = ""

[tasks.scope]
impl_file_refs = ["extensions/workflow-harness"]
test_file_refs = ["tests/activation.test.ts", "tests/skill-discovery.test.ts", "tests/normalization.test.ts", "tests/review-policy.test.ts", "tests/non-reentry.test.ts"]
external_impl_file_refs = []

[[tasks]]
task_id = "PWH-400"
depends_on = ["PWH-300"]
verification_commands = ["node --experimental-strip-types --test tests/authority.test.ts tests/tool-policy.test.ts tests/execution.test.ts tests/repair.test.ts tests/replay.test.ts tests/settlement.test.ts", "npm run typecheck", "git diff --check -- extensions/workflow-harness tests/authority.test.ts tests/tool-policy.test.ts tests/execution.test.ts tests/repair.test.ts tests/replay.test.ts tests/settlement.test.ts"]
scope_slice = "Complete the managed execution boundary: harness-owned tool capability registry, pre-effect path checks, fail-closed mixed tools and shell, task and attempt admission, typed worker results, observed-operation reconciliation, bounded adjudicated repair, verification, continuation, resume, and settlement."
executor_mode = "main"
parallel_group = "none"
parallel_policy = "forbidden"
delegation_policy = "forbidden"
execution_profile = "deep"
reasoning_profile = "deep"
isolation = "controller-checkout"
resource_locks = ["tool-capability-registry", "authority-ledger", "task-attempt-ledger", "repair-budget", "settlement-state"]
convergence_required = true
review_budget = 1
task_review_depth = "full"
done_when = ["Known read-only tools remain available in managed read-only states, known path mutations are checked before side effects, and unknown or mixed tools fail closed.", "Shell remains denied without an approved isolated executor; one exact user-authorized uncontained operation records suspended containment and cannot be authorized by reusable settings or worker output.", "Only the harness admits a ready task, grants its bounded mutation profile, records observed operations, and accepts a typed worker result.", "Scope escape, protected paths, undeclared external effects, destructive history, credential access, commit, push, publish, and deploy are rejected before authority is granted.", "Review findings are evidence for controller adjudication; at most one accepted same-slice repair is admitted before a typed non-convergent stop.", "Verification is independent of review, child scheduling is replay-idempotent, and settlement is impossible while graph work, review reasons, repair, or verification remains pending."]
failure_policy = "fix_forward"
rollback_trigger = ""
rollback_target = ""
rollback_verification = ""

[tasks.scope]
impl_file_refs = ["extensions/workflow-harness"]
test_file_refs = ["tests/authority.test.ts", "tests/tool-policy.test.ts", "tests/execution.test.ts", "tests/repair.test.ts", "tests/replay.test.ts", "tests/settlement.test.ts"]
external_impl_file_refs = []

[[tasks]]
task_id = "PWH-500"
depends_on = ["PWH-400"]
verification_commands = ["npm ci --ignore-scripts", "npm run check", "bash -n scripts/*.sh", "bash scripts/run-temporary-load-probe.sh", "bash scripts/run-standalone-workflow-probe.sh", "if rg -n 'agent-skills|design-change|plan-change|implement-change|review-change|codingHarness|src/runtime/harness|integrations/pi' . --glob '!docs/plans/**'; then exit 1; fi", "git diff --check"]
scope_slice = "Converge every repository-owned file for the one-extension package, including package bootstrap, fake-Pi adapter tests, settings-cutover tests, synthetic Skill fixtures, redacted temporary-load and disposable-repository probes, stable documentation, and a formal implementation review over the complete repository diff. Author all installed-probe and cutover scripts here; do not change user-level Pi settings in this task."
executor_mode = "main"
parallel_group = "none"
parallel_policy = "forbidden"
delegation_policy = "forbidden"
execution_profile = "deep"
reasoning_profile = "deep"
isolation = "controller-checkout"
resource_locks = ["pi-extension-entrypoint", "synthetic-skill-fixtures", "standalone-probes", "repository-acceptance", "stable-truth"]
convergence_required = true
review_budget = 1
task_review_depth = "full"
done_when = ["The public entrypoint wires only behavior-bearing private modules through Pi's public APIs and exports one diagnostic surface plus typed harness tools.", "All tests and probes use unrelated synthetic Skill names, descriptions, source paths, and response formats, including a no-Skill generic fallback.", "Temporary loading succeeds with ordinary pass-through, managed activation, graph submission, formal-stage review, non-formal review skipping, standalone review, replay, resume, settlement, and extension-off cases.", "Settings-cutover and installed-probe scripts are fully exercised against secret-free fixtures before review and need no repository edit during PWH-600.", "A copied or temporarily loaded package passes while no sibling checkout, generated semantic contract, or Python runtime is available.", "Stable AGENTS, README, and architecture truth match the implemented boundary, and the maintained package surface contains no forbidden collection-specific token or path.", "The formal implementation-stage review covers every repository implementation and test ref, returns pass, or receives no more than one focused accepted same-slice repair followed by focused verification."]
failure_policy = "fix_forward"
rollback_trigger = ""
rollback_target = ""
rollback_verification = ""

[tasks.scope]
impl_file_refs = [".gitignore", "AGENTS.md", "README.md", "docs/architecture", "extensions", "package-lock.json", "package.json", "scripts", "tsconfig.json"]
test_file_refs = ["tests"]
external_impl_file_refs = []

[[tasks]]
task_id = "PWH-600"
depends_on = ["PWH-500"]
verification_commands = ["npm run check", "pi --version", "pi list --no-approve", "bash scripts/run-installed-workflow-probe.sh", "bash scripts/run-settings-conformance-probe.sh /home/csheng/.pi/agent/settings.json", "git diff --check -- scripts tests"]
scope_slice = "After reviewed standalone acceptance, execute the already-reviewed cutover and probe scripts without changing repository files: capture secret-safe metadata and a private recoverable backup of the existing Pi settings file in a controller-owned mktemp directory, replace only the predecessor harness package entry, write only the workflowHarness namespace, and run installed synthetic and extension-off probes. Preserve every other setting structurally and emit no raw configuration."
executor_mode = "main"
parallel_group = "none"
parallel_policy = "forbidden"
delegation_policy = "forbidden"
execution_profile = "deep"
reasoning_profile = "deep"
isolation = "controller-checkout"
resource_locks = ["pi-global-settings", "pi-package-install", "installed-harness-instance", "live-probe"]
convergence_required = true
review_budget = 1
task_review_depth = "full"
done_when = ["Pre-cutover deterministic, standalone, and temporary-load evidence is recorded before the settings write.", "The exact settings file remains a canonical single-link mode-0600 regular file, and a secret-safe structural digest proves all keys outside packages and the harness-owned namespace are unchanged.", "The private backup lives only in a validated controller-owned mktemp directory, is never logged or tracked, remains available through guarded verification, and is removed after either successful convergence or verified restoration.", "Pi loads exactly one workflow-harness package from this repository, while global Skill discovery, provider/model settings, trust, terminal behavior, and telemetry configuration are unchanged.", "Installed probes cover pass-through reads and writes, managed graph execution, the three formal implicit reviews, non-formal review skipping, independent standalone review, generic review fallback, repair exhaustion, resume, replay, settlement, and extension-off behavior.", "Probe output is redacted, disposable repositories are removed after evidence capture, and no commit, push, publish, remote creation, deployment, or provider/model change occurs."]
failure_policy = "guarded_rollback"
rollback_trigger = "Any required startup, unique-load, pass-through, activation, authority, graph, review, replay, resume, settlement, or extension-off probe fails after the settings replacement."
rollback_target = "Restore only the captured predecessor package entry and previous harness-owned settings namespace in /home/csheng/.pi/agent/settings.json from the private backup; preserve every other setting and all repository source."
rollback_verification = "Run pi --version, pi list --no-approve, one ordinary pass-through probe, and one extension-off probe, then confirm the secret-safe structural digest outside packages and the harness-owned namespace still matches the pre-cutover baseline."

[tasks.scope]
impl_file_refs = []
test_file_refs = []
external_impl_file_refs = ["/home/csheng/.pi/agent/settings.json"]
+++
# Plan

## Implementation

Execute `PWH-100` through `PWH-600` serially. `PWH-100` establishes the standalone
package and truth boundary; `PWH-200` builds graph and replay mechanics; `PWH-300` adds
Skill-agnostic capture, normalization, and review dispatch; `PWH-400` completes tool
authority and execution; `PWH-500` converges independent acceptance and the single
formal implementation review; `PWH-600` performs the separately guarded machine-local
settings cutover.

Architecture decision reference: `PWH-001..PWH-009`. The reversible increments are
repository bootstrap, pure state and graph core, read-only semantic dispatch, managed
execution gates, standalone package convergence, and finally exact settings cutover. No
task consumes source, tests, contracts, generated output, or fixtures from a Skill
repository. No parallel batch or delegated writer is authorized because every runtime
slice mutates the same state machine and the final task owns one exact global setting.

The new persisted implementation boundary is TypeScript. Pi loads TypeScript extension
entrypoints and its public API already supplies the event, tool, command, and session
types needed by the harness. Go and Python would add a sidecar protocol and a second
failure boundary without improving enforcement at the pre-tool event. Node's built-in
test runner, TypeScript type checking, and a minimal schema dependency are preferred;
new dependencies require a concrete public-API or validation need and a locked version.
Shell remains limited to thin redacted probes over documented Pi, Git, and JSON commands.

`review_budget = 1` is a ceiling for an accepted focused repair on a task slice, not a
request to review every task. The planned implicit implementation review occurs once at
the converged `PWH-500` boundary. The design review has already passed, and this plan
receives its one mandatory plan review before approval.

## Work Package Readiness

- `milestone_objective`: create one independent generic Pi workflow harness that can
  normalize and enforce managed work with arbitrary discovered Skills or no Skills, then
  install it locally without disturbing unrelated Pi configuration.
- `non_goals`: a known Skill protocol, a second extension, multi-writer execution,
  provider/model routing, remote creation, publication, commit, push, deployment, Pi-core
  changes, or a global mutation guard outside managed mode.
- `future_phase`: split another extension only after standalone ownership and lifecycle
  demand exists; consider isolated parallel executors only after a separately designed
  containment mechanism can prove disjoint writes and resource locks.
- `decision_status`: `ready_for_approval`; the repository-local design is approved and
  valid, and no unresolved architecture choice blocks the serial plan.
- `language_decision`: TypeScript for the Pi-loaded persisted boundary; Bash only for
  bounded orchestration probes; no Python or sidecar business logic.
- `oracle_strategy`: model/state-machine tests for lifecycle and replay, property tests
  for graph and authority invariants, fake-Pi component tests for public API integration,
  characterization cases rewritten as generic behavior, temporary-load tests, synthetic
  Skill workflows, disposable-repository runtime probes, secret-safe settings
  conformance, and forbidden dependency scans.
- `acceptance_oracles`: each task's exact commands and `done_when` predicates, then one
  bounded implementation review of the converged repository diff and the guarded live
  probes after installation.
- `max_review_batches`: `2`; one plan boundary review before approval and one formal
  implementation review at `PWH-500`. A focused repair uses the same batch budget rather
  than opening a new lifecycle.
- `subagent_ready`: `false`; the state, graph, tool gate, extension entrypoint, package
  manifest, and settings cutover are causally coupled, so the serial main actor is the
  smallest safe write topology.

## Execution Continuity

- `execution_mode`: `pending_confirmation`.
- `confirmation_clearance`: `C0` is the user's approval of this exact plan digest and the
  declared external settings file. It authorizes repository-local mutation inside the
  task scopes plus one guarded settings cutover; it does not authorize commit, push,
  remote creation, publication, deployment, provider/model changes, or another external
  target.
- `expected_continuous_range`: after `C0`, `E1 = PWH-100..PWH-500`; after the
  implementation review passes, `E2 = PWH-600`. Task completion is a progress marker,
  not an implicit human stop.
- `runtime_contingencies`: `X1` stops for a missing Pi public hook needed for pre-effect
  enforcement; `X2` stops if opaque native Skill selection cannot be observed without
  repository assumptions; `X3` stops if standalone or formal-review behavior requires a
  known Skill format; `X4` stops on credential exposure, external scope drift, duplicate
  package loading, provider/model drift, repeated repair, or a failed guarded restore;
  `X5 = cutover_probe_failed_restored` stops after any required `PWH-600` functional
  probe fails and the exact settings restoration succeeds. `X5` preserves redacted
  failure and restoration evidence and authorizes no in-plan repository repair or
  cutover retry.
- `planned_stop_points`: `C0` only. `PWH-500` to `PWH-600` is an internal review and
  safety gate, not another approval request, unless an `X*` condition changes scope or
  authority.
- `task_ordering_rationale`: establish the package and test contract before code, prove
  pure deterministic mechanics before Pi binding, prove read-only activation before
  mutation authority, converge the full standalone product before reviewing it, and
  touch global settings only after that review passes.

## Recovery

`default_failure_policy: fix_forward`. Before cutover, preserve the smallest failing
fixture or session entry, repair only its owning task slice, rerun the focused oracle,
and continue after convergence. One accepted causally bound implementation finding may
receive one same-slice repair; repeated or plan-expanding failure produces the matching
`X*` stop.

`PWH-600` alone has guarded rollback authority. Its exact trigger, target, and
verification are recorded in task metadata. The settings backup must be private,
content-free in logs, and retained until installed probes pass. Recovery never deletes
the repository, rewrites another checkout, introduces a known Skill dependency,
destructively resets history, commits, pushes, publishes, deploys, or changes provider
credentials.

If any required installed functional probe fails and restoration verifies successfully,
the controller emits `X5 = cutover_probe_failed_restored`, preserves the redacted failing
probe plus restoration evidence, and stops. It does not reopen `PWH-500`, mutate the
reviewed repository, or retry cutover under this plan. A later repair requires its own
bounded plan and review authorization. A failed restoration remains the higher-severity
`X4` stop.

## Truth Sync Handoff

`truth_sync_required: true`. Stable truth targets are `AGENTS.md`, `README.md`, and
`docs/architecture/workflow-harness.md`. They must describe the one-extension product,
pass-through activation, typed graph, tool authority, conditional review reasons,
non-reentry, replay, settlement, independent verification, local installation, and exact
recovery boundary. Stage artifacts remain historical execution evidence and are not a
runtime contract.

Truth-sync predicates are `repository-ownership`, `public-package-surface`,
`managed-activation`, `skill-agnostic-discovery`, `review-reason-semantics`,
`tool-authority`, `standalone-oracles`, and `settings-recovery`. No stable truth or test
may name or locate a particular Skill repository.
