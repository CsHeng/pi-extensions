# Subagent Result and Telemetry Reliability Implementation Plan

Status: implemented and verified locally on 2026-09-09; the initial implementation performed no installation or active-session reload.

Design input: [Result and telemetry reliability design](2026-09-09-subagent-result-and-telemetry-reliability-design.md). The user explicitly approved this implementation scope after both independent document reviews passed.

## Milestone and protected behavior

Deliver one repository-local change that removes runtime acceptance pseudo-state, makes managed request errors truthful and actionable, records attributable request/episode evidence, and preserves independently valid native observations. Document, but do not change, the current child-cost/parent-Pi accounting boundary.

Preserve fixed roles, foreground execution, trust, routing defaults, scope/write authority, replay/CAS/branch ownership, native/source continuity, writer cleanup, candidate integrity, bounded optional observations, and Pi-owned accounting. No automatic retry, approval, acceptance, background work, route changes, timeout changes, global installation, provider calls, or historical session repair.

Repository owner: `pi-extensions`. The active parent owns interface integration, verification judgment, review adjudication, accepted repairs, and final delivery. Existing unrelated edits in `extensions/herdr-handoff/contracts.ts` and `tests/herdr-handoff-contract.test.ts` are outside the write scope and must be preserved.

## Task packages

### T1 — Managed request/result and provenance contract

Dependencies: approved design D1–D4; no implementation dependency on T2.

Known write surfaces: `extensions/subagents/session-contracts.ts`, `continuation.ts`, `managed-sessions.ts`, `render.ts`, `context.ts`, and their corresponding contract/continuation/managed-session/render/context tests. The parent may refine helper placement inside the same subagent module; shared `provenance.ts` or `contracts.ts` changes require explicit integration ownership, not a second writer. No route/configuration-file mutation.

Work:

- Introduce v2 managed results, valid-action preservation/null invalid action, bounded missing-field guidance, and complete action-specific descriptions while preserving the flat provider-compatible input schema.
- Remove acceptance pseudo-state from model JSON, new and legacy TUI rendering, and repetitive stored-index text; preserve one compact static parent-ownership instruction.
- Capture bounded per-invocation `requestTelemetry` for success and refusal, with native parent ownership, a fresh opaque invocation identity, truthful nullable widths, actual launch/replay counts, and only actually observed provenance.
- Retain immutable episode execution provenance separately from request transport evidence. Preserve pure replay without a fresh configuration lookup, source refresh, model call, or rewritten episode identity.
- Version managed record/batch readers and writers together. Read v1 without inventing provenance; preserve old data and size/lock/owner checks; do not run migration on real local records.
- Update the tool-result error hook to recognize supported result versions and the null-action refusal shape.

Completion: A1–A3 pass, historical v1 fixtures are readable, unknown versions fail visibly, and all request/cache paths obey the new result contract. A1 includes failed calls and legacy rendering, not only a successful screenshot.

Verification: `node --experimental-strip-types --test tests/subagents-session-contracts.test.ts tests/subagents-continuation.test.ts tests/subagents-managed-sessions.test.ts tests/subagents-render.test.ts tests/subagents-continuity.test.ts`; `npm run typecheck`. Any new fixture belongs to this package, not real session storage.

Recovery: fix forward; retain old registry/native/source data. A destructive migration or changed replay authority is a stop condition.

### T2 — Native observation coverage and command correlation

Dependencies: approved design D5–D6; independent of T1 once the design's marker/coverage contract is fixed.

Known write surfaces: `extensions/subagents/observability.ts`, `worker-tools.ts`, `runner.ts`; `tests/subagents-observability.test.ts`, `subagents-worker-tools.test.ts`, `subagents-runner.test.ts`, `subagents-native-observation.test.ts`. A small shared correlation helper inside this module is allowed if it contains the actual shared behavior rather than a pass-through abstraction. The parent coordinates any `telemetry.ts` change before assigning writes.

Work:

- Replace host-ID-as-handle validation with one bounded, domain-separated correlation function used by both assistant-call and command-marker projection. Add an explicit v2 marker and `commandCorrelationVersion: 2` on normalized projections, plus a bounded legacy reader; normalize old cached projections and new marker data once.
- Preserve readable, owned native usage/command/capability evidence without requiring an episode timing marker. Expose absent timing and partial command coverage independently; do not read a valid prefix of an invalid physical tail.
- Keep task timeout, command timeout, provider stop reason, report completeness, native lifecycle settlement, and candidate eligibility independent.
- Add valid/invalid host-ID shape fixtures, duplicate/mismatched markers, mixed v1/v2 cases, missing timing, missing command endpoints, partial native tail, owner mismatch, and failed cleanup cases.

Completion: A5–A6 pass. A real command with a delimiter-bearing host ID produces correlated evidence; negative fixtures still produce partial/unavailable evidence instead of fabricated success. Existing native usage deduplication remains unchanged.

Verification: `node --experimental-strip-types --test tests/subagents-observability.test.ts tests/subagents-worker-tools.test.ts tests/subagents-runner.test.ts tests/subagents-native-observation.test.ts tests/subagents-protocol.test.ts`; `npm run typecheck`.

Recovery: fix forward without relaxing native structural bounds, lifecycle checks, or writer cleanup. Do not synthesize terminal command markers after forced termination.

### T3 — Evaluator compatibility and coverage

Dependencies: T1's accepted request/storage contract and T2's accepted observation/marker behavior. The parent must integrate their actual outputs before T3; this is not an automatic worker-to-worker handoff.

Known write surfaces: `.agents/skills/evaluate-subagent-runs/scripts/extract-session-metrics.ts`, `scripts/observation-metrics.ts` under that skill, its `references/metric-schema.md` and `SKILL.md`; `tests/subagents-evaluator.test.ts`, `subagents-observation-metrics.test.ts`.

Work:

- Add metric-v4 `managedDispatch` counts/coverage without changing one-shot totals or manufacturing native observations for current-epoch selection.
- Count all structured managed actions and refusals even when no parent observation window has settled. Preserve null/unknown action separately; never infer historical actions from tool arguments or prose.
- Separate request-version matching from returned episode origin, matching versus unassigned provenance, fresh launches versus replay, and report/apply versus parent acceptance.
- Preserve independently validated recorded usage when timing is missing while keeping scope/completeness explicit. Leave unavailable totals null; no substitution from legacy cumulative usage, provider pricing tables, or parent-process durations.
- Add mixed-version, configuration-change/replay, pre-trust refusal, parser refusal, no-parent-window, copied-owner/fork and conflicting-invocation deduplication, old-cache/new-command-projection equivalence, count-bound, malformed-record, and redaction fixtures.

Completion: A4 and observation-side A5/A8 pass. Historical input remains readable and conservatively unavailable where evidence is absent. The CLI still emits metric schema version four, refuses report overwrite, and requires explicit current-epoch root/manifest inputs.

Verification: `node --experimental-strip-types --test tests/subagents-evaluator.test.ts tests/subagents-observation-metrics.test.ts tests/subagents-observation-hooks.test.ts`; `npm run typecheck`.

Recovery: fix forward. Do not rewrite historical session files or reclassify missing provenance to improve reported coverage.

### T4 — Integration, truth sync, and implementation review

Dependencies: parent-accepted T1, T2, and T3. Parent-owned integration, not a delegated acceptance decision.

Known write surfaces: `tests/subagents-native-continuation.test.ts`, relevant existing fake-Pi integration tests, `tests/subagents-observation-hooks.test.ts` if integration requires it, README, root AGENTS only for affected boundary sentences, `docs/architecture/subagent-execution.md`, `subagents.md`, and `subagents-ui.md` only where acceptance presentation is described. T3 owns the evaluator skill/schema truth to avoid competing writers.

Work:

- Exercise real native append/reopen with a synthetic provider: a successful command using realistic host IDs, an outer child timeout, continuation after failure, replay/inspect, old-record reads, and candidate/source integrity. Do not wait 15 minutes: use existing injected deadlines/fakes while retaining real subprocess cleanup where that is the oracle.
- Test development and installed Pi lanes. Their current version difference is evidence to handle with fixtures, not authority to upgrade dependencies or change provider configuration.
- Add/extend adapter assertions that child usage is not accidentally promoted into top-level Pi `usage` and owned evaluator totals do not double count nested results. No new native-accounting bridge is included.
- Verify compact/expanded/new/legacy rendering and headless model content from code-driven fixtures; live inference is not the oracle for static phrasing and parser contracts.
- Update stable truth only after behavior is verified. Explain that offline missing evidence remains representable, acceptance is parent-owned without runtime pseudo-state, and Pi's session total currently excludes these child charges.
- Run independent implementation review focused on compatibility, trust/provenance ordering, replay counts, timeout evidence, command-key normalization, and absence of hidden acceptance/accounting authority. Parent adjudicates and repairs accepted findings, then reruns affected verification.

Completion: A1–A8 plus full repository validation pass, review has no unresolved material finding, unrelated changes are preserved, and the closeout distinguishes verified local behavior from unrun provider/live-install lanes.

## Coordination and execution order

T1 and T2 are cohesive independent implementation candidates, each including its tests and local repair. They may run as one flat batch after the parent resolves exact write paths and any shared helper ownership. No task is claimed dispatch-ready before that refinement. Keep concrete model selection, child handles, worktree paths, and scheduler details out of this plan.

T3 requires the integrated producer outputs, and T4 requires integrated producer and consumer evidence. These are factual compatibility dependencies. Parent adjudication/integration boundaries are explicit; do not compile them into a static worker/reviewer/repair chain. If delegation is unavailable, perform the same packages locally without changing the approved scope.

## Validation lanes

Targeted tests above protect individual contracts. The final offline repository lane is:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
```

Use the existing synthetic-provider subprocess lane inside deterministic tests for A7; do not replace it with a fake scheduler-only test. Installed probes verify temporary loading/removal against the installed CLI; they do not authorize modifying the user's installed package. `npm ci` changes repository-local dependencies only, not a global installation or route file.

Multi-skill print-mode probes and live subagent provider E2E are excluded because they require separate provider-call authority. Real session reading, if separately requested for post-change evaluation, must remain explicit, bounded, redacted, and non-mutating; it is not required to manufacture the regression fixtures.

## Implementation evidence

T1–T4 were completed in the parent checkout. The two initially delegated workers timed out without exportable candidates; their interrupted private state was preserved, and none of their source was copied or applied. The parent implemented the approved scope locally, including the user's addendum to retain actual provider/model/thinking in managed output and the stored index.

Final `npm run check` passed 368 tests, typecheck, and Shell syntax checks. All six approved temporary/installed no-inference probes passed; the two subagent probes were rerun after the runtime/coverage repairs. Native development/installed synthetic-provider tests exercise delimiter-bearing command IDs and inert replay. No live provider experiment or runtime reload was performed. Concurrent unrelated session-id-footer and initial Herdr edits were preserved; the final full check included the resulting current checkout.

Independent implementation review identified four material issues across the initial and targeted reviews: disk edits relabeling a loaded runtime, incomplete command outcomes retaining complete coverage, malformed v2 cached correlation keys, and reversed cached command timestamps. The parent accepted and repaired all four with focused regressions. A targeted final review passed. A flaky retention test advanced its injected expiry clock without controlling filesystem mtimes; its fixture now sets both run and child mtimes explicitly, preserving the original oldest-deleted/newer-preserved assertions. That oracle repair received independent review; production retention policy was not changed.

Stable truth was updated in README, subagent architecture docs, and the evaluator skill/schema. These results cover repository-local source and tests, not a deployed extension or historical-session rewrite. The active Pi instance can still show old output until an explicitly authorized reload/install step.

## Review and delivery

Independent design and plan review passed with no material findings on the user's explicitly authorized retry, using the same configured reviewer route without model or route changes. The parent accepted both evaluations; the earlier `child_model_error` blockage is resolved for this review invocation, without claiming its infrastructure root cause was diagnosed. Review covered the current documents, not an implementation. Later implementation review is required by T4 because of the persisted compatibility and observation-integrity risk, not because of a fixed iteration budget.

Delivery endpoint after a later implementation approval: verified repository source/tests/docs and an evidence-backed local closeout. No commit, push, publication, global install, reload of the user's running session, data migration, or provider experiment is included. Retain required managed evidence on errors; use fix-forward and stop only the affected package for a new protected-boundary conflict.

## Implementation-approval summary

- **C1 — Current authority:** the user's explicit approval on 2026-09-09 authorizes implementing T1–T4 within this plan; excluded operational actions remain excluded.
- **C2 — Covered actions:** approval covers T1–T4 repository-local source/test/docs changes, local dependency restoration, deterministic and non-inference installed-CLI probes, independent review, and accepted in-scope repairs through the stated local delivery endpoint.
- **C3 — Manual checkpoints:** independent review is complete, and no account, credential, physical prerequisite, or current capability gap has been identified for the offline implementation scope. Implementation approval is now covered. Helper placement, bounded fixture generation, and exact dispatch files are executor facts/products, not extra user approvals.
- **E1 — Continuous execution after approval:** proceed through the named packages and verification without serial approvals for ordinary local choices or repairs. Parent integration and finding adjudication remain parent-owned.
- **X1 — Pause conditions:** a required destructive migration, weaker ownership/CAS/lifecycle checks, changed telemetry acceptance semantics, wider repository/state access, native billing forwarding, provider calls, or changes to another extension need a narrow new decision. Independent safe work may continue.
- **X2 — Explicit exclusions:** commit/push/publish/deploy; global install or active-session reload; persistent route/model/provider settings; real managed-state cleanup/migration; synthetic acceptance or billing; timeout/concurrency tuning; automatic retry/continuation.
