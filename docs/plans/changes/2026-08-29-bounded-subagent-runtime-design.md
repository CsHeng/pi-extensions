+++
artifact_kind = "design"
approval_status = "approved"
decision_state = "approved"
truth_impact = "high"
truth_sync_required = true
+++
# Bounded subagent runtime design

## Objective

Add a self-owned Pi subagent runtime that makes bounded delegation materially useful for independent repository work. The runtime must support deterministic parallel scheduling and user-controlled per-role model routing without installing, depending on, vendoring, or forking a community subagent extension.

The selected boundary is a foreground delegation executor inside `pi-extensions`, not a replacement coding-agent loop. One parent Pi tool call may submit a bounded directed acyclic graph (DAG), wait for all reachable work to settle, and receive structured results. The parent Pi remains responsible for scope, authority, synthesis, verification, review adjudication, continuation, and the final response.

## Current truth

- The package currently exposes independent `plan-mode` and `multi-skill-mentions` extensions.
- `plan-mode` activates exactly `read`, `grep`, `find`, and `ls`; it owns no task graph or delegation behavior.
- `multi-skill-mentions` uses Pi's loaded Skill command registry and owns no Skill discovery or execution semantics.
- The package currently registers no model-callable tool and does not bind child models.
- Pi's public extension context exposes the active parent model, thinking level, scoped models, model registry, abort signal, tool registration, lifecycle events, and process execution support.
- Pi's official subagent example demonstrates isolated `pi --mode json -p --no-session` subprocesses, parent model inheritance, JSONL event parsing, bounded parallelism, temporary prompt files, cancellation, usage aggregation, and TUI rendering. Its flat parallel array, linear `{previous}` chain, dynamic agent discovery, and direct per-agent model pinning are reference mechanisms rather than the required product contract.
- The previously approved `workflow-harness` stage artifacts describe a persistent lifecycle engine. Commit `a69506e` replaced that implementation with the current thin plan profile. Those artifacts remain historical stage evidence and are not current runtime truth.
- Semantic Skills and this package are independently installed and maintained. Current Skills may describe delegation eligibility, but no Skill is a runtime dependency of this repository.

## Problem and demand

A single parent agent serializes independent repository searches, bounded implementation slices, and review perspectives even when their dependencies and write surfaces are already separable. It also spends the parent model's latency and cost on roles that may have different capability needs. Repeated demand now exists for concurrent explorers, isolated workers, independent reviewers, deterministic fan-out and fan-in, and explicit model routing.

The constrained resources are parent context, wall-clock latency, provider concurrency, and safe writable workspace access. A flat parallel helper does not express dependency joins or resource locks. A full workflow harness would supply much more lifecycle state and policy than this demand requires and would recreate ownership already held by the parent Pi and semantic Skills.

## Constraints

- Skills, Pi upstream, and `pi-extensions` remain independently owned and independently installable.
- The extension cannot assume a Skill name, Skill repository, output schema, or provider-specific semantic contract.
- Child roles are code-owned and fixed for the first release: `explorer`, `reviewer`, and `worker`.
- Children cannot recursively delegate, choose arbitrary tools, choose their own model, change working directory, load arbitrary extensions or Skills, or widen the submitted scope.
- `worker` has no `bash`; it may create or modify only exact declared files through `edit` and `write`.
- Parallel writable tasks require isolated snapshots and disjoint exact write paths.
- The extension remains foreground-only and stores no durable graph, mission, retry ledger, background job, or resume state.
- The extension does not add its tool to `plan-mode`; the four-tool plan profile remains unchanged.
- No implementation task changes global Pi settings, credentials, provider configuration, the parent session model, or a Skill repository.
- When the extension is disabled, ordinary Pi behavior is unchanged. When enabled but not called, its only effects are tool registration, status or route diagnostics, and the configured delegation guidance; it starts no child, binds no child model, and mutates no workspace.

## Ownership and authority

### Three persisted truth owners

The architecture record should describe three component boundaries. It must not pretend that one repository owns all three implementations.

| Truth owner | Owns | Does not own | Canonical source |
| --- | --- | --- | --- |
| Skills | Provider-neutral semantic guidance: decomposition quality, delegation eligibility, bounded review semantics, authority reminders, and completion evidence expected from the calling agent | Pi process creation, concrete models, tool allowlists, physical scheduling, cancellation, workspace isolation, or session persistence | The installed Skill source and its owning Skill repository |
| Pi | The authoritative host loop, active parent agent turn, model catalogue and authentication, model and thinking selection, tool execution, session lifecycle, project trust, extension loading, and user interaction | This package's role policy, DAG validation, child capability manifest, or snapshot convergence algorithm | Pi's public API, installed documentation, and runtime behavior |
| `pi-extensions` | The `csheng_subagents` tool contract, fixed role capabilities, route resolution, DAG validation, ready-task scheduling, concurrency and locks, subprocess lifecycle, child path guard, isolated writable snapshots, CAS convergence, bounded result capture, and removal semantics | Semantic lifecycle phases, plan approval, review adjudication, accepted repair, final verification, continuation, or the final user response | `docs/architecture/subagents.md`, package tests, and the extension source |

The stable `pi-extensions` document will be a boundary map, not a duplicate specification of Pi internals or Skill content. It will point readers to the external owner's current truth where details belong.

### Runtime actors

Component ownership is separate from runtime authority:

- The user grants approval-sensitive authority, selects or accepts cost policy, and may cancel work.
- The parent Pi constructs the bounded task graph, selects the semantic slices, invokes the extension, evaluates returned evidence, verifies the converged checkout, adjudicates reviewer candidates, and decides what happens next.
- The extension validates and executes only the submitted graph under its hard ceilings. It does not infer an upstream lifecycle or invent tasks.
- Each child executes one role-scoped task and returns evidence. Child output is an untrusted claim, not authority or proof of completion.

## Architecture decision

### Selected option: bounded foreground DAG executor

Register one model-callable tool named `csheng_subagents`. The tool accepts one bounded task array; a one-element array is the single-child case. Dependencies make the same schema express serial chains, flat parallel work, fan-out, and fan-in. No separate string, nested chain, workflow, or mission DSL is introduced.

The parent owns logical topology by submitting task IDs and dependencies. The extension owns physical readiness, route binding, concurrency, and failure propagation. The complete graph is validated before any child starts.

This option is the smallest durable boundary that satisfies current parallel and routing demand while preserving the parent Pi loop. It adds an in-memory scheduler inside one tool execution but no second lifecycle controller.

### Rejected: retain only one foreground child

A single-child tool provides context isolation but leaves independent work serial and cannot amortize parent latency. It does not satisfy the stated demand for parallel research, implementation, and review.

### Rejected: official-style separate single, parallel, and `{previous}` chain modes

Separate modes duplicate validation and cannot naturally represent a fan-in join, resource lock, or a graph with both serial and parallel edges. Injecting an entire previous response through string replacement is difficult to bound and obscures data provenance. The typed DAG subsumes these modes with one contract.

### Rejected: dynamic role files or community runtime installation

Dynamic role discovery allows repository or user files to alter tools, prompts, and concrete model pins outside the reviewed package contract. Installing or forking a community runtime adds an external behavior and upgrade owner. Fixed code-owned roles plus a narrow user-owned route file are more predictable.

### Rejected: persistent workflow harness

A persistent harness would own approval, phases, attempts, replay, repair, review gates, and settlement. That duplicates parent and Skill authority, adds recovery and migration obligations, and exceeds the current foreground delegation demand. The historical workflow-harness artifacts are not revived.

### Deferred: in-process `createAgentSession()` children

An in-process child could reduce process startup cost, but it shares more runtime state and makes cancellation, extension isolation, and failure containment harder to establish initially. Independent Pi subprocesses provide a documented protocol and a clean recursive-delegation boundary. In-process sessions may be reconsidered only after subprocess startup is measured as a material bottleneck and equivalent isolation tests exist.

## Public tool contract

Each task contains:

- `id`: stable unique ID within the invocation
- `role`: `explorer | reviewer | worker`
- `objective`: one bounded outcome
- `scope`: repository-relative read roots
- `inputs`: optional bounded text supplied by the parent
- `dependsOn`: predecessor task IDs
- `writePaths`: exact repository-relative files; required for `worker` and forbidden for other roles
- `verification`: expected evidence or checks for the parent; never an executable child command
- `resourceLocks`: optional stable names that prevent simultaneous execution

The tool does not accept an arbitrary `cwd`, concrete model, tool list, command, extension, Skill path, retry count, background flag, or nested graph.

Hard first-release ceilings are eight tasks per call, four total concurrent children, two concurrent workers, bounded prompt and predecessor-result bytes, bounded stderr and output, and a fixed per-task timeout. User configuration may lower but not raise hard ceilings.

Graph admission rejects duplicate or unsafe IDs, unknown dependencies, cycles, excessive size, invalid roles, path escape, symlink-mediated writable escape, overlapping write paths between potentially concurrent tasks, conflicting locks, missing worker write paths, and role-incompatible fields before spawning any child.

## Role contracts

| Role | Tools | Purpose | Additional boundary |
| --- | --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls` | Bounded factual repository search and evidence collection | No design synthesis, mutation, or recursive delegation |
| `reviewer` | `read`, `grep`, `find`, `ls` | Bounded evaluation that returns candidate findings | No repair, final adjudication, scope expansion, or recursive delegation |
| `worker` | `read`, `grep`, `find`, `ls`, `edit`, `write` | Implement one approved exact-file slice | No `bash`, deletion, rename, peer integration, review adjudication, or recursive delegation |

Role authority is independent of model strength. A stronger route never grants additional tools, paths, or lifecycle authority.

## Per-role model routing

Concrete route policy belongs to a user-owned `csheng-subagents.json` under Pi's public agent directory returned by `getAgentDir()`; the default location is `~/.pi/agent/csheng-subagents.json`. The package and Skills contain no concrete provider or model identifiers. Project repositories cannot provide or override model routes in the first release.

For each role, configuration may declare an ordered candidate list of `{ model, thinking }` pairs and a role concurrency limit. `$parent` means the active parent model or thinking level. The absent-file default is exact parent inheritance for every role. Configuration may also set delegation guidance to `off`, `balanced`, or `aggressive`; the requested product default is `aggressive`, which encourages the parent to fan out two or more independent bounded slices but never starts children without a parent tool call.

Route resolution uses `ctx.model`, `ctx.thinkingLevel`, `ctx.scopedModels`, and `ctx.modelRegistry`. The first authenticated candidate inside the active session scope wins. The extension passes both `--model` and `--thinking` explicitly. If no declared candidate is usable, the task returns `route_unavailable`; runtime failure does not silently retry through another route or downgrade below the declared candidate.

The route file is read-only input to this extension. The implementation and installation plan will not create or modify it. Invalid configuration disables subagent dispatch with a visible diagnostic but does not prevent Pi or the other extensions from starting.

## Scheduling and failure semantics

The scheduler maintains an in-memory status for each task: `pending`, `running`, `succeeded`, `failed`, `blocked`, or `aborted`. Ready tasks have all dependencies succeeded and no active lock, write-path, role, route, or global-cap conflict. Stable input order breaks readiness ties.

A failed task blocks its transitive dependents. Independent branches continue so that already purchased work is not discarded. There is no automatic retry in the first release. Successful independent worker changes may remain converged when another branch fails; the aggregate result is `partial`, and the parent owns fix-forward diagnosis. The extension performs no automatic rollback.

Predecessor status and bounded final output are added to a dependent child's prompt. Output truncation is explicit. A child's prose cannot add tasks, release locks, alter dependencies, or mark another task complete.

## Child process and capability boundary

Each child is a separate non-session Pi JSON-mode process with explicit model, thinking level, role tools, role prompt, and task prompt. The runner reuses the current Pi executable when it can identify it and falls back to the documented `pi` command only when necessary. Discovery is disabled for extensions, Skills, and prompt templates. The package explicitly loads only `child-capability-guard.ts`; the subagent tool itself is unavailable in the child.

Dispatch requires `ctx.isProjectTrusted()` so a child cannot silently cross Pi's project-resource trust boundary. Because an isolated snapshot has a temporary path, the child receives explicit one-run project approval only after that parent trust check. Repository context files then remain available for repository-specific instructions.

The capability guard receives a mode-0600 manifest containing the isolated root, allowed read roots, and exact write paths. It intercepts path-bearing built-in tools, canonicalizes existing paths or the nearest existing ancestor, and rejects absolute escape, `..` escape, symlink escape, and writes outside the exact allowlist. Runtime changed-path reconciliation provides a second enforcement layer.

Prompt, manifest, stdout-spill, and workspace directories use private temporary permissions. Probe and rendered output never include raw prompts, route configuration, credentials, environment values, or external file content.

## Writable snapshot and convergence

Read-only children may operate against the parent checkout because they have no mutation tools. Every worker receives a private filesystem snapshot created from the current Git working tree's tracked files and non-ignored untracked files; `.git`, ignored content, and external files are excluded. The snapshot therefore includes current staged and unstaged source state without sharing a writable checkout.

The extension records baseline type, mode, existence, and content digest for each exact write path. A successful worker is accepted only when the observed snapshot mutations are create-or-modify operations inside its declared paths. Deletion, rename, permission change, unexpected path mutation, or write through a symlink fails the task.

Convergence rechecks the corresponding parent path against the baseline. An unchanged parent receives the worker bytes through an atomic same-directory replacement. A missing baseline path may be created only if it is still missing. Any parent drift produces `convergence_conflict`; the extension does not merge or overwrite it. Downstream tasks become ready only after successful convergence.

Writable delegation requires a Git repository so ignored material can be excluded predictably. A non-Git workspace returns `writable_isolation_unavailable`; the parent may execute that slice directly. Read-only delegation remains available.

## Result and cancellation contract

The aggregate result records invocation status, each task's role and runtime status, effective route, duration, bounded final output, usage, stop reason, observed changed paths, convergence state, and typed error. It does not treat child self-reported completion as verification.

Parent abort stops new scheduling, sends `SIGTERM` to every live child, sends bounded `SIGKILL` when needed, marks unsettled work aborted, and removes private temporary resources. `session_shutdown` performs the same idempotent cleanup. Cleanup failure is reported without exposing raw temporary content.

## Skills composition

Skills may recommend that the active parent split independent searches, writes, or review perspectives and may describe semantic complexity. They must remain provider-neutral and cannot prescribe this tool's concrete model, process flags, scheduler, attempt recording, or workspace algorithm.

The intended compositions are:

- planning semantics may use parallel explorers for factual evidence while the parent retains synthesis and plan ownership;
- implementation semantics may delegate approved, independent, exact-file slices while the parent retains verification, repair, and continuation;
- review semantics may delegate bounded reviewer perspectives while the parent retains candidate adjudication.

A graph cannot cross a decision point that requires parent verification, authority, synthesis, or adjudication. The parent uses separate tool calls around such a point; for example, it converges and verifies worker output before submitting a later review batch when the active semantic workflow requires verification-first ordering. Dependencies inside one graph carry only child-result data and mechanical readiness.

The extension does not load evaluator Skills into children in the first release. The parent supplies the bounded objective and acceptance context. Any later explicit Skill-loading bridge requires a separate design because it would introduce a new discovery and prompt-provenance boundary.

## Scope

The implementation milestone includes:

- `extensions/subagents/` role, schema, routing, scheduler, subprocess, guard, snapshot, convergence, tool, lifecycle cleanup, and rendering modules;
- deterministic unit, generated-graph, fake-Pi, disposable-Git, and subprocess tests;
- package registration and direct runtime dependency updates;
- redacted temporary-load and installed-package probes;
- `AGENTS.md`, `README.md`, and `docs/architecture/subagents.md` truth updates;
- regression proof for `plan-mode` and `multi-skill-mentions`.

The milestone does not modify the Skill repository. Any provider-neutral Skill wording or Skill contract metadata adjustment is a separately approved change in that repository after this runtime contract is verified.

## Non-goals

- No community extension installation or source import.
- No dynamic roles, arbitrary agent files, natural-language model selector, task-specified concrete model, or provider-specific repository default.
- No background execution, durable graph, replay, resume, mission, scheduler daemon, or cross-session child state.
- No parent-loop tool interception, approval protocol, review gate, repair budget, settlement, or generic permission framework.
- No child `bash`, test command runner, deletion, rename, commit, push, publish, deploy, network operation, or external-file write.
- No automatic model retry or fallback after process launch.
- No plan-mode integration and no change to its exact read-only tool list.
- No global Pi settings, provider, model, credential, or user route-file mutation.
- No installation, commit, push, publication, or deployment as part of repository implementation.

## Future phases and upgrade triggers

- Add a constrained verification command job only after repeated approved slices cannot be safely validated by the parent after convergence and a command allowlist, timeout, output, and resource-lock contract is separately designed.
- Consider durable run state only after observed interrupted foreground runs create a real resume requirement that cannot be resolved from the parent checkout and current session result.
- Consider copy-on-write or worktree-backed snapshots only after measured snapshot time or disk use is a material portion of delegated runtime and the replacement preserves dirty-tree fidelity and CAS convergence.
- Consider a read-only plan-profile delegation surface only after a separate design proves that it cannot expose the worker role or alter `/plan` restoration semantics.
- Consider additional roles or semantic route profiles only after recurring tasks cannot fit the fixed explorer, reviewer, or worker authority without widening those roles.

## Acceptance evidence

- Contract tests prove fixed roles, exact tools, schema limits, forbidden task fields, no recursive delegation, and package independence from any Skill collection.
- Generated DAG tests prove cycle rejection, deterministic ready ordering, fan-out and fan-in, dependency blocking, locks, write conflicts, and all concurrency ceilings.
- Routing tests prove parent inheritance, ordered candidate selection, scoped-model enforcement, explicit model and thinking arguments, invalid-config isolation, and no silent fallback.
- Runner tests prove JSONL fragmentation handling, usage aggregation, output caps, timeout, abort, TERM-to-KILL escalation, spawn failure, non-zero exit, and cleanup.
- Guard tests prove repository containment, exact write paths, path traversal rejection, symlink rejection, and role-tool enforcement.
- Disposable-Git tests prove dirty tracked and non-ignored untracked snapshot fidelity, ignored-file exclusion, exact changed-path reconciliation, atomic create or modify, partial-success behavior, and CAS conflict refusal.
- Fake-Pi tests prove tool registration, aggressive guidance without autonomous spawning, project-trust refusal, explicit child approval only after parent trust, model-context use, progress rendering, session-shutdown cleanup, and extension-off behavior.
- Existing package, plan-mode, multi-skill-mentions, temporary-load, and installed-package checks continue to pass.
- An opt-in real-provider smoke probe may be run only with separate user authority and available credentials; it is not a deterministic repository gate.

## Truth impact

This is a high-impact architecture change because the package will register its first model-callable tool, start child model processes, bind child models, schedule concurrent work, and mechanically converge worker output. On verified implementation, stable truth must update:

- `AGENTS.md`: add the independent subagent extension boundary, explicitly permit a bounded in-call delegation DAG while continuing to prohibit a second lifecycle engine, and retain extension independence.
- `README.md`: expose the third extension, explain opt-in behavior and removal, and replace the obsolete claim that the package never registers model-callable tools or performs child model binding.
- `docs/architecture/subagents.md`: own the three-boundary map, public tool and route contract, scheduling and isolation semantics, failure behavior, non-goals, verification, and removal path.

The design and plan remain stage artifacts under `docs/plans/changes/`; they are not runtime input or stable product truth.

## Recovery and removal

Repository implementation uses fix-forward recovery. Preserve the smallest failing graph, route fixture, JSONL stream, or disposable workspace and repair only the owning module. Do not weaken path checks, enable child shell, silently serialize required isolation, or add automatic fallback to make a probe pass.

The extension stores no durable runtime state. Removing only `./extensions/subagents/index.ts` from the package extension list and reloading Pi removes the tool and guidance while leaving `plan-mode`, `multi-skill-mentions`, user route configuration, parent sessions, and repository files intact. The implementation plan does not perform that removal or alter installed settings; this is the designed recovery boundary for a later installation failure.

## Review decision

A bounded design review was required because the change introduces concurrent child model execution and writable convergence. The review target was this artifact, with `AGENTS.md`, `README.md`, the two existing architecture documents, Pi's public extension and CLI contracts, and the retained workflow-harness stage artifacts as justified supporting evidence.

No independent subagent runtime currently exists, so `review-change` and `review-design` were applied directly. The focused repair replaced a hard-coded default agent directory with Pi's public `getAgentDir()` owner, required parent project trust before one-run child approval, prohibited a DAG from crossing parent-owned decision points, and reconciled aggressive prompt guidance with the enabled-but-idle behavior claim. Rechecking ownership, dependency direction, alternatives, acceptance evidence, recovery, and upgrade triggers produced verdict `pass` with no remaining material candidate finding. Runtime isolation and Pi CLI compatibility remain implementation verification obligations rather than design-review evidence.

## Approval

`approval_status = approved`. The user approved this design together with its implementation plan on 2026-08-29. That approval authorizes repository-local implementation only through the separately approved plan; it does not authorize package installation, user route-file creation, provider calls, model-setting changes, commit, push, publication, or deployment.
