```toml
artifact_kind = "design"
design_version = 1
design_depth = "design-full"
approval_status = "approved"
approval_basis = "The user explicitly approved the semantic profile boundary, role-preferred routes, capacity increase, and evaluator direction on 2026-08-29."
decision_state = "approved"
review_status = "passed"
```

# Semantic Subagent Routing And Evaluation Design

## Objective

Evolve the bounded subagent runtime from parent-only routing and coarse final results into a higher-throughput, semantically routable, measurable execution surface without coupling it to a planning Skill, plan-file format, provider-specific capability hierarchy, or durable workflow engine.

The runtime should use role-preferred peer models by default, accept optional provider-neutral execution and reasoning profiles from any parent, support up to ten ready children across role ceilings, and retain enough redacted telemetry for a repository-local evaluator Skill to compare routing and execution outcomes over time.

## Current truth and observed demand

The current tool accepts fixed-role tasks but no semantic route profile. Its packaged route projection inherits the parent model and thinking level for every role. Hard ceilings are eight tasks, four concurrent children, four explorers, four reviewers, and two workers.

Session `01a04be7-df36-7775-8bbb-0c58a99a0670` supplied concrete demand evidence:

- twelve `csheng_subagents` calls produced seven successful DAGs and five fail-closed calls;
- twenty-two child processes actually started: ten explorers, eight reviewers, and four workers;
- every child inherited `openai-codex/gpt-5.6-sol:high` because no user route override existed;
- the four-worker implementation DAG had independent tasks and unique locks but ran two at a time because of the worker ceiling;
- admission failures correctly consumed no child turns, but the persisted result lacks a structured run-level error and cannot authoritatively separate dispatch correction from semantic repair;
- a multi-repository implementation plan was translated into one repository-rooted DAG, causing absolute-path, missing-write-path, scope, and missing-parent failures before the parent introduced a repository-local staging workaround.

The extension behaved safely, but the episode demonstrates three product gaps: role routing was not cost/latency differentiated, mixed-role global capacity could not reach the sum of role ceilings, and persisted evidence is insufficient for repeatable evaluation.

## Ownership and dependency direction

The selected boundary is an optional semantic adapter contract:

1. A Skill or user may describe task independence, execution intensity, reasoning intensity, repository ownership, locks, and write surfaces without naming Pi, this extension, or a concrete model.
2. The active parent agent interprets that semantic task description and may copy optional profile values into a `csheng_subagents` task.
3. The extension never opens, discovers, or parses a plan artifact. It validates only the tool arguments supplied by the parent.
4. User or package route configuration maps semantic profile values to concrete models and thinking levels. Extension code treats model IDs as opaque catalogue keys and does not rank Sol, Terra, Luna, or any future family.
5. Missing profile metadata is normal. Ad hoc delegation and plans authored by other systems use the role default without degradation.

This direction keeps Skills provider-neutral and keeps the extension independent of any Skill repository. The shared words are semantic vocabulary, not an import, generated interface, discovery bridge, or lifecycle protocol.

## Semantic task profile

A task may add two optional fields:

```text
executionProfile = fast | balanced | deep
reasoningProfile = light | standard | deep
```

These values reuse established provider-neutral planning vocabulary. They carry intent only:

- `executionProfile` selects an optional role-owned candidate list from route configuration.
- `reasoningProfile` selects an optional configured Pi thinking level.
- An absent field selects the role default.
- A known field with no configured mapping visibly falls back to the role default.
- An unknown field is rejected during graph admission rather than silently normalized.

The task cannot provide a model ID, provider, thinking level, arbitrary profile name, tool list, working directory, Skill, extension, command, or fallback policy.

## Route configuration layers

The repository-owned `config/csheng-subagents.json` becomes the packaged route baseline rather than a documentation-only projection. The extension loads this trusted package file first, then applies an optional strict user override from Pi's public agent directory. A missing user file is not an error. A malformed package or user file returns a typed diagnostic before child launch.

The package baseline uses role preference plus ordered peer fallback:

- explorer: Luna medium, Terra medium, Sol medium;
- worker: Terra high, Luna high, Sol high;
- reviewer: Sol high, Terra high, Luna high.

These names express current user preference, not a capability ordering. The resolver checks catalogue presence, authentication, active model scope, and thinking support in list order. It performs no hidden retry after a child runtime error.

The configuration may optionally define:

```text
routes.<role>.executionProfiles.<fast|balanced|deep>.candidates
reasoningProfiles.<light|standard|deep>
```

Each execution-profile candidate remains a complete `{ model, thinking }` route. A configured reasoning profile overrides the selected candidate's thinking value after model selection. The initial package baseline maps `light`, `standard`, and `deep` to `low`, `medium`, and `high`; it does not assign different peer model families to execution intensity without evaluation evidence. User configuration may add those mappings later.

Effective route evidence records package versus user source, candidate index, requested profiles, whether each profile mapping applied, and whether role-default fallback occurred.

## Capacity and scheduling

Hard ceilings become:

```text
maxTasks = 10
maxConcurrency = 10
explorer = 4
reviewer = 4
worker = 2
```

Ten is the sum of role ceilings, so one mixed graph may use four explorers, four reviewers, and two workers when all are ready and conflict-free. Dependencies, role ceilings, resource locks, write overlap admission, cancellation, and the one-active-graph-per-session reservation remain authoritative. The change does not permit ten workers or multiple simultaneous graphs.

Capacity configuration may lower but never raise these ceilings. There is no retry on provider throttling or runtime failure; telemetry must expose the failure so routing and caps can be tuned from evidence.

## Repository-root readiness

The extension remains single-Git-root per tool call. It does not accept arbitrary task `cwd` or external repository paths. Parent agents must split multi-repository implementation into separate repository-rooted execution contexts or retain the affected slice themselves.

Graph admission continues to require lexical repository-relative paths. Before worker launch, workspace preparation should return typed path-readiness evidence for missing parent directories. The evaluator may classify nonexistent read scopes, but the extension must not create undeclared parent paths or reinterpret prose as another repository.

Using a repository-local staging directory is not a transparent substitute for a multi-repository plan. Any staging workaround remains parent-owned, explicitly ignored, and separately cleaned; `.agents/worktrees/` is reserved for actual Git worktrees and is not an extension workspace.

## Telemetry contract

Tool-result details remain the only persisted runtime evidence. The extension adds bounded, redacted telemetry rather than a second ledger:

```text
schemaVersion
runId
runDurationMs
requestedTasks
admittedTasks
launchedChildren
peakConcurrency
peakConcurrencyByRole
runErrorCode
```

Each task adds timing and route-decision evidence:

```text
childStarted
queueMs
workspaceMs
childMs
convergenceMs
executionProfileRequested
executionProfileApplied
reasoningProfileRequested
reasoningProfileApplied
profileFallbacks
```

Telemetry contains no objective, prompt, child output copy, environment value, credential, raw route file, or external file content. Existing bounded output and changed-path evidence remain in their current fields. Admission failures receive a structured run error even when no normalized task exists.

Absolute timestamps are unnecessary; monotonic durations and peak counts are sufficient for evaluation and avoid creating an event log.

## Evaluator Skill

A project-local, read-only Skill lives at:

```text
.agents/skills/evaluate-subagent-runs/
```

It is a maintainer capability, not a package resource and not a runtime dependency. Its deterministic script accepts an explicit Pi session path or session ID, reads JSONL without modifying Pi state, and emits a redacted versioned metric document.

The evaluator distinguishes:

- tool calls, admitted DAGs, rejected DAGs, and run-level error codes;
- task records from actual child launches;
- role, route, thinking, turns, tokens, cache, cost, duration, and changed-path counts;
- requested width, peak concurrency, queueing, convergence, timeout, abort, and conflicts;
- mechanical dispatch-correction sequences from semantic repair evidence;
- authoritative telemetry from legacy inference.

Semantic repair count remains `inferred` unless future parent-owned evidence explicitly labels review disposition and repair. The extension does not infer lifecycle phases.

A redacted baseline for the first production session may be stored under `docs/evaluations/subagents/`. The extractor never writes there without an explicit output argument, and ordinary tests use synthetic fixtures rather than the user's session store or provider credentials.

## Alternatives

### Keep parent inheritance only

Rejected because observed worker cost and explorer/reviewer usage provide concrete demand for role preference and measurable route tuning. Parent inheritance remains the safety behavior only when no configured profile route is available by design, not the preferred package route.

### Let the extension parse plan files

Rejected because it would couple runtime mechanics to Skill prose, plan location, trust rules, and lifecycle semantics. It would also make ad hoc delegation less predictable.

### Permit concrete model fields per task

Rejected because it transfers route authority to model-generated tool arguments, bypasses the user route file, and embeds provider details in plan translation.

### Treat peer model names as capability tiers

Rejected because no evidence establishes a durable Luna/Terra/Sol strength order. Candidate ordering is role preference and availability fallback only.

### Replace snapshots with Git worktrees

Deferred. Current snapshots preserve staged, unstaged, and non-ignored untracked bytes and converge by parent-path CAS. A worktree replacement is justified only after measured snapshot cost is material and the replacement preserves dirty-tree fidelity, path guards, and cleanup.

## Scope

In scope:

- semantic profile fields and route evidence;
- packaged baseline plus optional user overlay;
- role-preferred peer candidates and reasoning-profile mapping;
- ten-task and ten-child mixed-role capacity;
- structured bounded telemetry;
- repository-local evaluator Skill, synthetic tests, and one redacted baseline;
- stable documentation, package probes, and opt-in live routing evidence.

Out of scope:

- reading or validating a planning Skill or plan artifact;
- task-supplied concrete models, providers, thinking values, tools, or working directories;
- dynamic model benchmarking or automatic route mutation;
- background execution, durable graph state, retry, replay, settlement, or recursive delegation;
- cross-repository worker convergence;
- changing parent model/provider settings;
- treating `.agents/worktrees/` as a snapshot or staging directory;
- installing, committing, pushing, publishing, or deploying without separate authority.

## Acceptance evidence

- Contract tests reject unknown profiles and all concrete task route fields while accepting absent or known semantic profiles.
- Routing tests cover package baseline, user overlay, execution-profile mapping, reasoning-profile mapping, visible fallback, scope/auth/thinking rejection, and opaque candidate order.
- Scheduler model tests prove ten mixed-role tasks can reach `4 + 4 + 2`, while eleven tasks, a third worker, locks, dependencies, and concurrent graph calls remain bounded.
- Telemetry tests prove peak counts, launch distinction, structured admission errors, timing classes, legacy compatibility, and redaction.
- Evaluator fixtures prove the 2026-08-29 session shape without embedding prompts, child output, credentials, or external file content.
- Temporary and installed offline probes remain redacted.
- An explicitly authorized live E2E proves explorer, worker, and reviewer resolve to their role-preferred routes and that profile omission falls back to role defaults.
- `npm run check` and `git diff --check` pass.

## Recovery and rollout

Use fix-forward. Keep the old task shape valid throughout implementation. Route-profile fields are additive, and missing profile mappings fall back visibly to role defaults. If packaged route loading is invalid or a preferred peer is unavailable, fail with typed route evidence rather than mutating parent settings or silently selecting an unlisted model.

The evaluator ships before route optimization is expanded beyond the approved defaults. Future model/profile mapping changes require retained evaluation evidence rather than model-name assumptions.

## Implementation surface

Expected repository surfaces:

- `config/csheng-subagents.json`
- `extensions/subagents/contracts.ts`
- `extensions/subagents/config.ts`
- `extensions/subagents/graph.ts`
- `extensions/subagents/routing.ts`
- `extensions/subagents/scheduler.ts`
- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `.agents/skills/evaluate-subagent-runs/`
- `tests/`
- `scripts/run-live-subagents-e2e.ts`
- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`
- `docs/evaluations/subagents/`

No file in another repository is an implementation dependency of this design.

## Review decision

A bounded design review was required because this change alters the public task contract, persisted result details, model binding, capacity, and maintainer evaluation surface. Review was limited to this artifact, the current stable subagent architecture, package config, task/result contracts, scheduler ceilings, routing parser, and evaluator ownership boundary.

Direct `review-design` evaluation returned `pass`. The design keeps plan interpretation with the parent, treats model identifiers as opaque configuration, makes semantic profiles optional, preserves role/global safety ceilings, avoids durable runtime state, gives telemetry and evaluation distinct owners, and supplies executable acceptance evidence. No material scope, dependency-direction, route-authority, recovery, or truth-boundary finding remains.
