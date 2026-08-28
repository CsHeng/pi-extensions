+++
artifact_kind = "design"
contract_version = 4
approval_status = "approved"
truth_impact = "high"
truth_sync_required = true

[scope]
impl_file_refs = [".gitignore", "AGENTS.md", "README.md", "docs/architecture", "extensions", "package-lock.json", "package.json", "scripts", "tsconfig.json"]
test_file_refs = ["tests"]
external_impl_file_refs = ["/home/csheng/.pi/agent/settings.json"]
+++
# Design

## Problem

Pi needs an optional workflow harness that owns mechanical workflow behavior without
depending on any particular Skill collection. Installing the extension must not change
ordinary Pi reads or writes by default, and enabling managed execution must provide a
deterministic task graph, mutation boundary, review policy, replay model, and terminal
state even when no suitable Skill is installed.

The repository is initially empty. Its first product boundary therefore needs to define
both the Pi package and the complete harness behavior. The package may host multiple
extensions over time, but the current capabilities share one state machine, ledger, tool
gate, and settlement boundary and are one extension until independent product demand
exists.

## Goals

- Publish one local Pi package with one `workflow-harness` extension entry.
- Keep pass-through as the default and enter managed mode only through an explicit
  harness request, an admitted typed graph, or an observable root selection of a
  discovered design, planning, or implementation capability.
- Discover optional semantic workers only through Pi's public Skill command metadata and
  opaque source paths; assume no names, repositories, private metadata, or output schema.
- Freeze free-form proposals and normalize them through a typed task-graph tool before
  any managed mutation.
- Own graph validity, readiness, isolation, locks, attempts, tool authority, review
  reasons, repair budget, verification, replay, resume, and settlement inside the
  extension.
- Treat completed formal design, planning, and implementation roles as three explicit
  implicit-review reasons, with exactly one bounded non-reentrant review child per role.
  Do not automatically review ordinary pass-through or non-formal single-task work.
- Admit formality only from a persisted root-level harness decision with an authorized
  source; never let a Skill name, task size, worker output, or child dispatch assign it.
- Keep standalone user-invoked review as an independent bounded root operation that does
  not synthesize design, planning, or implementation.
- Prefer a compatible discovered review Skill when review is required and use a built-in
  generic reviewer when none is available.
- Prove the package with unrelated synthetic Skills and disposable repositories, then
  replace only its predecessor package registration and harness-owned settings while
  preserving all other Pi configuration.

## Non-Goals

- No known Skill IDs, known Skill repository, provider-specific semantic contract,
  generated lifecycle projection, sibling lookup, or shared release gate.
- No authoritative Markdown parser. Prose and referenced artifacts are frozen evidence;
  only a graph submitted through the harness-owned typed tool becomes executable state.
- No universal review phase and no backwards lifecycle transition initiated by a review
  worker.
- No global mutation guard merely because the extension is installed. Unmanaged Pi
  behavior remains Pi behavior.
- No parallel or delegated writer in the initial package. The schema may reject or
  preserve future topology fields, but the first executor is serial and local.
- No commit, push, remote creation, package publication, deployment, provider/model
  reconfiguration, or Pi-core patch.
- No second extension until a capability is independently installable, configurable,
  testable, removable, and state-owning.

## Boundaries

### PWH-001: Repository And Package Boundary

The repository owns one private local package and all of its source, tests, probes,
TypeScript configuration, and stable documentation. TypeScript is the implementation
language because Pi loads
TypeScript extension entrypoints and exposes typed event, command, tool, and session
interfaces. Node's test runner supplies the fast deterministic lane. Shell scripts may
orchestrate bounded Pi and Git probes but own no state machine, parser, policy, or durable
schema.

The package initially exposes exactly `extensions/workflow-harness/index.ts`. Internal
modules remain private to that extension. A future second extension requires a separate
public purpose and private state boundary; code organization alone is not a reason to
split the installed surface.

### PWH-002: Activation And Lifecycle

Pass-through is the initial state. Managed mode begins only after an observable entry:

1. an explicit harness command carrying `formalRole = design | planning |
   implementation | none`;
2. an approved typed graph whose root admission records one of those role values; or
3. explicit or model-driven root use of a Pi-discovered Skill whose current description
   is resolved through a typed result to design, planning, or implementation intent.

Explicit `/skill:<name>` input is observed before expansion. Model-driven selection is
correlated only when the model reads the exact opaque `sourceInfo.path` reported by Pi
for a currently discovered Skill. The extension does not walk that path or infer a
repository layout. Extension-originated child calls carry run and dispatch markers so
they cannot activate another root workflow.

Capability resolution and formal admission are separate decisions. A discovered
description may resolve the intent of a Skill already selected at the root, but a name,
description match, task size, response text, or worker-submitted result cannot mark an
arbitrary task formal. Only the root admission sources above may do so. An explicit
single-task harness request may record `formalRole = none`; ordinary pass-through has no
formal role. The same synthetic Skill can therefore be a formal root worker in one run
and a non-formal child or ordinary capability in another. A child marker always wins
over capability text and can never create a formal stage.

Every admitted formal role receives a stable `stageInstanceId` derived from the run,
role, role ordinal, and frozen admission digest. The session stores that ID before worker
dispatch. Retry, replay, resume, fork, and compaction reuse the same instance rather than
creating another one.

The harness owns `capture -> normalize -> approval -> execute -> assess -> verify ->
settle`, plus typed blocked and repair outcomes. Semantic design, planning,
implementation, diagnosis, and review are bounded roles inside those states, not a
second lifecycle. Disabling the extension restores ordinary Pi behavior and leaves Skill
discovery to Pi.

### PWH-003: Skill Discovery And Child Dispatch

Each dispatch snapshots Pi commands whose public source kind is `skill` and uses only the
reported name and description for capability resolution. Explicit compatible user
selection wins. Otherwise a read-only resolver must select one current candidate or
`none` through a typed result. Ambiguity that materially changes behavior is surfaced;
safe roles with a built-in fallback may select `none`.

A selected Skill is invoked through Pi's native Skill command expansion. The harness
supplies a separate bounded brief keyed by opaque run, stage, task, and attempt IDs.
Worker output is untrusted evidence. A child cannot grant authority, alter the graph,
advance state, schedule a sibling, or recursively invoke the harness lifecycle.

### PWH-004: Proposal Capture And Task Graph

Planning output may be prose, a checklist, a table, or a referenced artifact. The
harness freezes the relevant messages and explicitly referenced workspace files by
digest, then asks a normalization worker to call `submit_task_graph`. An implementation
request without a graph is held read-only while the same normalization occurs; it never
mutates first and reconstructs authority afterward.

The graph records stable task IDs, dependencies, descriptions, declared reads and
writes, locks, isolation, executable verification, completion evidence, review policy
and reasons, bounded attempts, and recovery. Deterministic admission rejects duplicate
IDs, missing dependencies, cycles, unreachable work, unsafe paths, conflicting locks or
touch sets, invalid parallel shape, missing oracles, and unbounded attempts. A separate
semantic completeness check compares the frozen proposal with the graph for omissions,
inventions, and unauthorized ordering changes.

### PWH-005: Mutation And Tool Authority

The extension owns a capability registry for observable Pi tools. Read-only tools remain
available during capture and review. Known path-bearing mutation tools are checked before
execution against the admitted workspace and exact task slice. Unknown or mixed tools
fail closed in managed mode.

Unrestricted shell is denied unless the exact task has an approved isolated executor.
The user may authorize one exact uncontained operation, but that decision is recorded as
an explicit suspension of path-containment guarantees and cannot be inherited from a
profile or Skill response. Protected paths, credentials, destructive history, external
effects, commit, push, publish, and deployment require explicit separate authority and
remain outside this milestone.

### PWH-006: Review Semantics

Review is a conditional non-reentrant child call. The harness persists its target and one
or more recorded reasons. The default reasons are:

- completion of a formal design role;
- completion of a formal planning role;
- completion of a formal implementation role;
- explicit user request;
- admitted task policy or machine-local risk policy; or
- observed risk such as scope divergence, sensitive mutation, repaired verification, or
  an uncertain terminal claim.

Each formal-role reason is keyed by `stageInstanceId` and consumed once for that role
instance. Retry, replay, or repeated worker output cannot enqueue it again. Multiple
reasons may be coalesced only when they have the same frozen target and acceptance
boundary. With no reason, the lifecycle continues directly. A small non-formal task
therefore does not pay for review merely because the extension is installed.

The review resolver uses current Skill descriptions and falls back to a generic review
worker. Either worker returns findings through a typed result. The harness/controller
adjudicates evidence, owns the single focused same-slice repair allowance, and performs
verification separately. Review cannot reopen capture, invent an upstream phase, call
another review, or expand scope. A standalone review request creates only a frozen
review target and settles from that root operation.

If an active semantic worker requests or attempts a review child as part of its own
guidance, the harness intercepts that child dispatch before invocation and records a
`worker-requested-review` reason. It never lets the worker run review inline. When the
request names the same frozen target and acceptance boundary as the formal-stage reason,
the reasons coalesce into the one dispatch keyed by `stageInstanceId`; the typed result
satisfies both. A different target remains a distinct bounded reason or is rejected as
scope expansion. This rule is generic for any child call and does not depend on a known
review Skill or repository.

### PWH-007: State, Replay, And Settlement

Versioned Pi session entries persist request identity, workspace, authority provenance,
selected worker snapshots, proposal and graph digests, task and attempt state, observed
operations, locks, evidence, review reasons and findings, repair consumption,
verification, pending child calls, and terminal result. Replay consumes only the active
branch and makes child scheduling idempotent across retry, resume, fork, and compaction.

Only typed tools and Pi lifecycle events advance state. Assistant prose cannot mark a
task or workflow complete. Settlement occurs only after pending calls and repairs drain,
the admitted graph is terminal, required verification has passed, and every recorded
review reason has been consumed or has a typed blocked outcome.

### PWH-008: Independent Verification

All fixtures use synthetic names, descriptions, response formats, and source paths. The
suite covers no-Skill fallback, Skill reload, ambiguous discovery, explicit and
model-driven selection, proposal freezing, graph properties, authority denial before
side effects, formal-stage implicit review, non-formal review skipping, standalone
review, non-reentry, repair exhaustion, replay, resume, settlement, and extension-off
behavior. Paired cases use the same synthetic worker once as an admitted formal root and
once as a non-formal child or single task to prove that context, not Skill identity,
assigns formality; retry and replay prove stage-review deduplication. Another paired
case has the formal worker request review itself and proves that the worker reason and
formal-stage reason produce one review dispatch rather than two.

Acceptance includes forbidden-token and path scans that prevent any particular Skill
collection, repository layout, generated semantic contract, or Python runtime from
becoming a dependency. Temporary-load and installed-package probes run from disposable
Git repositories and report only redacted state summaries.

### PWH-009: Local Settings Cutover

Cutover occurs only after deterministic, component, temporary-load, and standalone
probes pass. Capture a secret-safe structural digest and recoverable private backup of
`/home/csheng/.pi/agent/settings.json`; do not print raw configuration. Replace only the
predecessor harness package entry and migrate only the harness-owned settings namespace.
Leave Skill roots, provider/model configuration, terminal settings, trust, and all other
keys unchanged.

After cutover, prove exactly one harness instance, ordinary pass-through, extension-off
behavior, graph admission, formal implicit reviews, non-formal review skipping,
standalone review, generic review fallback, replay, and resume. Any failed required probe
restores only the captured package entry and harness namespace, verifies Pi startup and
pass-through, and leaves repository source intact for diagnosis.

## Validation

- Node unit and model-based tests own lifecycle, graph, review, authority, and replay
  invariants.
- Property tests generate graph shapes, dependency orders, locks, scopes, and capability
  classifications to prove default-deny and readiness invariants.
- Fake-Pi component tests own public event, command, tool, session, and Skill-discovery
  adapter behavior.
- Temporary-load tests and disposable-repository probes own package loading and live Pi
  behavior.
- Secret-safe settings probes own structural preservation; they never expose raw values.
- Repository checks own formatting, types, package metadata, docs, shell syntax, and
  forbidden dependency scans.

## Recovery Policy

Use fix-forward before settings cutover. Preserve the smallest failing fixture and repair
only the owning module. After cutover, any startup, uniqueness, pass-through, authority,
review, replay, or settlement failure triggers the exact settings restoration described
in PWH-009 before further diagnosis. Do not delete the repository, destructively reset
another checkout, create a remote, commit, push, publish, deploy, or add a private Skill
contract as a workaround.

## Approval

This repository-local projection contains only the Pi product boundary already approved
by the user on 2026-08-28. The approved review policy is one implicit bounded review for
each completed formal design, planning, and implementation role; ordinary non-formal
work has no automatic review, and standalone review is independent. The projection may
advance to planning after validation and focused boundary review.
