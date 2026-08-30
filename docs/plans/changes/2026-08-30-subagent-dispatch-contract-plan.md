```toml
artifact_kind = "plan"
plan_version = 1
approval_status = "approved"
approval_basis = "The user approved the plan, authorized mutation in both PE and AS repositories, and authorized the optional live provider checkpoint on 2026-08-30."
decision_state = "approved"
approved_design = "docs/plans/changes/2026-08-30-subagent-dispatch-contract-design.md"
approved_design_sha256 = "eb39397f0f6b2ac332597fa3a35c201e65ac072ce6d6e0f7016fd8f01f49bec3"
implementation_authority = true
implementation_status = "pass"
live_provider_authority = true
live_checkpoint_status = "pass"
review_required = true
review_status = "passed_after_repair"
implementation_review_status = "passed_after_repair"
```

# Subagent Dispatch Contract And Explicit Route Override Plan

## Milestone objective

Implement the approved dispatch contract across the `pi-extensions` runtime/evaluator truth owner and the `agent-skills` semantic-guidance truth owner. Preserve all omitted-field callers, default routes, role capabilities, current concurrency behavior, and historical evaluator support while adding exact ephemeral route overrides and correcting the observed admission, convergence, dependency, and measurement failures.

This plan does not install or publish either repository, edit user configuration, make a live provider call, commit, push, deploy, or change the parent model.

## Approved decisions

The approved design fixes these boundaries:

- independent ordinary delegation omits hard dependency edges;
- only `implement-change` may project an approved hard implementation dependency into a host mechanism;
- `scope` and worker writes remain strict and repository-relative, with better diagnostics rather than inference;
- true zero-diff workers fail with `worker_no_changes` after existing safety checks;
- singleton calls remain legal and become measurable;
- runtime telemetry and evaluator output advance to backward-readable schema version two;
- exact task `model` and `thinking` override default selection for every role;
- package and user route files remain read-only default policy, not an explicit-task allowlist;
- explicit route failure never falls back or triggers configuration mutation.

Any implementation pressure to loosen one of these boundaries returns `needs_design_decision` rather than being absorbed as cleanup.

## Repository owners and prerequisites

| Repository ID | Root | Owned work |
| --- | --- | --- |
| PE | `pi-extensions` current repository | Public task contract, graph admission, route selection, child launch, workspace convergence, telemetry, evaluator, tests, probes, and stable product truth |
| AS | sibling `agent-skills` repository | Authored provider-neutral planning and implementation guidance plus generated public Skill projections |

Prerequisites:

1. The design artifact and hash above must still match before mutation.
2. The user must approve this plan.
3. The user must separately authorize repository mutation in both PE and AS. Plan approval alone does not grant cross-repository implementation authority.
4. Existing unrelated work in either repository must remain preserved. A dirty-tree preflight records owned changes before implementation.
5. Live provider credentials, spend, and provider-call authority are not prerequisites for deterministic completion. The optional live lane remains a separate manual checkpoint.

There is no account, license, physical, or deployment prerequisite for the deterministic work package.

## Execution graph

```text
G0 approval and two-repository mutation authority
├── PEX-100 additive contract and compatibility oracles
│   ├── PEX-200 explicit model/thinking resolver
│   ├── PEX-300 admission and zero-diff convergence
│   └── PEX-400 telemetry evaluator schema two
└── ASK-100 semantic Skill guidance

PEX-200 + PEX-300 + PEX-400 -> PEX-500 runtime integration and truth sync
PEX-500 + ASK-100 -> INT-600 full verification and bounded review
INT-600 -> ready for handoff
```

`PEX-200`, `PEX-300`, and `PEX-400` are independently implementable only after `PEX-100` freezes their shared TypeScript contracts. `ASK-100` is repository-independent and may run in parallel. `PEX-500` and `INT-600` remain parent-owned convergence and adjudication steps.

A later implementation may project only these factual hard dependencies. It must not add edges between independent slices for ordering convenience, and it must stop at the parent-owned integration and review decisions.

## Tasks

### PEX-100 — Freeze additive public and telemetry contracts

**Repository:** PE  
**Depends on:** G0  
**Objective:** Add the exact task and evidence types before changing route behavior.

**Write set:**

- `extensions/subagents/contracts.ts`
- `tests/subagents-contract.test.ts`

**Changes:**

- Add optional free-form `model` and exact `thinking` enum fields to `SubagentTaskSchema`.
- Keep `executionProfile` and `reasoningProfile` valid and preserve every existing task shape.
- Improve schema descriptions for flat task batches, hard-edge eligibility, repository-relative `scope`, `.` root scope, and exact worker `writePaths` without freezing exact prose in tests.
- Advance runtime telemetry to version two with integer requested/admitted dependency-edge counts and explicit model/thinking task counts.
- Add task-route evidence for `selectionSource`, override-requested booleans, profile-applied booleans, and bounded profile-fallback reasons while preserving existing configuration `source` attribution.
- Add typed error codes needed by the approved design without renaming stable existing codes.

**Completion conditions:**

- Existing schema examples still parse unchanged.
- All valid thinking levels parse; unknown levels and unknown task keys fail.
- Version-two interfaces can represent mixed explicit/default batches and pre-route failures without prompt inspection.
- `selectionSource` has only `role-default` and `explicit-task`.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-contract.test.ts
npm run typecheck
```

**Recovery:** Fix forward inside the write set. If additive fields require an incompatible rename of existing result fields, return `needs_design_decision`.

### PEX-200 — Resolve explicit model and thinking deterministically

**Repository:** PE  
**Depends on:** PEX-100  
**Objective:** Implement exact per-task route precedence against Pi's public model-registry API with no internal `dist` imports or fallback.

**Write set:**

- `extensions/subagents/config.ts`
- `extensions/subagents/routing.ts`
- `tests/subagents-routing.test.ts`

**Changes:**

- Keep existing role/default and semantic-profile routing when `model` is omitted.
- Resolve explicit selectors from `modelRegistry.getAll()` and `getAvailable()` using the approved canonical and normalized exact tiers only.
- Deduplicate canonical entries, cap sorted diagnostics at eight candidates, and emit `model_not_found`, `model_unavailable`, or `ambiguous_model` before child launch.
- Treat role candidate lists, execution-profile mappings, and session cycling scope as defaults superseded by an explicit task model.
- Apply thinking precedence exactly. An explicit model has no model fallback; a default route with explicit thinking may continue through ordered configured candidates only to find one supporting that level.
- Record applied and superseded semantic profiles without changing package or user route objects.

**Oracle table:**

- explicit canonical provider/model;
- normalized exact bare ID and display name, including punctuation/case equivalence;
- normalized collision across providers;
- missing catalogue entry;
- present but unavailable entry;
- duplicate canonical registry entry;
- explicit selection for explorer, reviewer, and worker;
- explicit model with exact high thinking;
- explicit model without a reasoning override inheriting the parent turn's exact thinking;
- unsupported inherited parent thinking returning `thinking_unavailable` without fallback;
- thinking-only selection across ordered default candidates;
- explicit model or thinking overriding semantic profiles;
- omitted overrides preserving package/user defaults;
- explicit failure causing zero fallback launch.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-routing.test.ts
npm run typecheck
```

**Recovery:** Fix forward. If the required catalogue behavior is unavailable through Pi's public extension API, stop; do not import internal resolver or search modules.

### PEX-300 — Correct admission diagnostics and zero-diff workers

**Repository:** PE  
**Depends on:** PEX-100  
**Objective:** Preserve strict path capabilities while making failed calls correctable and empty worker convergence impossible.

**Write set:**

- `extensions/subagents/graph.ts`
- `extensions/subagents/workspace.ts`
- `tests/subagents-workspace.test.ts`

**Changes:**

- Retain `invalid_scope` and `worker_write_paths_required` codes, but return repository-relative corrective context and the `.` root convention.
- Keep absolute paths, parent traversal, undeclared writes, missing worker writes, and capability widening rejected before or during convergence.
- Evaluate complete worker diffs in existing safety-error order.
- Return `worker_no_changes`, failed task status, and `not-applied` only for a truly empty complete diff.
- Do not infer `writePaths`, rewrite absolute paths, change roles, or treat undeclared-only writes as no change.

**Completion conditions:**

- Absolute scope and missing worker-write fixtures launch no child.
- Empty worker snapshots do not mutate the parent and return `worker_no_changes`.
- Undeclared mutation still returns its existing specific safety failure.
- Valid declared changes still converge once.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-workspace.test.ts
npm run typecheck
```

**Recovery:** Fix forward. Never recover by widening scope or applying an unvalidated diff.

### PEX-400 — Advance evaluator metrics with legacy evidence labels

**Repository:** PE  
**Depends on:** PEX-100  
**Objective:** Make singleton, topology, admission, explicit-route, and no-op-worker behavior measurable without reading prompts or settings.

**Write set:**

- `.agents/skills/evaluate-subagent-runs/SKILL.md`
- `.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts`
- `.agents/skills/evaluate-subagent-runs/references/metric-schema.md`
- `tests/subagents-evaluator.test.ts`

**Changes:**

- Emit evaluator metric schema version two while reading runtime telemetry versions one and two plus legacy task results.
- Update the evaluator Skill workflow so schema-two runtime telemetry is authoritative, schema one remains authoritative for its available fields, and legacy evidence retains its existing qualified mode.
- Add exact requested/admitted/launched totals, singleton runs, zero-change workers, dependency-edge known/unavailable evidence, and explicit model/thinking known/unavailable evidence.
- Add task-route `selectionSource` to aggregate attribution while retaining configuration source.
- Use `null` and `unavailableRuns` for evidence absent from old sessions; never reconstruct topology or route intent from assistant tool arguments.
- Keep raw prompts, objectives, selectors, task IDs, route files, settings, credentials, and unrelated sessions out of output.
- Preserve mechanical correction classification and keep semantic-repair evidence unavailable.

**Fixture matrix:**

- authoritative runtime schema two with a mixed explicit/default batch;
- authoritative schema-two pre-admission failure;
- runtime schema one with unavailable new metrics;
- legacy success and legacy empty rejection;
- singleton by each role and one multi-task run;
- historical successful zero-change worker;
- a new `worker_no_changes` failure;
- bounded candidate/error evidence and redaction assertions.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-evaluator.test.ts
```

**Recovery:** Fix forward while retaining old fixtures. A schema-one or legacy regression blocks integration.

### ASK-100 — Align provider-neutral Skill semantics

**Repository:** AS  
**Depends on:** G0  
**Objective:** Put dependency and ephemeral user-route semantics in their authored Skill owner without adding a runtime contract.

**Write set:**

- `src/skills/workflows/plan-change/SKILL.md`
- `src/skills/workflows/implement-change/SKILL.md`
- `skills/plan-change/SKILL.md`
- `skills/implement-change/SKILL.md`

**Changes:**

- Keep `plan-change` responsible for recording factual dependencies and repository-owned writable slices, not projecting host DAGs.
- Tell `implement-change` to delegate independent ordinary slices flat and to encode a hard predecessor only when approved implementation order has no intervening parent decision.
- Preserve an explicit user-selected execution or reasoning choice through ephemeral compatible-host parameters when supported.
- Prohibit durable route-configuration mutation as a one-invocation workaround unless the user separately requests a persistent default change.
- Keep wording provider-neutral and free of Pi-specific task fields, model names, schedulers, and runtime imports.
- Regenerate only public flat projections; keep Skill descriptions and inventory unchanged.

**Completion conditions:**

- Authored and generated Skill copies match.
- `plan-change` still cannot spawn agents and does not claim runtime authority.
- `implement-change` remains the sole semantic projection owner for hard implementation dependencies.
- No provider or concrete model is named.

**Verification:**

```bash
python3 scripts/generate-skills-index.py
python3 scripts/flatten-skills.py --target root-flat
python3 scripts/generate-workflow-diagrams.py
bash scripts/check.sh
git diff --check
```

`skills.index.json` and workflow diagrams are expected to remain byte-identical because public descriptions and composition metadata do not change. Any unexpected generated diff is diagnosed before acceptance.

**Recovery:** The authored source remains authoritative. Regenerate flat copies after every repair; never hand-edit only `skills/`.

### PEX-500 — Integrate dispatch, telemetry, rendering, and stable truth

**Repository:** PE  
**Depends on:** PEX-200, PEX-300, PEX-400  
**Objective:** Wire the frozen contracts into one foreground run and synchronize public/stable behavior.

**Write set:**

- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `tests/subagents-extension.test.ts`
- `tests/subagents-host-contract.test.ts`
- `tests/subagents-render.test.ts`
- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`

**Changes:**

- Count raw schema-valid requested edges and explicit override tasks before graph admission, then emit admitted counts after validation.
- Pass task model/thinking overrides to route resolution for all roles and launch only the resolved provider/model/thinking.
- Propagate typed pre-launch route failures, `worker_no_changes`, selection source, configuration source, profile application, and convergence evidence through tool results and bounded rendering.
- Ensure one task remains schema-valid while model-facing guidance recommends independent multi-task batches and names legitimate singleton exceptions.
- Add an integration fixture with a temporary user route file and assert its bytes and existence are unchanged on explicit success and failure.
- Update stable truth to distinguish package defaults, user-edited persistent defaults, and explicit task overrides; state that runtime never writes route configuration.
- Replace the old blanket prohibition on concrete task routes with the explicit-user-only boundary while retaining semantic Skill independence.

**Integration oracles:**

- mixed explicit/default batch launches each task on its intended route;
- direct high-thinking request reaches child launch unchanged;
- ambiguous/unavailable/not-found/unsupported-thinking errors launch no child;
- explicit route failure does not use a role default;
- rejected graph emits requested but zero admitted evidence;
- true zero-diff worker fails in the aggregate result;
- one-task reviewer remains legal and is identifiable as singleton;
- default routes and existing telemetry consumers continue to pass;
- no test depends on exact prose sentences.

**Verification:**

```bash
node --experimental-strip-types --test \
  tests/subagents-extension.test.ts \
  tests/subagents-host-contract.test.ts \
  tests/subagents-render.test.ts \
  tests/subagents-routing.test.ts \
  tests/subagents-workspace.test.ts \
  tests/subagents-evaluator.test.ts
npm run typecheck
git diff --check
```

**Recovery:** Fix forward inside PE. If integration exposes an unresolved precedence or authority question, return `needs_design_decision`; do not mutate config, relax path policy, or add fallback.

### INT-600 — Converge, verify, and review both repositories

**Owner:** Active parent  
**Depends on:** PEX-500, ASK-100  
**Objective:** Produce one evidence-backed handoff without transferring verification, review adjudication, or continuation to a child.

**Preflight:**

- Re-read both repository status outputs and preserve unrelated changes.
- Confirm every changed file belongs to the approved write sets or explain a generated output causally.
- Confirm the approved design hash is unchanged; if the design itself changed, re-approve or replan first.

**PE deterministic validation:**

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
git diff --check
```

The multi-skill mention probes and live subagent provider lane are excluded because they require provider-call authority and are unrelated to the changed behavior.

**AS deterministic validation:**

```bash
python3 scripts/generate-skills-index.py --check
python3 scripts/flatten-skills.py --target root-flat --check
bash scripts/check.sh
python3 scripts/run-standalone-check.py
git diff --check
```

**Independent review:**

Run one bounded `review-change` evaluation over the exact converged PE and AS diffs, the approved design and plan, and the verification evidence. Require review because the change modifies a public tool schema, physical route authority, worker success semantics, telemetry compatibility, stable architecture truth, and cross-repository semantic guidance.

The active parent adjudicates every material candidate. If an accepted candidate is fixable within an approved write set, apply at most one focused same-slice repair and rerun affected focused checks plus both declared repository gates. A scope, authority, or design defect returns `replan` or `redesign` instead of widening the patch.

**Completion evidence:**

- exact changed-file lists per repository;
- focused and full command results;
- schema-one and legacy compatibility evidence;
- config immutability evidence;
- reviewer verdict and parent adjudications;
- any repair and rerun evidence;
- remaining optional live checkpoint.

## Optional authority-gated live checkpoint

A real provider call is not required for deterministic implementation acceptance. If the user later authorizes provider usage and names an available model and exact thinking level, run one bounded foreground task using only invocation parameters. Preflight provider availability without printing credentials or route settings. Assert resolved provider/model/thinking and child launch telemetry, then stop.

One failure ends the checkpoint. Do not edit `config/csheng-subagents.json` or the user overlay, retry, substitute another model, alter credentials, increase concurrency, or change the parent model. Record only redacted route, status, usage, cost, and timing evidence.

## Cross-repository rollout and recovery

PE and AS are independently deployable. AS wording is conditional on compatible-host support and may land first; PE remains backward compatible when it lands first because omitted fields preserve current behavior. No atomic repository commit or installed-state mutation is required.

For an interrupted implementation:

- leave the completed repository in a checked deterministic state;
- diagnose and fix the failing repository forward;
- do not copy generated Skill payloads into PE or import PE runtime concepts into AS;
- do not install either partial state as part of recovery;
- do not claim final milestone completion until both repositories pass INT-600.

No guarded rollback is planned. A user configuration write, credential change, unexpected parent-checkout mutation, unbounded fallback, or internal Pi import is a stop condition and must be reported as an authority or design breach.

## Truth synchronization

PEX-500 owns PE stable truth. ASK-100 owns AS authored semantic truth and generated parity. Historical design/plan artifacts remain unchanged except for these new stage artifacts; they are evidence, not runtime inputs.

The final handoff must distinguish:

- behavior verified deterministically;
- backward compatibility verified by fixtures;
- live provider behavior not run unless separately authorized;
- repository changes not installed, committed, pushed, published, or deployed.

## Review decision

The independent plan reviewer returned `needs plan revision` with two causal candidates. Both were accepted and repaired in one focused edit:

- PEX-400 now owns the evaluator Skill workflow text as well as its script, schema reference, and fixtures, so schema-two authority cannot contradict durable evaluator instructions;
- PEX-200 now includes inherited parent-thinking success and unsupported-level failure oracles for an explicit model without a task reasoning override.

Rechecking scope, task dependencies, write-set independence, repository ownership, completion evidence, compatibility, authority, recovery, and truth sync yields `pass`. No material plan finding remains.

## Approval request

The user approved this plan, authorized mutation in both PE and AS, and authorized the optional live provider checkpoint on 2026-08-30. Commit, push, publication, deployment, installation outside the declared probes, credential changes, parent-model changes, and persistent route-configuration changes remain unauthorized.

## Implementation outcome

Outcome: `pass`.

PE verification passed after a clean local dependency install: `npm run check` completed with 101 tests, all four required offline plan-mode/subagent probes passed, and `git diff --check` passed. AS authored/generated parity, `scripts/check.sh` with 101 tests, the standalone-copy check, and `git diff --check` passed.

The required implementation reviewer returned three causal candidates. All were accepted and repaired in one focused pass: declared parent drift now precedes `worker_no_changes` even for an empty worker diff; resolved route evidence is attached to blocked and never-started admitted tasks; and bounded rendering now exposes configuration source plus profile application and fallback evidence. Focused tests and both complete repository gates passed after repair; no accepted finding remains.

The authorized live checkpoint called the temporary-load extension exactly once with an ephemeral `grok 4.6` selector and exact `high` thinking. It resolved and launched `xai/grok-4.6:high`, reported `selectionSource=explicit-task` and both explicit-task counters, and left the user route configuration byte-identical or absent as found. The checkpoint performed no retry, fallback, credential change, parent-model change, or route-file mutation.

No repository change was committed, pushed, published, deployed, or globally installed.
