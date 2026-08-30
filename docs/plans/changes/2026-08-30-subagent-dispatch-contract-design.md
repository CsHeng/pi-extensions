```toml
artifact_kind = "design"
design_version = 1
design_depth = "design-full"
approval_status = "approved"
approval_basis = "The user explicitly accepted recommendations A-E, required explicit per-call model and reasoning overrides, and authorized design-change plus plan-change on 2026-08-30."
decision_state = "approved"
truth_impact = "high"
truth_sync_required = true
review_required = true
review_status = "passed_after_repair"
```

# Subagent Dispatch Contract And Explicit Route Override Design

## Objective

Correct the model-facing and parent-semantic dispatch contract so ordinary delegation is flat by default, hard dependency edges are reserved for approved implementation work, invalid path and worker calls are easier to correct, no-op workers cannot claim successful convergence, singleton delegation is observable without being prohibited, and explicit user model and thinking choices are passed ephemerally with the task instead of mutating `csheng-subagents.json`.

The selected boundary keeps semantic eligibility with the parent and Skills, mechanical validation and execution with `pi-extensions`, model availability and authentication with Pi, and explicit cost and model-choice authority with the user.

The approved decisions map directly to this design:

| Decision | Approved boundary | Owning section |
| --- | --- | --- |
| A | Ordinary delegation is flat; only approved implementation work may project hard dependency edges | Flat delegation by default |
| B | Preserve strict relative paths and exact worker writes while improving model-facing descriptions and diagnostics | Actionable repository-relative paths |
| C | A worker that changes nothing cannot report applied convergence | Zero-change worker result |
| D | Retain legitimate singleton calls, discourage ordinary offload, and measure usage | Singleton policy |
| E | Add versioned mechanical telemetry and evaluator evidence | Telemetry and evaluator version two |
| F | Explicit user model and thinking choices override defaults ephemerally and never mutate route configuration | Explicit model override; Explicit thinking override |

## Current truth and observed demand

The current extension accepts an optional `dependsOn` array, but every evaluated task in the five most recent relevant sessions omitted it. The runtime therefore does not currently require dependency edges; an edgeless task set is already a valid DAG.

The same five-session sample exposed more material dispatch problems:

- twenty-five tool calls requested forty-four tasks, of which thirty-one launched and all launched children succeeded;
- six calls failed before launch, including five `invalid_scope` failures caused by absolute paths and one four-worker call without `writePaths`;
- fifteen calls contained one task, so most successful singleton calls received no concurrency benefit;
- five of six successful workers reported no changed path;
- the evaluator cannot aggregate singleton calls, requested versus admitted tasks, hard dependency edges, or zero-change workers without additional interpretation.

Session `01a04d57-e1c2-778a-b841-16cbe59206b5` also demonstrates a route-authority defect. To exercise a user request for Grok 4.6 with high thinking, the parent temporarily edited the user-owned route file, later removed the Grok edit, and then deleted the route file. Authoritative `csheng_subagents` telemetry contains no Grok worker launch. The only launched child was a default-configured reviewer. The workaround occurred because the public task schema rejects concrete model and thinking fields.

The extension itself only reads route configuration. The unsafe mutation was performed by the parent through ordinary file and shell tools, but the missing ephemeral override contract made that workaround attractive.

## Ownership and authority

| Owner | Owns | Does not own |
| --- | --- | --- |
| User | Explicit model and thinking choice, provider cost, cancellation, and approval-sensitive configuration changes | Child tools, path capabilities, scheduling, or convergence mechanics |
| Skills and parent | Delegation eligibility, task decomposition, hard dependency projection, preservation of explicit user route intent, and decision boundaries | Provider catalogue, authentication, subprocess isolation, or durable route configuration mutation without separate authority |
| Pi | Available model catalogue, authentication, model metadata, project trust, and host execution context | Role defaults, DAG admission, child path policy, or semantic lifecycle decisions |
| `pi-extensions` | Task schema, deterministic model matching, default route resolution, graph admission, role capabilities, subprocess execution, workspace isolation, telemetry, and evaluator schema | Inferring whether a model choice was wise, changing user route files, or overriding explicit user intent with a fallback model |

A model or thinking parameter supplied by the parent represents an explicit dispatch override. The parent guidance must say to populate those fields only when the user explicitly names the choice. The runtime records that an override was supplied but does not parse prompts or claim semantic proof of user intent.

## Selected dispatch contract

### Flat delegation by default

Model-facing language describes the tool as a bounded foreground task batch with optional hard predecessor edges rather than implying that every call needs a dependency graph.

Ordinary exploration, review, and ad hoc work submits independent tasks and omits `dependsOn`. A hard edge is eligible only when `implement-change` is executing an approved or user-explicit implementation order and no parent synthesis, authority, verification, review adjudication, repair decision, or continuation point exists between the two tasks.

This is a semantic parent rule, not a runtime Skill check. The extension remains Skill-blind and continues to validate any mechanically sound graph. The `plan-change` Skill may record factual task dependencies; only `implement-change` may project an approved hard dependency into a compatible delegation mechanism.

### Explicit model override

A task may add:

```text
model: string
```

When absent, existing role defaults, execution-profile mappings, user overlays, ordered availability fallback, and route evidence remain unchanged.

When present, the model selector overrides role candidates and execution-profile model selection for that task. It is valid for explorer, reviewer, and worker alike. Role still controls tools, paths, concurrency, isolation, and convergence; it never constrains an explicit model choice.

The resolver searches Pi's effective model registry, not the route candidate list. It takes two snapshots: `getAll()` for existence diagnosis and `getAvailable()` for executable authenticated models. Explicit task selection also supersedes the role's `executionProfile` candidate list and the session's cycling scope; those remain default-selection inputs rather than a later explicit user-choice ceiling.

Matching uses a closed deterministic rule. Normalize a bare model ID or display name with Unicode NFKC, lowercase it, replace every maximal run of characters other than Unicode letters or numbers with one ASCII space, and trim. There is no partial or catalogue-order match. Apply these tiers in order:

1. case-insensitive exact canonical `provider/model`;
2. normalized exact bare model ID;
3. normalized exact display name.

Only matches from the first non-empty tier participate. Canonical `provider/model` duplicates are one effective registry entry; Pi's composed registry owns their metadata and the extension does not merge it. Filter that tier through `getAvailable()`: one executable canonical match is selected, more than one returns `ambiguous_model`, and no executable match returns `model_unavailable`. An empty tier across `getAll()` returns `model_not_found`.

`ambiguous_model` and `model_unavailable` include at most eight sorted canonical candidates plus an omitted count. The parent can ask the user to provide exact `provider/model`. The resolver never synthesizes unknown IDs, refreshes credentials, changes settings, retries, or silently selects another model. An explicit selection either launches that resolved model or fails before child launch.

### Explicit thinking override

A task may also add:

```text
thinking: off | minimal | low | medium | high | xhigh | max
```

This is the exact Pi thinking-level override needed for requests such as `Grok 4.6 high`. It is independent of role.

Thinking precedence is:

1. explicit task `thinking`;
2. mapped `reasoningProfile`;
3. the selected default route candidate's configured thinking when model selection is default;
4. the parent turn's exact current thinking level when `model` is explicit and neither reasoning override is present.

When `model` is explicit, an unsupported resulting level returns `thinking_unavailable`; no other model or level is tried. When `model` is omitted but `thinking` is explicit, the normal ordered default candidate search may skip a candidate that cannot support that exact level and select the first later configured candidate that can. If no default candidate supports it, the task returns `thinking_unavailable`.

If both `thinking` and `reasoningProfile` are present, exact `thinking` wins and route evidence records that the semantic reasoning profile was requested but superseded. No exact level is clamped or silently changed.

An explicit `model` similarly supersedes `executionProfile` model mapping while retaining evidence that the profile was requested but not applied. This preserves provider-neutral plan metadata without allowing it to override a later concrete user instruction.

### Route configuration remains default policy

The packaged `config/csheng-subagents.json` continues to ship default role routes, reasoning-profile mappings, guidance, and concurrency caps. A user-owned overlay may change those long-lived defaults.

Neither file is an allowlist for explicit task overrides. The extension treats both as read-only runtime inputs and never creates, edits, or deletes the user file. Parent guidance explicitly prohibits route-file mutation as a workaround for one call. A durable default-route change remains a separate user-authorized operation.

There is no automatic retry or fallback after an explicitly selected model starts or fails. Cost and result quality remain causally attributable to the user's choice.

## Admission and convergence corrections

### Actionable repository-relative paths

The model-facing schema documents that `scope` and `writePaths` are repository-relative, `.` denotes the repository root, absolute paths and parent traversal are rejected, and every worker requires exact write files.

Admission remains strict. The extension does not convert absolute paths, infer a repository root, infer worker write paths, or downgrade worker roles. Existing stable error codes remain where practical, but error text becomes corrective:

- `invalid_scope` explains repository-relative scope and `.`;
- `worker_write_paths_required` explains exact worker file declarations.

### Zero-change worker result

Convergence retains safety-error precedence. It first computes the complete snapshot diff and rejects undeclared paths, deletion, rename, permission changes, symlinks, unsupported operations, and parent drift with their existing specific errors. Only a truly empty complete diff then returns `worker_no_changes`, task status `failed`, and convergence `not-applied`.

This aligns runtime behavior with stable architecture truth and prevents an empty diff from being represented as applied implementation. A task whose objective is to determine whether mutation is needed belongs to an explorer first. The parent decides whether a worker call is warranted.

### Singleton policy

The schema continues to accept one task. Legitimate singleton cases include an explicitly requested isolated worker and one required independent reviewer. Runtime admission does not attempt to judge whether a singleton was semantically worthwhile.

Prompt guidance discourages singleton explorer or reviewer calls used only to offload ordinary parent work. The evaluator supplies frequency, role, cost, and duration evidence so guidance can be tuned from representative runs rather than by removing the capability.

## Telemetry and evaluator version two

Runtime telemetry advances to schema version two with exact run-level mechanical fields:

```text
requestedDependencyEdges: number
admittedDependencyEdges: number
explicitModelTasks: number
explicitThinkingTasks: number
```

`requestedDependencyEdges` counts every string entry in a schema-valid raw task `dependsOn` array before graph admission. `admittedDependencyEdges` counts normalized edges after complete graph admission and is zero on rejected graphs. The explicit-task counters count schema-valid tasks carrying those fields even when later admission or route resolution fails.

Every successful task route adds:

```text
selectionSource: role-default | explicit-task
modelOverrideRequested: boolean
thinkingOverrideRequested: boolean
executionProfileApplied: boolean
reasoningProfileApplied: boolean
profileFallbacks: string[]
```

Mixed batches therefore retain task-level selection evidence, while pre-route failures retain run-level explicit-request counts. `explicit-task` means a task parameter selected the physical model; `role-default` includes package or user role candidates with or without an execution-profile mapping. The existing configuration `source` field continues to distinguish package and user route provenance, and the profile-applied booleans preserve semantic-profile attribution. Telemetry does not independently claim that explicit-task selection proved user intent. Raw selectors, prompts, objectives, task IDs, route-file content, and external content are not retained by the evaluator. Resolved provider, model, thinking, configuration source, and selection source remain intentional route evidence.

Evaluator output advances to metric schema version two. Its top-level shape retains `source`, `roles`, `routes`, `errors`, `concurrency`, and bounded `runs`, while `totals` adds:

```text
requestedTasks: number
admittedTasks: number
singletonRuns: number
zeroChangeWorkers: number
hardDependencyEdges: { known: number, unavailableRuns: number }
explicitModelTasks: { known: number, unavailableRuns: number }
explicitThinkingTasks: { known: number, unavailableRuns: number }
```

Per-run schema-two records carry exact dependency and explicit-override counts. Schema-one and legacy runs use `null` for those per-run fields and increment the matching `unavailableRuns`; the evaluator never reconstructs them from assistant tool arguments. `singletonRuns` counts runs with authoritative or legacy-inferred `requestedTasks === 1`; an empty legacy rejection has unknown width and is not counted. `zeroChangeWorkers` counts task results whose role is worker, status is succeeded, and structured `changedPaths` is an empty array; a missing changed-path array is not inferred.

Route aggregates add `selectionSource` to their key. Singleton role, usage, cost, and duration remain derivable from bounded per-run role summaries in schema two rather than copied prose. Existing schema-one runtime telemetry and legacy task results remain readable. Semantic repair remains unavailable without a future parent-owned structured disposition contract. The evaluator continues to accept one explicitly selected session per invocation and never reads Pi SQLite, credentials, settings, logs, or unrelated sessions.

## Skill guidance boundary

The `agent-skills` repository receives provider-neutral semantic wording only:

- `plan-change` records factual dependencies but does not prescribe a host DAG or concrete route;
- `implement-change` may project only approved hard dependencies and must stop before parent-owned decision points;
- ordinary delegated slices remain flat;
- a compatible host may preserve a user-explicit model or reasoning choice through ephemeral task parameters;
- no Skill instructs an agent to mutate durable route configuration to satisfy one invocation.

The Skills do not import this tool schema, name Grok or another provider model, or become runtime dependencies of `pi-extensions`.

## Alternatives

### Keep route configuration as the only concrete model input

Rejected. It caused a parent to mutate durable user configuration for a one-call request and cannot faithfully represent explicit user intent.

### Restrict task models to configured role candidates

Rejected. Role candidates are defaults, not an authority ceiling. The user owns model choice and accepts its cost and outcome.

### Add a named route alias or one-shot authorization token

Rejected as unnecessary persistent setup and lifecycle state. Pi already owns the authenticated model catalogue, and an explicit task parameter is sufficient.

### Let the child choose its own model

Rejected. The parent must project the user's choice before launch; children remain unable to widen their route or capabilities.

### Automatically normalize absolute repository paths

Rejected because checkout root, Git root, physical symlinks, and task intent can differ. Corrective rejection preserves path authority.

### Reject all singleton calls

Rejected because isolated writes and bounded independent review remain legitimate. Guidance and telemetry are the smaller sufficient control.

### Add soft or opportunistic dependency edges

Rejected. Timing-dependent predecessor consumption is nondeterministic. Independent work stays flat; optional continuation returns to the parent.

## Scope

In scope:

- task-level exact model and thinking overrides;
- deterministic Pi-catalogue matching and ambiguity failures;
- route-decision precedence and telemetry;
- default-flat dependency guidance and cross-repository Skill wording;
- model-facing schema descriptions and corrective admission diagnostics;
- zero-change worker failure;
- singleton guidance and evaluator metrics;
- backward-readable runtime telemetry and evaluator metric schema version two;
- deterministic tests, offline probes, stable truth synchronization, and optional separately authorized live evidence.

Out of scope:

- changing credentials, provider definitions, parent model, or user route files;
- role-dependent allowlists for explicit task models;
- arbitrary child tools, dynamic roles, child shell, or child self-routing;
- prompt parsing to prove user intent;
- automatic model retry, fallback, benchmarking, or route mutation;
- soft dependencies, lifecycle graphs, durable runs, replay, or settlement;
- automatic path conversion, inferred writes, or role rewriting;
- package installation, live provider calls, commit, push, publication, or deployment without separate authority.

## Oracle strategy and acceptance evidence

Use contract examples, deterministic model-resolution tables, dependency-aware component tests, disposable-Git convergence tests, synthetic JSONL evaluator fixtures, and existing offline package probes.

Acceptance requires:

- tool schema accepts optional `model` and exact `thinking`, keeps existing task inputs valid, and rejects unsupported thinking values;
- unique `Grok 4.6`-style normalized selectors resolve against a synthetic Pi catalogue for every role;
- normalized ID/name collisions and duplicate provider matches fail with `ambiguous_model` before launch, while explicit `provider/model` disambiguates;
- missing and present-but-unauthenticated catalogue matches return `model_not_found` and `model_unavailable` respectively, with no launch;
- explicit model and thinking override role defaults and semantic profiles, with accurate requested/applied evidence;
- explicit selection never falls back, retries, or mutates route configuration;
- omitted overrides preserve current package and user default routing;
- absolute scopes and missing worker writes fail before launch with stable codes and actionable text;
- a zero-diff worker fails with `worker_no_changes` and leaves the parent checkout unchanged;
- singleton and dependency metrics are emitted without retaining prompts or task IDs;
- evaluator schema one and legacy fixtures remain readable while schema two evidence is authoritative;
- Skill generated projections match authored source and all repository checks pass;
- `npm run check`, all required offline probes, both repositories' generation/check lanes, and `git diff --check` pass.

Tests must not freeze exact natural-language Skill or schema-description prose. Consumer behavior, structured fields, error codes, matching, routing, convergence, redaction, and generated parity are the executable oracles.

## Truth impact

Verified implementation changes high-impact stable truth:

- `AGENTS.md` and `docs/architecture/subagents.md` must replace the prohibition on concrete task routes with the explicit-user override boundary;
- `README.md` must describe default routes versus ephemeral user overrides and the read-only route-file rule;
- evaluator schema documentation must advance to version two with backward-read behavior;
- `agent-skills` authored and generated `plan-change` and `implement-change` guidance must reflect flat delegation, approved hard dependencies, and preservation of explicit user route intent.

Historical artifacts that rejected concrete task models remain unchanged as stage history. This design supersedes that decision for current implementation and stable truth.

## Recovery and rollout

Use fix-forward recovery. Additive task fields preserve existing callers. Explicit override failures are pre-child typed failures and cannot fall back to defaults. Runtime and evaluator schema-two readers retain schema-one and legacy compatibility.

The two repository tracks are independently deployable and require no atomic cutover. `agent-skills` wording is conditional on a compatible host, so it may ship before the runtime without claiming the capability exists. The runtime may ship first because existing Skills already permit host-compatible delegation and omitted override fields preserve defaults. Final milestone acceptance requires both repository checks, but interruption after either repository is changed is recovered by fixing that repository forward; no installed Skill, package, or user configuration is mutated by repository validation.

No guarded rollback is required because design and implementation do not install the package or mutate user/global state. If deterministic Pi model matching cannot distinguish a unique selector under the closed rules above, stop with `needs_design_decision` rather than choosing by catalogue order.

A live Grok or other provider run is optional authority-gated evidence. One failure stops the lane; it never triggers route-file edits, credential changes, retries, or fallback.

## Implementation surface

Expected `pi-extensions` surfaces:

- `extensions/subagents/contracts.ts`
- `extensions/subagents/config.ts`
- `extensions/subagents/graph.ts`
- `extensions/subagents/routing.ts`
- `extensions/subagents/workspace.ts`
- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `.agents/skills/evaluate-subagent-runs/`
- focused `tests/subagents-*.test.ts` fixtures
- package/offline probe assertions when observable contracts change
- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`

Expected `agent-skills` surfaces:

- `src/skills/workflows/plan-change/SKILL.md`
- `src/skills/workflows/implement-change/SKILL.md`
- generated `skills/plan-change/SKILL.md`
- generated `skills/implement-change/SKILL.md`

No runtime code imports the sibling repository.

## Review decision

A bounded design review was required because this design changes the public tool schema, concrete model authority, route precedence, worker success semantics, persisted telemetry, evaluator output, stable architecture truth, and two repository-owned semantic surfaces.

The independent reviewer returned `needs design revision` with seven candidates. All were accepted as causally tied and repaired in one focused artifact edit:

- the approved A-F decisions are now explicitly mapped;
- runtime and evaluator schema-two fields, locations, nullability, and counting rules are exact;
- explicit/default thinking precedence and fallback behavior are deterministic;
- explicit model selection is explicitly separated from role and session default scopes;
- matching normalization, tiers, catalogue snapshots, ambiguity bounds, and error classes are closed;
- existing convergence safety errors precede true zero-diff failure;
- cross-repository partial rollout and fix-forward recovery are defined.

Rechecking scope, ownership, model/thinking authority, dependency direction, backward compatibility, acceptance oracles, and recovery yields `pass`. No material design finding remains.
