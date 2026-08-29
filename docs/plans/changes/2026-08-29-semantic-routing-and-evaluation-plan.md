```toml
artifact_kind = "implementation-plan"
plan_version = 1
design_ref = "docs/plans/changes/2026-08-29-semantic-routing-and-evaluation-design.md"
design_sha256 = "ff8de02609efb728bbd75dbcdb8a227de9d83aeeba6916c099e1cced793f3509"
design_approval_status = "approved"
approval_status = "approved"
approval_basis = "The user explicitly requested creation and approval of this repository's design-change and plan-change artifacts."
decision_state = "manual_checkpoint"
implementation_authority = "approved"
live_provider_authority = "approved"
implementation_status = "pass"
truth_sync_required = true
implementation_review_required = true
plan_review_status = "passed"
```

# Semantic Subagent Routing And Evaluation Implementation Plan

## Milestone

Implement optional provider-neutral task profiles, role-preferred packaged routes, ten-way mixed-role capacity, structured redacted telemetry, and a repository-local session evaluator while preserving the bounded foreground DAG, one-root worker isolation, user override authority, and parent-owned lifecycle decisions.

## Current prerequisites

Satisfied:

- The design is approved and its bounded design review passed.
- The repository working tree was clean before these stage artifacts were created.
- Current Pi models include the approved role-preferred peer families.
- Existing unit, component, offline probe, and opt-in live-E2E surfaces provide reusable verification lanes.

Pending authority:

- Real-provider E2E after routing changes requires explicit authority because it consumes provider capacity and ambient authentication.
- Global package installation, user settings mutation, commit, push, publication, and deployment remain separate actions and are not authorized by this plan.

The task order is approved, but repository mutation has not been authorized. Deterministic implementation may begin only after a separate implementation request. The final live-provider task remains blocked unless that request also explicitly includes `live_provider_authority`.

## Oracle strategy

Use contract examples plus dependency-aware state-transition tests:

- TypeBox and runtime admission examples protect the additive semantic profile contract and concrete-route prohibition.
- Configuration and routing tables protect package/user layering, opaque candidate order, profile mapping, fallback evidence, authentication, scope, and thinking support.
- Scheduler state-transition fixtures protect the `4 + 4 + 2` mixed-role capacity, role ceilings, locks, dependencies, cancellation, and peak telemetry.
- Fake-child and fake-Pi component tests protect task timing, launch distinction, structured run errors, rendering, and cleanup.
- Synthetic session JSONL fixtures protect evaluator classification and redaction.
- Existing temporary/installed probes protect package coexistence without model calls.
- An explicitly authorized live E2E is the runtime oracle for actual role-preferred model binding and worker convergence.

No oracle may assert exact Skill prose, raw prompts, user settings, credentials, or external repository content.

## Shared implementation constants

Freeze these before parallel work:

```text
executionProfile = fast | balanced | deep
reasoningProfile = light | standard | deep
maxTasks = 10
maxConcurrency = 10
explorerConcurrency = 4
reviewerConcurrency = 4
workerConcurrency = 2
telemetrySchemaVersion = 1
```

Package route order:

```text
explorer = Luna medium, Terra medium, Sol medium
worker = Terra high, Luna high, Sol high
reviewer = Sol high, Terra high, Luna high
```

Reasoning profile map:

```text
light = low
standard = medium
deep = high
```

Model family names remain data in `config/csheng-subagents.json`; extension code must not rank or branch on those names.

## Task graph

```text
SRE-100 contracts-and-capacity
  ├── SRE-200 packaged-routing
  ├── SRE-300 scheduler-telemetry
  └── SRE-400 evaluator
          │
          └──────────────┐
SRE-200 ───────────────┐ │
SRE-300 ─────────────┐ │ │
                     ▼ ▼ ▼
                 SRE-500 integration
                     │
                     ▼
                 SRE-600 convergence
                     │
                     ▼
                 SRE-700 live-runtime (authority gated)
```

`SRE-200`, `SRE-300`, and `SRE-400` may run in parallel after `SRE-100`; their authored write surfaces are disjoint. `SRE-500` is parent-owned integration. `SRE-700` is never delegated and remains gated.

## SRE-100 — Freeze additive contracts and hard ceilings

**Depends on:** none

**Execution:** serial, parent-owned

**Locks:** `subagent-public-contract`, `subagent-hard-limits`

**Touched files:**

- `extensions/subagents/contracts.ts`
- `extensions/subagents/graph.ts`
- `tests/subagents-contract.test.ts`
- `tests/subagents-scheduler.test.ts`

**Work:**

- Raise `maxTasks` and global `maxConcurrency` to ten while retaining role hard ceilings `4/4/2`.
- Add optional `executionProfile` and `reasoningProfile` task fields with fixed provider-neutral enums.
- Keep concrete task provider, model, thinking, route candidate, tools, command, Skill, extension, `cwd`, retry, and nested graph fields forbidden.
- Extend normalized tasks without making profiles required.
- Freeze telemetry interfaces and version one field names without adding prompt or path copies.
- Add red tests for unknown profiles, eleven tasks, concrete route fields, and exact mixed-role limits before implementation changes.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-contract.test.ts tests/subagents-scheduler.test.ts
npm run typecheck
git diff --check -- extensions/subagents/contracts.ts extensions/subagents/graph.ts tests/subagents-contract.test.ts tests/subagents-scheduler.test.ts
```

**Done when:**

- Existing task inputs remain valid.
- Known profiles are accepted, unknown profiles and concrete route fields fail admission.
- A ten-task mixed fixture can represent four explorers, four reviewers, and two workers; a third worker never runs concurrently.

**Recovery:** fix forward inside the frozen contract. Any request for arbitrary profile names or concrete task models returns to design rather than widening the schema.

## SRE-200 — Load packaged defaults and resolve profile-aware routes

**Depends on:** `SRE-100`

**Parallel group:** `routing-telemetry-evaluator`

**Delegation eligibility:** allowed for this repository-local disjoint slice

**Locks:** `subagent-route-config`, `package-default-config`

**Touched files:**

- `config/csheng-subagents.json`
- `extensions/subagents/config.ts`
- `extensions/subagents/routing.ts`
- `tests/subagents-routing.test.ts`

**Work:**

- Make the tracked config the trusted package baseline loaded relative to the extension package.
- Encode the approved role-preferred peer candidate order and global/role caps in data, not model-name branches.
- Extend strict configuration with optional execution-profile candidate lists and reasoning-profile thinking mappings.
- Apply a missing user file as no overlay; apply a valid user file through documented deterministic merge semantics; reject malformed, symlinked, unknown-field, and ceiling-raising input.
- Resolve default or execution-profile candidates, then apply a configured reasoning-profile override before scope/thinking validation.
- When a known profile has no mapping, use the role default and record visible fallback evidence.
- Preserve ordered availability fallback only before child launch; never retry a different candidate after runtime failure.
- Record package/user source, candidate index, requested/applied profiles, and fallback classes in the effective route.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-routing.test.ts
python3 -m json.tool config/csheng-subagents.json >/dev/null
npm run typecheck
npm pack --dry-run --json | jq -e '.[0].files | any(.path == "config/csheng-subagents.json")'
git diff --check -- config/csheng-subagents.json extensions/subagents/config.ts extensions/subagents/routing.ts tests/subagents-routing.test.ts
```

**Done when:**

- Package defaults select Luna-medium explorer, Terra-high worker, and Sol-high reviewer on the current authenticated catalogue.
- Peer fallback order is opaque data and user overlay behavior is deterministic.
- Missing or unmapped semantic profiles safely use and report the role default.
- No extension source contains logic that treats model family names as capability tiers.

**Recovery:** fix forward. Package-config integrity failure and route unavailability remain typed pre-child failures; do not mutate parent or user settings.

## SRE-300 — Add scheduler and task telemetry

**Depends on:** `SRE-100`

**Parallel group:** `routing-telemetry-evaluator`

**Delegation eligibility:** allowed for this repository-local disjoint slice

**Locks:** `subagent-scheduler-telemetry`, `subagent-result-schema`

**Touched files:**

- `extensions/subagents/scheduler.ts`
- `extensions/subagents/runner.ts`
- `extensions/subagents/workspace.ts`
- `tests/subagents-scheduler.test.ts`
- `tests/subagents-runner.test.ts`
- `tests/subagents-workspace.test.ts`

**Work:**

- Generate one invocation-local `runId` and versioned telemetry object without persisting separate state.
- Measure monotonic run, queue, workspace, child, and convergence durations at their owning boundaries.
- Track requested/admitted tasks, actual child launches, peak global concurrency, and peak concurrency by role.
- Distinguish pre-child workspace failure from a launched child with `childStarted` rather than usage inference.
- Return structured run-level admission/error evidence even when no normalized task exists.
- Keep cancellation, TERM/KILL escalation, output bounds, and cleanup behavior unchanged.
- Avoid objectives, prompt text, environment names/values, raw configuration, and external content in telemetry.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-scheduler.test.ts tests/subagents-runner.test.ts tests/subagents-workspace.test.ts
npm run typecheck
git diff --check -- extensions/subagents/scheduler.ts extensions/subagents/runner.ts extensions/subagents/workspace.ts tests/subagents-scheduler.test.ts tests/subagents-runner.test.ts tests/subagents-workspace.test.ts
```

**Done when:**

- Timing and peak metrics are deterministic under injected clocks or controlled executors.
- Ten mixed ready tasks reach peak ten while role peaks remain `4/4/2`.
- Admission, workspace, child, convergence, abort, and timeout outcomes are structurally distinguishable without raw content.

**Recovery:** fix forward with synthetic clocks and fake children. Do not add event logs, retries, or session-owned state to obtain metrics.

## SRE-400 — Add the project-local evaluator Skill

**Depends on:** `SRE-100`

**Parallel group:** `routing-telemetry-evaluator`

**Delegation eligibility:** allowed only as a read-only parser/test slice

**Locks:** `subagent-evaluator-skill`, `evaluation-schema`

**Touched files:**

- `.agents/skills/evaluate-subagent-runs/SKILL.md`
- `.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts`
- `.agents/skills/evaluate-subagent-runs/references/metric-schema.md`
- `tests/subagents-evaluator.test.ts`
- `tests/fixtures/subagents/`
- `docs/evaluations/subagents/`
- `tsconfig.json`

**Work:**

- Add a narrowly described read-only maintainer Skill discoverable only in this project context.
- Accept one explicit session path or ID plus optional output path; reject ambiguous matches and never read SQLite, settings, credentials, logs, or unrelated sessions.
- Parse Pi JSONL and classify tool calls, run outcomes, task records, actual launches, role routes, usage, cost, timing, convergence, and error classes.
- Distinguish authoritative telemetry schema one from legacy inference and label every inferred metric.
- Calculate mechanical dispatch-correction sequences separately from semantic repair, which remains unknown/inferred without parent evidence.
- Emit fixed-schema redacted JSON; never copy prompts, objectives, child output, stderr, environment values, route-file content, or external file text.
- Build synthetic fixtures for legacy and schema-one sessions.
- Generate one redacted baseline for session `01a04be7-df36-7775-8bbb-0c58a99a0670` only through an explicit command after the parser tests pass.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-evaluator.test.ts
npm run typecheck
node --experimental-strip-types .agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts --help
# Explicit baseline generation command is recorded during implementation without printing raw input.
git diff --check -- .agents/skills/evaluate-subagent-runs tests/subagents-evaluator.test.ts tests/fixtures/subagents docs/evaluations/subagents tsconfig.json
```

**Done when:**

- Synthetic cases prove ambiguity refusal, legacy launch inference, schema-one authoritative metrics, route aggregation, correction classification, and redaction.
- The baseline contains only the approved metric schema and reproduces from the named session.
- The Skill neither invokes subagents nor changes routing.

**Recovery:** stop and diagnose on session ambiguity or unknown wire shape. Never broaden a search or emit raw lines to make extraction succeed.

## SRE-500 — Integrate profile routing, telemetry, rendering, and E2E contracts

**Depends on:** `SRE-200`, `SRE-300`, `SRE-400`

**Execution:** serial, parent-owned

**Locks:** `subagent-entrypoint`, `subagent-rendering`, `live-e2e-contract`

**Touched files:**

- `extensions/subagents/index.ts`
- `extensions/subagents/render.ts`
- `tests/subagents-extension.test.ts`
- `tests/live-subagents-e2e.test.ts`
- `scripts/run-live-subagents-e2e.ts`
- `tests/package.test.ts`

**Work:**

- Pass optional profiles from normalized tasks into route resolution without reading a plan file.
- Build structured failed results for validation/config/routing errors with run telemetry and no child launch.
- Integrate scheduler, workspace, child, and convergence timing without changing parent authority or cleanup.
- Render compact route/profile and peak-concurrency evidence without exposing objectives, prompts, or sensitive paths.
- Update the live-E2E oracle to require package-owned extensions, role-preferred default routes, exact route source evidence, three role launches, and worker convergence.
- Keep non-plan and profile-omitted tasks on role defaults.

**Verification:**

```bash
node --experimental-strip-types --test tests/subagents-extension.test.ts tests/live-subagents-e2e.test.ts tests/package.test.ts
npm run typecheck
git diff --check -- extensions/subagents/index.ts extensions/subagents/render.ts tests/subagents-extension.test.ts tests/live-subagents-e2e.test.ts scripts/run-live-subagents-e2e.ts tests/package.test.ts
```

**Done when:**

- Fake-Pi integration proves default, mapped, and unmapped profile routes plus structured pre-child failure.
- One graph reports peak counts and route decisions consistently across progress and final details.
- Existing plan-mode and multi-skill behavior remains independent.

**Recovery:** fix forward. If integration requires plan parsing, task model fields, multiple active graphs, or cross-repository convergence, stop with `needs_design_decision`.

## SRE-600 — Synchronize truth, run deterministic convergence, and review

**Depends on:** `SRE-500`

**Execution:** serial, parent-owned

**Locks:** `stable-truth`, `package-probes`, `implementation-review`

**Touched files:**

- `AGENTS.md`
- `README.md`
- `docs/architecture/subagents.md`
- existing offline probe scripts only when observable contracts change

**Work:**

- Synchronize stable ownership, profile semantics, packaged defaults, caps, telemetry, evaluator usage, report redaction, and worktree/staging distinction.
- State explicitly that the extension does not parse plans and that missing profile metadata uses role defaults.
- Run complete deterministic validation and all six temporary/installed offline probes.
- Perform one bounded implementation review over the exact diff and approved design.
- Adjudicate every candidate and apply at most one focused repair, then rerun affected and declared checks without another review.

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

- Deterministic checks and probes pass.
- Stable docs describe only implemented behavior.
- Required implementation review has no accepted unresolved finding.

**Recovery:** one focused fix-forward repair only. A non-convergent review repair returns `non-convergent` rather than widening scope.

## SRE-700 — Run authority-gated live runtime evidence

**Depends on:** `SRE-600`

**Execution:** serial, parent-owned, not delegable

**Authority:** explicit real-provider approval required

**External effects:** consumes ambient provider capacity; installed mode reads the current user package list but does not mutate settings

**Work:**

- Run the temporary-package live E2E in a disposable Git repository under `~/tmp`.
- If separately authorized and the package is installed, run installed-package E2E.
- Verify actual explorer, worker, and reviewer routes match the package role preference or an explicitly documented authenticated fallback, profile omission uses defaults, and worker convergence applies.
- Emit only the fixed redacted summary and clean the disposable repository.

**Verification:**

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

**Done when:**

- Authorized live lanes pass once without retry.
- Route, role, launch, and convergence evidence is retained only in redacted form.

**Recovery:** stop and diagnose after one failure. Do not retry provider calls, change models, modify credentials, or weaken the oracle without a new decision.

## Cross-repository coordination

The companion `market-csheng` design may add provider-neutral plan semantics using the same words, but it is not a code, build, release, or implementation dependency. This plan remains valid for ad hoc callers and for plans authored by any source. No task in this repository mutates `market-csheng`.

## Authority boundary

Plan approval validates the repository-local task order and deterministic verification described in `SRE-100` through `SRE-600`; it does not authorize their execution. A separate implementation request is required. Neither plan approval nor implementation authority by itself authorizes:

- `SRE-700` real-provider calls unless live authority is explicitly included;
- creation or mutation of `~/.pi/agent/csheng-subagents.json`;
- global package install/remove/update;
- parent provider/model/thinking changes;
- commit, push, publication, or deployment;
- mutation of another repository.

## Review decision

A bounded plan review was required because the work changes public input/result contracts, route defaults, capacity, provider-consuming E2E, and a session-analysis surface. Review was limited to this plan, its exact approved design, current package scripts/tests, stable subagent truth, and repository authority rules.

Direct `review-plan` evaluation returned `pass`. Task order freezes shared contracts before three disjoint parallel slices, assigns one integration owner, uses deterministic contract/state-transition/session-fixture oracles, gates real-provider calls separately, and preserves package, user-setting, commit, push, and cross-repository authority. No material scope, dependency, oracle, authority, recovery, or work-package-readiness finding remains.

## Approval and implementation outcome

`approval_status = approved`. The user explicitly approved all pending plan and implementation authority in the implementation request. Repository-local implementation and both live-provider lanes completed with outcome `pass`.

Verification evidence:

- `npm run check`: 60 tests passed with typecheck and Shell syntax gates.
- Six temporary/installed offline probes passed.
- `npm pack --dry-run` retained `config/csheng-subagents.json`.
- Temporary and installed live E2E each launched explorer Luna medium, reviewer Sol high, and worker Terra high from `package-default`; worker convergence applied.
- The redacted legacy baseline reproduced 12 calls, 22 child launches, 47 turns, and aggregate cost `$2.278886` without retaining prompts, task IDs, paths, or child output.

Bounded implementation review returned two candidates. First, scheduler-active slices could overstate actual child-process peak concurrency and child timing included pre-spawn preparation. Second, the default npm pack surface included the project-local evaluator and retained reports despite their non-package ownership. Disposition for both: `accepted`. One focused repair moved peak accounting to child `spawn`/settlement callbacks, measured child time from successful spawn to close, retained failed workspace timing, marked spawn failure as `childStarted=false`, and added a package allowlist containing only `config/` and `extensions/` plus npm's mandatory metadata. The post-install check exposed one timing-based shutdown-test race; the oracle was repaired to await the fake child's readiness instead of sleeping. Affected and full declared verification passed after the same focused repair; no accepted finding remains.

No commit, push, package installation, user-route mutation, publication, or deployment was performed.
