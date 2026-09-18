# Goal-Driven Workflow Implementation Plan

## Status and planning basis

State: `E1_complete` after the user's explicit approval, source implementation, offline verification and independent review adjudication. This plan implements the selected [design](2026-09-18-goal-driven-workflow-design.md) and [target architecture](2026-09-18-goal-driven-workflow-architecture.md). GC-01 through GC-07 are complete. The user's subsequent `publish , commit and push` authorizes local snapshot publication and committing/pushing this change. Daily-process restart/load confirmation and E3 live effectiveness remain outside this delivery. The pre-implementation v1 ledger remains compatibility validation and historical fixtures; [current architecture](../../architecture/workflow.md) describes source-delivered v2.

The authorized portable Skill wording slice has been implemented with generated parity and repository checks. It does not establish that the proposed runtime, legacy migration or live effectiveness is delivered. Its evidence and remaining review are recorded in the design.

The execution goal is completion integrity with low model-side administration, not exact reproduction of a planning-time diff. File names below locate likely owners; they are refinable implementation context unless explicitly identified as an exclusion or authority boundary. Do not freeze a SHA, require a clean tree, or request reapproval for compatible same-goal parallel changes. Before each actual write or dispatch, use current source, preserve other work, declare the host-required exact capabilities and reverify affected integration.

## Milestones and delivery endpoints

| Milestone | Outcome | Authority |
| --- | --- | --- |
| S0 | Necessary portable Skill semantic clarification, generated mirrors and offline checks | Authorized by the current user request; completed before final package review. |
| E1 | New generic contract runtime in authored source, migrated/readable legacy fixtures, offline installed-host evidence, aligned stable docs and tool guidance | Explicit user approval of this plan; no live calls, installation or publication. |
| E2 | Refresh the copied local Pi package and verify the user's restart/load | Local publication explicitly authorized by `publish , commit and push`; user restart/load remains unverified and is not requested. No settings rewrite. |
| E3 | Bounded matched-task effectiveness evaluation with actual models | Separate explicit provider/session-access budget and sample approval. Not part of deterministic correctness or E1 completion. |

E1 source delivery does not claim the daily Pi process changed or the live abandonment problem is empirically solved. E2 does not prove E3. The later explicit request authorizes commit and push of this change; npm release, remote deployment, destructive cleanup and provider/model configuration changes remain excluded.

## Scope and implementation constraints

E1 owns `extensions/workflow/`, its focused tests and fixtures, workflow probe scripts where needed, and corresponding `README.md`, `AGENTS.md`, stable architecture and stage outcome records. A narrowly necessary shared prepared-input/observation helper may change only with regression coverage for its existing consumers. It must not change other extensions' semantic behavior or introduce a project/Skill schema loader.

Keep the TypeScript extension and existing Node test/fixture toolchain; no new language, service or scheduler is justified. Continue using public Pi hooks, commands, session snapshots and the main agent. Preserve trust, cancellation, input lineage, append-before-install persistence, bounded output/storage and explicit candidate apply. No runtime code is changed by preparing this plan.

Ordinary task storage and rpiv integration are excluded from E1. The optional contract view remains owned here and independently removable. Conditional review remains main-agent-owned; the extension does not choose reviewers, dispatch repair chains or reinterpret business requirements.

## Execution packages

These tasks are cohesive source packages, not one worker per file. They are not pre-certified for delegation: exact writes, current interfaces and shared resources are refined at dispatch inside E1 authority. Missing dispatch metadata is not a user checkpoint. All writable worker slices have one repository owner; cross-repository integration and acceptance stay with the parent. A dependency here passes an implemented interface or evidence, never permission to bypass a parent decision.

### GC-01 — Specify the semantic protocol and regression oracles

- Owner: `pi-extensions`; no predecessor.
- Outcome: define the minimal enroll/begin/report/revise/finish/inspect/incomplete-disposition surface, generic requirement support, semantic keys, internal record ownership and legacy boundary. Field names are executor choices; completion meaning is not.
- Likely surfaces: `extensions/workflow/contracts.ts`, `tool.ts`, `tests/workflow-provider-schema.test.ts`, `workflow-reducer.test.ts`, `workflow-batch.test.ts` and fixture helpers.
- Oracle: failing cases for ordinary task non-enrollment; at most one begin and one milestone report for an unchanged cohesive slice; one fact supporting several obligations; missing required verification; rejected oracle evidence; corrected/duplicate/stale reports; no hardcoded Skill or phase name.
- Completion evidence: an explicit protocol table and executable discriminating cases, including the provider serializer's actual accepted schema.
- Failure path: investigate API/association gaps locally. Preserve the goal and choose the smallest supported field/host mapping; return a design decision only if the public host cannot support the selected ownership boundary, not because a predicted helper or file changed.

### GC-02 — Implement contract state and atomic semantic updates

- Owner: `pi-extensions`; depends on GC-01's contract and fixtures.
- Outcome: required obligations and cohesive task state support repair without DAG growth; reports normalize internal attempts/evidence/judgments and update support atomically. Revisions and replay identities stay internal without silent stale semantic writes.
- Likely surfaces: `contracts.ts`, `reducer.ts`, `store.ts`, `batch.ts`, `result.ts`, `tool.ts`, `branch.ts`; reducer, result, batch, persistence and repair-invariant tests.
- Oracle: finish cannot pass missing/failed required support or active accepted findings; conditional applicability remains explicit; grounded requirement revision selectively invalidates support; changing an incidental planning SHA does not change authority. Observe one committed snapshot and one view update per semantic mutation.
- Completion evidence: deterministic state/transaction suite plus bounded receipts that name remaining business obligations rather than internal record repair steps.
- Failure path: fix forward; retain the previous committed projection on failure. Do not silently drop required obligations, rewrite history or auto-cancel to get a passing close.

### GC-03 — Bind real facts to the candidate actually checked

- Owner: `pi-extensions`; depends on GC-02's correlation and support interfaces.
- Outcome: real tool/check facts have usable references or unambiguous current-slice association; verification binds the checked candidate, not a universal pre-edit whole-cwd fingerprint. Ambiguity and unavailable bindings produce actionable verification gaps.
- Likely surfaces: `observation.ts`, `fingerprints.ts`, `tool.ts`, relevant host-adapter/helper seams; `workflow-evidence.test.ts` and disposable source/candidate fixtures.
- Oracle: implementation changes before verification can complete; scoped non-repository work is representable; unknown host facts cannot be fabricated; tool success is not semantic acceptance; untracked/parallel changes invalidate only affected proof. A stale child candidate remains refused, then a safely reconciled result with fresh checks can complete without new same-goal permission.
- Completion evidence: host-observed fact/provenance fixtures and source integration tests; existing subagent source/candidate/trust regressions remain unchanged and pass.
- Failure path: preserve facts and report what binding is unavailable. Refine scope or use a supported observation method; never weaken a candidate guard, fabricate a digest, or claim unchanged bytes prove correctness.

### GC-04 — Replace the one-reminder policy with guarded continuation

- Owner: `pi-extensions`; depends on GC-02 and GC-03.
- Outcome: after the public settlement barrier, continue while an authorized runnable obligation remains. Productive runs can cross multiple successful settlements; unchanged repeated settlement gets the designed diagnostic opportunity and then visible incomplete suspension, not endless replay or automatic semantic non-convergence.
- Likely surfaces: `review.ts`, `settlement.ts`, `alignment.ts`, `host-adapter.ts`, `index.ts`; settlement, command-barrier, input-credit, delivery-contract and installed-host tests.
- Oracle: at least three productive premature settlements continue to fulfillment; no-input ordinary task never triggers; a blocked node does not stop another runnable node; repeated equivalent facts, wording-only progress and duplicate next-step claims do not replenish continuation. Actual user cancellation, new input, host/provider error, explicit budget and branch/session replacement invalidate the pending request.
- Completion evidence: deterministic traces and actual Pi synthetic-provider runs, with each continuation dispatched through `sendUserMessage` only after all settlement consumers finish. No timer, private API or second model owner.
- Failure path: missing/unarmed public capability visibly suspends continuation with remaining work. Do not patch Pi, retry providers, spawn a background runner or manufacture business completion.

### GC-05 — Keep projection optional and align public guidance

- Owner: `pi-extensions`; depends on GC-02's committed view contract. It can run independently of GC-04 only after shared view/tool interfaces are applied and writes are disjoint.
- Outcome: contract state is the sole source for required tasks; view off/failure has no semantic effect; public tool guidance enrolls meaningful completion contracts rather than all three-step conversations. Stable tool-key references remain sufficient for model interaction.
- Likely surfaces: `ui.ts`, `ui-render.ts`, `tool.ts`, `index.ts`, relevant UI/provider tests. The parent coordinates `tool.ts` ownership with GC-03/GC-04 rather than assuming file independence.
- Oracle: UI on/off/unloaded state produces identical contract transitions; no ordinary todo can close an obligation or trigger continuation; clipped UI text cannot become model state. Guidance contains no named Skill dependency or old mandatory low-level bookkeeping recipe.
- Completion evidence: read-only projection/UI fixtures and actual provider-schema checks. Do not introduce a second ordinary-task ledger to pass a display test.
- Failure path: disable only the failing view; retain the committed contract and normal Pi loop. Keep general todo integration deferred.

### GC-06 — Verify legacy recovery and installed-host composition

- Owner: `pi-extensions`; depends on GC-02 through GC-05.
- Outcome: legacy worksets remain identifiable/readable, never silently promoted to strict v2 obligations or accepted as fresh proof. Explicit same-goal migration/re-enrollment preserves provenance and remaining requirements without demanding new user permission. Restart never auto-resumes.
- Likely surfaces: schema/replay adapters and `tests/workflow-persistence.test.ts`, `workflow-installed-host.test.ts`, `workflow-co-load.test.ts`, installed/temporary workflow probe fixtures and scripts.
- Oracle: actual v1 open/accepted/blocked/closed fixtures; explicit migration with an active goal; corrupt newest snapshot; old binary seeing unsupported newest state; fork with old running work; cancellation and new input during async preparation; co-loaded extension hooks and UI failure after commit.
- Completion evidence: migration compatibility tests and both offline temporary-load and installed-host workflow probes. These probes target disposable settings, not the user's running package.
- Failure path: expose unavailable/migration-needed state and keep old history. Fix forward from current evidence; do not auto-repair session JSONL, fall back to an older accepted snapshot, or reset storage.

### GC-07 — Accept E1 and synchronize implemented truth

- Owner: parent integration in `pi-extensions`, with read-only `agent-skills` conformance check; depends on all earlier packages.
- Outcome: run aggregate offline checks, adjudicate an independent exact-change review, repair supported in-scope findings, and update stable architecture/tool instructions to the behavior actually verified. Preserve this design/plan as stage history with the E1 evidence and remaining E2/E3 limits.
- Likely surfaces: `README.md`, `AGENTS.md`, `docs/architecture/workflow.md`, `docs/README.md`, this design/plan outcome section; no global agent instructions or settings.
- Oracle: aggregate commands below, target/current documentation consistency, no cross-repository import, no unsupported live-effectiveness claim. Same-goal integration changes are reconciled and affected checks rerun, not treated as automatic reapproval gates.
- Completion evidence: changed files, actual checks and results, review disposition, portable Skill generated parity, unverified remainder and source-only delivery statement.
- Failure path: continue justified in-scope repair and targeted re-verification; stop only for the concrete unresolved decision, capability, supported non-convergence, actual interruption or explicit budget. No default review/repair count and no cosmetic acceptance workaround.

## Verification commands and lanes

During source implementation, run targeted existing or newly added tests after each behavior slice. New focused test placement follows the fixture owners above; do not create a separate workflow engine to test workflow. Before E1 acceptance:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-workflow-probe.sh
bash scripts/run-installed-workflow-probe.sh
```

The aggregate suite includes unaffected extension regressions. If a shared observation/input seam changes, explicitly demonstrate its existing consumers still pass; do not use workflow-only tests as a substitute.

The following generation and validation commands were executed for the separately authorized S0 portable Skill slice, from the `agent-skills` repository. They are S0 evidence, not the read-only E1 conformance procedure:

```bash
python3 scripts/generate-skills-index.py
python3 scripts/flatten-skills.py --target root-flat
python3 scripts/generate-workflow-diagrams.py
bash scripts/check.sh
```

For GC-07's read-only `agent-skills` conformance check, run only `bash scripts/check.sh`; its index, root-flat and diagram gates use `--check` and do not refresh the tracked or installed Skill tree. Diagnose any mismatch without running the S0 generation commands against the live tree. Any necessary Skill source/update action must remain within the separately covered semantic-adjustment authority, not be inferred from this read-only E1 step.

These are deterministic/local evidence lanes. A dependency fetch is not provider-inference authority. No live multi-skill or subagent E2E lane is silently added. The future E3 protocol must separately select bounded matched tasks, session access and provider budget, track actual missing-work continuation as well as workflow call/rejection counts and observed usage, and distinguish host correctness from real-model effectiveness. It must include same-file drift and ordinary-task controls so reducing bookkeeping does not hide premature completion or unauthorized continuation.

## Coordination, drift and recovery

The parent owns integration and final acceptance. Use flat independent work only after interfaces, exact dispatch capabilities and shared-resource ownership are actually known. Shared `tool.ts`, fixture helpers, schemas and snapshot writers require coordination. File-dependent successors receive explicitly applied source changes before dispatch; graph edges or reports alone do not transmit candidates.

A new SHA or overlapping diff triggers reading and reconciliation, not a goal amendment by default. Retain explicit write restrictions and candidate compare-and-apply checks. If compatible changes can be preserved inside E1 authority, integrate them through an authorized path and rerun affected checks. An unresolved conflicting requirement or unsafe overwrite pauses only its affected surface while other work proceeds. Commit/push authority comes from the explicit follow-up request; no reset, stash, force apply or branch rewrite is authorized.

Fix-forward is the default across packages. E1 has been accepted and local publication is now explicitly authorized. A failed runtime feature must not induce automatic provider fallback, child dispatch, candidate apply, ledger repair or session restart. Operational suspension preserves the uncompleted contract and its reason.

## Implementation-approval summary

**Already covered:** architecture/design/plan authoring and the bounded portable Skill wording changes with generated validation. The desired goals, separation and goal-based drift principle are confirmed.

**Effective E1 approval:** implement GC-01 through GC-07 in `pi-extensions` within the surfaces and exclusions above, including the versioned semantic tool protocol, contract state/legacy reader, fact binding, repeated productive continuation with anti-spin suspension, optional projection, tests and stable truth sync. Exact helper names, current file locations, fixture details and supported host mapping are executor-owned refinements, not future user checkpoints.

**Agent-executed work, not missing permission:** inspect current source, capture candidate identities, reconcile compatible in-scope drift, refine exact worker capabilities, generate artifacts, run offline checks, repair supported defects and selectively reverify. Investigable facts, test failures, new SHAs and ordinary touch-list changes are not approval requests.

**Real pause conditions:** the goal/acceptance or a user-fixed restriction must change; a required side effect lies outside authority; the public host cannot support the promised boundary; ownership/conflict cannot be resolved safely; actual prerequisite or invocation budget is unavailable/exhausted; or supported diagnosis leaves no in-scope path. Preserve remaining work and continue independent authorized tasks where possible.

**Effective delivery approval:** the user's subsequent `publish , commit and push` authorizes `mise run publish-local-package` and a focused commit/push of this change to the configured upstream. This supersedes the E1-only exclusion of those actions. User process restart/load, live provider evaluation, npm publication, deployment, settings/provider changes and destructive history/storage operations remain excluded; E3 still needs its own bounded evaluation authorization.

## Outcome record

The design/planning package and S0 wording slice are complete. The earlier independent plan review's accepted read-only Skill-conformance clarification and targeted pass remain in the [design review record](2026-09-18-goal-driven-workflow-design.md#review-record).

### E1 source delivery

GC-01 through GC-07 are complete in the authored working tree. The new default entry registers semantic v2 implementation contracts; legacy v1 modules remain for read-only validation and explicitly named historical fixtures. At the E1 acceptance checkpoint, no local snapshot had been published and no daily Pi process restart/reload, live effectiveness evaluation, commit or push had been performed. Subsequent publication/commit/push authority and execution belong to the delivery record below; E3 remains unexecuted.

| Package | Delivered evidence |
| --- | --- |
| GC-01 | `goal-contracts.ts` defines explicit enrollment, fulfillment versus continuation, bounded facts/subjects and semantic operations. Ordinary TUI/RPC/print/JSON analysis produces no contract or continuation. |
| GC-02 | `goal-store.ts` and `goal-tool.ts` own revisions/atomic commits. A normal slice is `start` plus compound `report`; failures/incomplete proof are diagnostic outcomes. Corrections replace stable fact keys and opaque host calls are deduplicated. |
| GC-03 | Check-time host binding supports edit-then-test. Declared evidence stays declared; fabricated observations fail. Canonical overlap, retained alias identity, symlink retargeting, unavailable basis, same-file drift, unaffected acceptance and obsolete reported attempts have focused regressions. |
| GC-04 | The public waiter preserves Pi settlement ordering. A real dependency-host synthetic trace executes three productive continuations and then fulfills after four distinct checks on unchanged source. Unchanged work suspends; active no-op resume cannot reset history. Task blockers retain independent ready work. |
| GC-05 | The optional v2 view is off by default and read-only; show/hide/list, width bounds, headless inactivity and failure isolation have tests. Historical v1 installed visual fixtures remain explicitly historical, not a v2 screenshot claim. |
| GC-06 | Actual v1 open/blocked/accepted/closed snapshots are readable without promotion; explicit migration preserves requirements and provenance without old acceptance. Newest corruption, old-reader refusal, interrupted recovery, async input/cancel fencing, co-load and installed CLI continuation are covered. |
| GC-07 | Stable `README.md`, `AGENTS.md`, docs index and architecture reflect the verified protocol and boundaries. Independent review findings were adjudicated and repaired; final aggregate verification and read-only portable Skill conformance pass. |

Final verification:

- `npm ci --ignore-scripts`: passed; dependency fetch only, no provider inference.
- `npm run check`: passed, including typecheck, **619 tests passed, zero failed/skipped**, and shell syntax checks.
- `bash scripts/run-temporary-workflow-probe.sh` and `bash scripts/run-installed-workflow-probe.sh`: passed against disposable settings and synthetic providers, not the daily installed snapshot.
- `bash scripts/check.sh` in `agent-skills`: passed read-only generated-index/root-flat/diagram parity, 111 tests, lint/type checks and Markdown checks. No S0 generation/install command was run for E1.
- `bash /home/csheng/.agents/skills/organize-docs/scripts/check-doc-boundaries.sh`: passed; no hard-wrapped Markdown prose. Final diff and document checks recorded after this outcome annotation.

The initial bounded core-worker episode timed out without a candidate. The parent retained the interrupted evidence, closed its record and implemented locally; no candidate was silently resumed/applied/discarded. Independent review `session_c830a2b0-9093-404d-8314-75a06efefe2c` returned four accepted findings: alias identity lost during canonicalization, reuse of reported evidence after semantic amendment, active resume resetting anti-spin, and distinct checks collapsing into no progress. All were repaired with regressions. A targeted follow-up found volatility in raw-output progress identity; the parent accepted and repaired that too. The final targeted rereview returned `pass`; F1–F3 had already been confirmed, and no accepted finding remains. The reviewer record is closed, with native review evidence retained and disposable working files discarded.

Progress recognition conservatively uses actual check inputs plus structured outcomes; free-form output-only novelty, timing controls, managed execution IDs and usage cannot independently renew continuation. This is a bounded classifier limitation, not a claim that arbitrary output differences are semantically understood. The main agent retains interpretation, acceptance and ordinary in-interaction work. It does not weaken required completion evidence.

Test subprocesses and disposable settings/directories were cleaned by their harnesses; no persistent service was started. The initial interrupted managed record was retained under the managed-history policy rather than automatically discarded. Deterministic source/host correctness is established; requirement projection quality, real-model abandonment/cost improvements and the version loaded by the user's running process remain unverified.

### Authorized publication and Git delivery

The follow-up user request `publish , commit and push` authorizes the verified change's local snapshot publication and a focused commit/push to the configured `origin/main`. Preflight found `main` synchronized with `origin/main`, no older outgoing commits, and no repository-owned CI/deployment configuration. No implementation source changed after the recorded 619-test verification; delivery annotations received fresh document/diff checks.

`mise run publish-local-package` passed. Byte/file comparisons confirmed that the copied package's `package.json`, `config/` and `extensions/` match authored source. The publisher did not edit settings or user routes, and its temporary staging was cleaned. Git history and the verified upstream identity own the resulting commit/push evidence, rather than embedding a self-referential commit hash in this document.

Publication is complete; user restart/load confirmation remains unverified. No daily-process restart/reload, live provider evaluation, npm publication, settings change or remote deployment was performed.
