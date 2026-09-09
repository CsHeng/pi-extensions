# Managed-Only Subagents and Floating Observer: Implementation Plan

Status: repository-local implementation verified. T1–T5 completed; independent implementation review, accepted repairs, targeted rereview and final exact-diff review passed. No installation/reload, commit/push, paid live probe or protected runtime-state operation was performed.

Design: [managed-only execution and floating observer](2026-09-09-managed-only-subagents-and-observer-design.md).

## Scope and delivery boundary

Implement D1–D5 and satisfy A1–A8 in the current repository. Retain `csheng_subagent_sessions` as the sole execution tool, retire one-shot runtime behavior, and default-load a read-only shortcut observer without enabling the bottom widget. Existing managed storage, fixed roles, explicit candidate apply/close, authority checks, bounds, native history, and historical evaluator compatibility are protected.

The deliverable is a verified repository-local implementation with stable truth synchronized and an adjudicated independent review. The current request covers producing and reviewing these two stage documents. A subsequent implementation approval covers the listed source/test/docs changes and deterministic disposable-fixture checks, not unrelated runtime or delivery actions. Earlier commit/push/update authority completed the preceding change and does not automatically authorize delivering this new breaking change.

There is no unresolved account or credential prerequisite for local design or deterministic implementation. Existing installed Pi and CC can provide local compatibility inputs; test fixtures and their evidence are implementation products, not user checkpoints. If actual TUI compatibility evidence cannot be produced, report that acceptance gap rather than substituting a headless pass or silently changing real settings.

## Capacity amendment

The user separately authorized prioritizing a managed storage capacity increase after implementation delegation hit the old byte and filesystem-entry limits. The verified repair sets an 8 GiB root and 1,000,000 filesystem entries; native parsing remains capped at 100,000 entries. The remaining plan preserves this amended baseline. No old or newly allocated runtime record was discarded, resumed, or applied. Further limit changes and storage reclamation remain outside scope.

## Execution package

### T1 — Establish the managed-only core and observation contract

Dependencies: none. Owner: implementing parent or one cohesive core worker; parent owns acceptance and removal decisions.

Known surfaces: `extensions/subagents/index.ts`, `contracts.ts`, `session-contracts.ts`, `events.ts`, `context.ts`, `observation-hooks.ts`, one-shot-only diagnostics/activity helpers where proven unused, and directly associated contract/extension/host/context tests. Preserve shared imports and historical parser needs; a pure legacy helper may be relocated within the subagent module rather than keeping a live one-shot executor.

Work:

- Freeze a typed v2 UI observation contract and bounded parser with the owner/generation/revision, dispatch/task identity, actual route, timing/count, terminal and redaction semantics in D3. Keep storage/result versioning and legacy evaluation separate.
- Remove `csheng_subagents` registration, its direct convergence and active-control wiring, and obsolete diagnostics allocation/control paths. Keep managed registration, runtime-pinned provenance, managed context, parent observation hooks, and Pi settlement/shutdown behavior.
- Keep `/subagents` as truthful read-only managed/configuration status. Retire the one-shot-only debug command and misleading counters. Update static tool guidance for all three roles and explicit create/continue/apply/close. Disclose that close releases slots but required retained history can permanently fill the bounded store until a separately authorized maintenance path exists; no general cleanup operation is promised. Disclose that retiring one-shot removes shell-free/narrow-scope writable delegation; the retained managed worker has trusted host bash and repo-wide input.
- Preserve report-only create DAG support and explicit dependency-free continuation. Add bounded labeled predecessor context; do not silently change continuation into graph resumption. File-dependent successors require a parent-authorized apply between separate dispatches, because managed predecessor candidates are not visible in the parent checkout. Do not auto-apply or share private sources to bridge that difference.
- Classify old one-shot tests: port protected runtime invariants to managed fixtures, retain frozen historical decoder tests, and remove tests only for genuinely retired product behavior. Do not delete integrity assertions simply to obtain a green suite.

Completion/oracles: only the managed tool registers; explorer/reviewer/worker parsing and context guidance are accurate; trust, routes, external reads, graph constraints, and replay remain enforced; snapshot parser rejects arbitrary sensitive data and stale/invalid shapes. Existing managed record versions still load. A1–A4 have named test owners after the caller inventory.

Recovery: fix forward. No runtime record writes or current-session reload. Stop on evidence that removal would require changing protected native/candidate semantics rather than retaining shared implementation.

### T2 — Publish managed live observations

Dependencies: accepted T1 core/protocol artifact. Owner: core producer slice.

Known surfaces: `extensions/subagents/continuation.ts`, `activity.ts` or a purpose-specific managed observation helper within the module, direct lifecycle/continuation/observation tests, and runner lifecycle integration only if existing hooks cannot expose actual child start/settlement. Preserve the scheduler's execution ownership and current resource policies.

Work:

- Publish accepted/running/settling/terminal observations from actual managed lifecycle events, including fresh child starts, live activity, terminal failures/aborts, and bounded heartbeat updates.
- Attach actual resolved routes before live rendering. Keep route unavailable when not resolved; do not perform route/config lookup solely to decorate replay.
- Distinguish queued tasks, actual launches, active children, completed episodes and cached replay. Inspect/apply/close/replay do not manufacture running activity; busy refusals leave an active dispatch intact.
- Bind events to the correct parent session/branch and runtime generation. Clean up heartbeat resources in finally/shutdown paths and protect execution from failed subscribers.
- Preserve required request/execution provenance, native timing/usage ownership, source settlement, and replay/candidate facts. Keep tool-row output functional but do not negotiate with CC's renderer.

Completion/oracles: A3/A5 synthetic lifecycle fixtures cover successful and failed native children, timeout without final timing, admission refusal, replay, subscriber exceptions, and zero false launches. Clock tests verify nullable/monotonic evidence and terminal publication. No new task is resumed, applied, or closed as an observation side effect.

Recovery: suppress invalid optional UI publication while retaining authoritative execution failure/evidence. Do not add retries, recover old records, increase limits, or turn display status into lifecycle state.

### T3 — Make the floating observer the default UI entry

Dependencies: accepted T1 v2 contract. May run independently of T2 once the shared contract is stable and parent integration ownership is explicit. Owner: UI slice.

Known surfaces: `extensions/subagents-ui/index.ts`, `component.ts`, `render.ts`, UI/unit/integration tests, `package.json`, and `tests/package.test.ts`. No writes to CC, Pi internals, user settings, status-footer, work-timing, or todo.

Work:

- Default-load the UI extension in the package, with bottom widget/status/custom completion persistence off. Keep the existing widget renderer behind a tested default-false opt-in seam; do not delete it or create a settings file.
- Reuse the shortcut and command to open one read-only overlay; Escape closes the view only. Remove cancel/control key paths from this observer without removing core host abort support.
- Render route/reasoning, turns, elapsed and execution status; label aggregate launched/running/finished counts. Support scrolling and narrow-width layout so required identity remains inspectable.
- Subscribe to the v2 protocol, validate current owner/branch/generation and revisions, and retain bounded current/recent-terminal state. Open late into current work; handle empty, completed and stale states truthfully.
- Separate overlay repaint lifetime from snapshot collection. Freeze terminal elapsed, stop extrapolation when stale, and dispose timers/handles on closure and host lifecycle resets. Default UI must not call setWidget, setStatus, setFooter, setWorkingMessage, or append completion entries.

Completion/oracles: A6 fake-Pi tests drive the registered shortcut/command, not only formatting helpers; verify default-off widget and read-only keys, row content, narrow widths/scrolling, changing counts, late opening, closed/reopened view, terminal retention, invalid/reordered/foreign events, lifecycle reset and headless inactivity. Explicit opt-in still exercises retained widget rendering.

Recovery: disable the optional observer without disabling managed execution. Do not replace host UI internals or add a fallback footer/widget when the overlay fails.

### T4 — Integrate consumers, compatibility evidence, and stable truth

Dependencies: T2 and T3, after parent reconciliation of their actual integrated candidate. Owner: parent-led integration; bounded fixture/doc labor can be delegated after shared files are assigned.

Known surfaces: subagent extension/UI integration tests, native synthetic-provider fixtures, historical evaluator tests and narrowly required decoder imports, `.agents/skills/evaluate-subagent-runs/` docs, temporary/installed subagent probes, candidate-binding support for the six offline probe lanes where needed, `scripts/run-live-subagents-e2e.ts` and its tests, package tests, AGENTS, README, and `docs/architecture/subagents*.md` plus `subagent-execution.md`. A static retired-tool reference in `extensions/herdr-handoff/index.ts` may be updated to the retained tool without changing Herdr execution behavior. Related stable prose may be adjusted for the same reference; no broader Herdr or other-extension change belongs here.

Work:

- Migrate remaining maintained callers/probes to managed create and explicit apply/close; keep old one-shot identities only in historical decoding/fixtures and explicit removal assertions. Default-load tests now account for the additional UI entry while extension-off probes find neither execution nor UI registrations. Bind installed-host probes to this exact candidate using disposable package-discovery configuration pointing at the checkout, without installing/updating the real package or using ambiguous ambient discovery. Assert the resolved extension source belongs to the candidate before collecting evidence. Apply the same identity discipline to all six probe lanes where they claim final-candidate coverage; installed Pi compatibility is distinct from delivery of a separately installed package.
- Add explicit native explorer create/continue and external-read coverage, bounded predecessor context tests, and a same-batch unapplied-file invisibility test followed by a separate dependent dispatch after explicit parent apply. Test slot release by explicit close separately from mandatory-history storage exhaustion, retained/discard behavior, and typed unrecoverable-via-close capacity refusal. Preserve worker no-parent-write-before-apply and host-bash/repo-wide admission assertions. Do not auto-close existing or interrupted real sessions to satisfy a fixture.
- Preserve frozen one-shot and managed evaluator outputs, native observation ownership and billing non-forwarding. Historical reading is not an old executable tool surface.
- Implement a deterministic CC co-load TUI fixture using the installed package as a read-only dependency and disposable HOME/agent directories. Exercise on and compact modes with synthetic child activity, open the real observer shortcut/command, and assert its visible content and updates independently of hidden tool cards. Use a controlled TUI host or PTY as appropriate; do not represent RPC/print output as overlay evidence. No real provider credentials/calls, persistent CC configuration, or dependency installation are needed or allowed for this lane.
- Migrate the gated live-E2E source to the new tool and explicit worker apply checks, but do not run that paid lane. Keep output redacted.
- Synchronize stable ownership, tool names, removal semantics, overlay default, widget opt-in boundary, historical evidence policy, and user migration guidance after behavior is verified. Preserve immutable old stage artifacts.

Completion/oracles: A1–A8 evidence inventory distinguishes actual TUI co-load proof, synthetic native provider proof, and static historical compatibility. Obsolete shared helpers are removed only after consumers are proven gone. Current live tool guidance contains no instruction to call the removed API.

Recovery: fix forward inside the agreed boundary. A real CC integration failure is a named incomplete acceptance item, not authority to patch the installed package, change user settings, or weaken the observer's required data.

### T5 — Verify, independently review, and hand off

Dependencies: parent-accepted T4 integration. Parent owns verification judgment, candidate findings, repair decisions, truth sync, and final response. This is not a worker-to-reviewer-to-repair automatic graph.

Run the repository's deterministic checks and six no-inference probes:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
python3 /home/csheng/.agents/skills/organize-docs/scripts/normalize-markdown-prose.py --root /home/csheng/workspace/pi-extensions --mode check --immutable-manifest /home/csheng/workspace/pi-extensions/contracts/markdown-prose.toml
```

Run the focused CC co-load fixture from T4 and check final diff whitespace. Check links and verify each remaining retired-tool occurrence is deliberately historical or an absence assertion. New test command placement may be refined by the implementing agent; the required evidence categories may not be silently omitted.

Request independent implementation review covering the one-shot deletion boundary, managed authority/history invariants, display disclosure and ephemeral lifecycle, and executable TUI evidence. Parent adjudicates candidate findings, implements accepted in-scope repairs, and reruns affected checks. Prefer retained reviewer/worker continuity when available; otherwise provide a reconstructed bounded brief and identify that limitation. No fabricated handle or automatic continuation is part of this plan.

Completion: final candidate meets A1–A8, stable truth matches code, required review has no unresolved accepted findings, and the outcome distinguishes repository readiness from installation/reload/delivery not performed. Any failing required test or missing real TUI evidence keeps implementation incomplete.

## Coordination and authority

T1 is the only factual predecessor for the v2 contract and removal boundary. T2 and T3 are cohesive parallel candidates after the parent integrates T1; shared contract edits return to that parent rather than racing. T4 follows producer/UI reconciliation. T5 follows integration. Planning does not encode these tasks as a durable runtime graph.

Delegation is conditional, not yet dispatch-ready: the parent must bind exact write files and shared resources inside these module-level scopes, select the available compatible host mechanism, and own integration. No worker may mutate another repository, installed package, settings, route file, or runtime store. Historical child sessions are not implementation instructions; current interrupted tasks are not automatically reused.

No changes to models, routes, concurrency, timeouts, storage ceilings, billing forwarding, or process isolation claims are authorized adaptations. Ordinary helper placement, fixture composition and documentation layout within the stated surfaces remain executor choices. Use existing TypeScript and Shell conventions; this is not a language migration.

## Design/plan review

Independent design and plan reviews completed. The parent accepted four concrete findings and repaired the documents: disclose the lack of general mandatory-history reclamation; distinguish report ordering from candidate filesystem visibility; disclose the retirement of shell-free/narrow-scope writable delegation; and bind installed-host probes to the actual candidate without real installation changes. T1/T4, A1–A3 in the design, and the approval summary cover the repairs. A targeted reconstructed rereview passed. Review success is not implementation approval or proof of future TUI behavior.

## Implementation-approval summary

- Decision recorded: the user subsequently approved D1–D5 and T1–T5 through apply/implement-change. The original design/plan request alone did not grant mutation authority; the later request now covers local implementation under these boundaries and the explicit capacity amendment above.
- Approval would cover: repository-local source/test/probe/doc changes, retirement of the old public execution tool and automatic convergence, managed-only explicit apply/close semantics, package loading of the observer with widget default off, deterministic disposable native/TUI fixtures, independent review and accepted in-scope repair. It also accepts three disclosed migration consequences: no shell-free/narrow-scope writable worker remains; file-dependent stages require explicit apply between dispatches; mandatory retained history may exhaust the existing store without an in-tool reclamation path. Expanding GC/storage recovery is not silently included.
- Already covered: creating and reviewing these stage artifacts, read-only repository/installed-package investigation, and the user-selected managed-only/floating-observer direction. No additional credential/manual setup is known to block local implementation.
- Manual checkpoints: none currently for the local implementation endpoint. A missing executable co-load oracle is a verification gap to resolve or report, not an implicit provider-call or installation permission.
- Excluded: commit, push, publish, package install/update, active-session reload, persistent settings/route edits, real-provider probes, historical storage migration/deletion, applying or continuing existing interrupted tasks, todo work, CC patches, independent-agent dashboards, UI task controls, and automatic close/apply/retry/continuation.
- Continuous-execution boundary after approval: carry the local change through integration, verification, review, repair and truth sync without extra approvals for ordinary in-scope choices. Pause only for changed execution/authority semantics, protected-state risk, an acceptance change, or a new external side effect. Do not silently reintroduce one-shot execution, auto-convergence, a widget fallback, or missing-evidence success to get past a blocker.

## Execution evidence and disposition

The verified local candidate implements T1–T5. The old execution registration, debug command, automatic workspace convergence, diagnostic allocation/retention runtime and v1 snapshot/control modules are removed. Shared native-session/limit interfaces and scheduler cancellation outcomes remain with their live consumers. Historical evaluator decoding and fixtures remain; retired auto-convergence/GC/control tests are no longer live acceptance owners. Managed candidate tests retain or port mode preservation, nested-file creation, symlink/ancestor refusal, undeclared mutation, parent drift and partial-apply assertions. An unchanged managed source continues to return no candidate rather than adopting the retired one-shot zero-diff failure rule.

Acceptance inventory:

- A1: managed entry/host/package tests and all six offline probes passed; subagent probes report old tool/debug absent, managed/UI present, exact candidate source identity and extension-off absence. Installed-host discovery uses disposable configuration pointing to this checkout, not a real installation update.
- A2: actual native synthetic-provider tests cover the three roles, explorer external Git reads and continuation, report-only predecessor context, same-create unapplied-candidate invisibility, explicit apply and a separately dispatched reviewer observing applied bytes. Host-bash/repo-wide worker admission remains explicit.
- A3: replay/CAS/owner/branch, native/source/candidate/provenance/correlation, timeout/abort and partial-apply tests pass. Explicit close releases a slot, preserves mandatory evidence on discard, and rejects changing a closed retain disposition. The service-level history-full refusal test injects the capacity error; separate store sparse-file/entry tests own actual filesystem-budget admission. These are disposable fixtures, not maintenance of retained real records.
- A4: historical evaluator and native observation fixtures pass without changing historical one-shot accounting or forwarding child billing into main-session tool usage.
- A5/A6: protocol, producer and registered UI tests pass, including mixed historical replay, unknown clocks, actual starts, subscriber exceptions, monotonic revisions across successive dispatches, staleness, terminal retention, lifecycle dismissal, default-off widget/status, read-only controls and terminal-cell-aware scrolling.
- A7: both real installed Pi/CC PTY cases passed, with zero skips. On and compact modes hide the synthetic partial tool marker while the registered shortcut opens the observer and model/thinking/count/terminal updates remain visible. This uses a synthetic UI stimulus, not a claim of native-child execution; native execution has its separate oracle above.
- A8: `npm ci --ignore-scripts`, `npm run check` (378 tests passed, zero failures/skips), all six offline probes, Markdown validation and whitespace checks passed. The paid live-E2E source and unit fixtures use managed create, explicit candidate apply and explicit close; the paid lane was not run.

Review disposition: accepted and repaired generation-local revision reset hiding a shorter subsequent dispatch, and mixed replay showing the current record episode instead of the cached episode. An open lifecycle concern was resolved by explicit overlay dismissal/reset and retired-generation rejection. Parent inspection also corrected terminal-cell wrapping and the actual `render(width)` viewport. Targeted independent rereview passed. A separate migration/deletion review passed; a supplemental reviewer read the complete exact diff, including all new TypeScript files, and found no new material findings. Reviewers performed static evaluation; command/test verification and final acceptance remain parent-owned.

During final verification, two new candidate tests initially matched human error prose instead of the preserved `WorkspaceError.code`; they now assert the exact `write_symlink` code. A concurrent mixed-route fixture assumed child start order; it now keys evidence by task ID without changing route expectations. The full suite and all six probes then passed on the repaired candidate. No acceptance condition was relaxed.

Stable truth is synchronized in AGENTS, README, the docs index and subagent architecture/execution/UI documents, plus the historical evaluator scope notes. Existing interrupted/episode-zero managed records were not resumed, applied, discarded or deleted. The earlier failed/timed-out implementation delegations remain retained evidence; no unknown request was replayed. Repository readiness is the endpoint, not delivery into the active installed session.
