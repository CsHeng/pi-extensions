# Managed-Only Subagents and Floating Observer

Status: repository-local implementation verified. Independent design/plan review, implementation review, targeted repair rereview, and final exact-diff review passed. Installation, reload, commit, push, and live-provider delivery remain outside this change; see the companion plan's execution evidence.

Companion: [implementation plan](2026-09-09-managed-only-subagents-and-observer-plan.md).

## Objective and user decisions

Replace the two public subagent execution paths with the existing managed mechanism. Remove the one-shot `csheng_subagents` tool rather than preserve a compatibility executor. Expose model with reasoning, turns, elapsed time, and execution status in a keyboard-opened, read-only floating observer. Accept that pi-cc-extensions may collapse or replace conversation tool cards. Keep the bottom widget implementation but leave it off by default. Todo changes are outside scope.

This is a breaking execution-surface change, not simply enabling the existing UI. The retained public tool is `csheng_subagent_sessions`; no rename to `Agent`, new alias, run-once wrapper, or automatic create/apply/close sequence is introduced. One episode can finish a task without requiring a continuation.

## Capacity amendment

During implementation startup, managed delegation hit both existing root bounds. The user explicitly prioritized increasing capacity. A separate verified repair raised root capacity to 8 GiB and 1,000,000 filesystem entries while retaining the 100,000 native parsing bound and other per-record limits. This amended capacity is the baseline for the remaining migration; it does not authorize further increases, history deletion, automatic retry, or resuming the records left by refused dispatch.

## Current evidence

- `extensions/subagents/index.ts` registers the one-shot tool, direct worker convergence, one-shot progress snapshots, status/debug commands, managed tool, shared context hooks, and parent observation hooks. Removing this entire extension would also remove required managed behavior.
- `session-contracts.ts`, `roles.ts`, and `continuation.ts` already accept explorer, reviewer, and worker tasks. Managed create supports bounded task graphs through the shared scheduler. Continue deliberately supplies explicit episode messages and clears dependency edges; it does not rerun the original graph.
- Managed workers retain private source and native history, export candidates, and require explicit parent apply. One-shot workers instead use temporary snapshots and direct convergence. That automatic convergence is intentionally retired, not reproduced inside managed execution.
- `ManagedSessionStore` bounds unclosed sessions per repository/parent session to ten, with separate byte and episode limits. Moving short tasks to managed execution makes explicit close discipline important; it does not justify increasing limits or silently collecting records.
- `subagents-ui/index.ts` is not package-loaded by default. When loaded, it currently publishes footer status, a below-editor widget, and completion entries; its overlay also offers cancellation. It observes only one-shot snapshots and cannot open a settled snapshot.
- `events.ts` v1 has no route or owner generation, and rejects model-like keys. The existing UI drops different active run IDs and does not fully reset on session start. Managed progress does not publish those events.
- Installed pi-cc-extensions 0.8.69 replaces partial tool-card output in on mode and hides ordinary collapsed cards in compact mode. Its dedicated Agent name is not a Pi subagent API. Pi's generic `ui.custom(..., { overlay: true })` is the appropriate host surface; actual co-load behavior still needs a TUI oracle.

## Architecture decision

The constrained resource is user attention and reliable visibility, not parallel execution capacity. The current duplication also increases maintenance and caller-choice costs.

| Option | Decision and cost |
| --- | --- |
| Keep both execution paths and only add a richer UI | Reject: leaves the user-requested execution duplication and auto-convergence path in place. |
| Managed-only execution plus an ephemeral floating observer | Select: reuse existing capabilities, accept explicit candidate/apply and close semantics, and retire one-shot producers. |
| General independent-agent dashboard or a CC-specific adapter | Defer: adds session management, coupling, or control authority without demand. |

The subagents core owns execution facts and required persistence. The observer owns only bounded in-memory presentation and its repaint lifecycle. The parent remains the decision owner for delegation, continuation, candidate apply, verification, acceptance, and close. Pi owns host turns, tool availability, overlays, abort, and session lifecycle. Maintainers own migration of this repository's consumers; external caller updates cannot be silently supplied by a tool alias.

A future independent-agent dashboard requires demonstrated demand for several independently controlled top-level sessions. Interactive child controls require a separately approved control contract. Neither is necessary for this milestone.

## D1. One public execution mechanism

Retain `csheng_subagent_sessions` with create, continue, inspect, apply, and close. Preserve provider-compatible schema shape, request identities, replay purity, owner/branch checks, CAS, trust, fixed roles, routing overrides, resource bounds, and failure typing.

Retain all three roles and their existing managed authority, external read rules, create graph admission and predecessor ordering, and explicit continue behavior. Label bounded predecessor context with identity/status instead of concatenating anonymous outputs, preserving existing prompt limits and trust treatment. Continue never implicitly replays predecessors or expands semantic work.

Managed create dependencies order reports, not candidate filesystem visibility. A worker predecessor's successful report does not apply its candidate; a downstream reviewer reads the unchanged parent checkout and a new worker receives that parent source. If downstream work needs predecessor file changes, the parent must consume the candidate, explicitly apply it, and dispatch the dependent work in a later call. Do not silently share private candidate sources or apply inside the scheduler to recreate one-shot behavior. Guidance must distinguish report-only edges from filesystem-dependent work; graph eligibility remains parent-owned.

Retiring one-shot also retires its narrow-scope, shell-free writable worker. The retained managed worker requires repo-wide input and trusted host bash; candidate write guards do not sandbox bash's filesystem, credentials, or network authority. This is an explicit caller-authority migration, not equivalent protection under a shorter name. Explorer/reviewer remain read-only, and this milestone does not introduce a replacement restricted writable role. Approval must acknowledge that loss rather than silently routing old restricted-worker assumptions to managed workers.

Managed workers keep repo-wide input, exact candidate write paths, isolated source/index/dependencies, and explicit apply. A successful report never directly mutates the parent checkout. All existing partial-apply, drift, unknown-writer, native-owner, timeout, and cancellation integrity rules remain mandatory.

Short read-only work follows create, consume evidence, and explicit parent close when the task is no longer needed. Workers follow create, parent evaluation, optional explicit apply/continue, and explicit close. Static guidance must explain retain/discard and the ten-unclosed-session bound. The extension does not auto-close or discard, and an observer action cannot choose disposition. Close releases an open-session slot, not all storage. Discard removes private source/candidate/input material but retains registry/native history; closed retain cannot later be changed to discard through the current close API. Mandatory history counts toward the global bounds and has no general public-tool reclamation action. This milestone deliberately preserves that bounded-storage limitation: exhaustion fails visibly, and may remain blocked pending separately authorized storage-maintenance design/recovery. Do not imply that another close will fix it, silently raise the cap, or delete history. The short-task migration increases the rate of accumulation; this disclosed capacity tradeoff is part of implementation approval, while retention/GC expansion is deferred.

## D2. Deliberate removal and historical compatibility

Remove one-shot registration, runtime guidance, automatic convergence wiring, one-shot-only active controls, allocation/retention machinery, and unused execution helpers. Retain shared runner, scheduler, graph, workspace/path, routing, role, telemetry, and observation functionality where managed callers need it. Import/caller evidence, not filenames, determines deletion.

Keep `/subagents` as a read-only managed capability/configuration status command; remove misleading one-shot active counters rather than fabricate managed activity. Remove `/subagents-debug` if it only serves the retired one-shot diagnostic store. `/subagents-ui` remains an observer-opening alias, not a management command.

Preserve historical one-shot JSONL evaluation, immutable provenance semantics, metric-v4 legacy counters, and v1/v2 managed record/result reading. Retain pure legacy decoding/types only when historical consumers require them, clearly separated from live registration. No historical one-shot record is imported into managed storage or displayed as a running task. No old record, native session, candidate, provenance manifest, or interrupted task is rewritten, resumed, applied, or discarded by migration.

Repository-owned probes, active guidance, live-E2E source, package tests, and maintained docs must target the retained tool. Old tool-name occurrences are allowed only in explicit retirement assertions, historical decoders/fixtures, and stage history. Historical stage artifacts are not rewritten. No unrelated plugin or user-owned Skill/configuration is edited to conceal an external caller still requesting the removed tool.

## D3. A managed observation contract, not a new runtime

Introduce a versioned v2 UI snapshot event for managed dispatches. Keep this protocol separate from persisted record/result versions and historical cancellation/telemetry decoding. It must be a closed allowlist with bounded scalars and rows, not an arbitrary result or native transcript envelope.

The contract includes:

- Parent session and branch provenance sufficient to reject foreign or abandoned-branch updates; an ephemeral producer generation and monotonically increasing revision prevent stale reload/out-of-order updates from winning.
- Dispatch identity and phase, requested/admitted tasks, actual launches, active children, settled tasks, aggregate turns, and nullable observed elapsed time.
- At most ten task rows with bounded identity/ordinal, fixed role, episode association when known, task status and execution phase, actual resolved provider/model/thinking when available, assistant turns, and nullable elapsed time.
- Explicit terminal/refusal/stale semantics and omitted-row count if rendering or caching is capped. No invented timestamps, percentage-complete value, or synthetic route fallback.

Resolved route strings are narrowly permitted for user-visible in-process observation. Preserve exclusion of objectives, prompts, outputs, commands, paths, credentials, environment, and tokens. Validate route strings for bounded UTF-8 length and terminal controls. Do not globally relax the old sensitive-key guard, put the full route configuration on the bus, or add model strings to persisted completion summaries/evaluator output. Pi's in-process bus is not a security sandbox; this is a deliberate bounded display disclosure.

Publish from the managed lifecycle: admission, scheduler/child start and activity, bounded heartbeat, settlement, and terminal error/abort. Count only actual fresh child launches. Pure inspect/apply/close and cached request replay do not start running rows or increase launch counts. Mixed fresh/replay dispatches distinguish cached evidence from live work; stored idle/interrupted state is not a liveness signal. Busy refusals must not displace an existing active dispatch.

UI failures must not fail execution, block convergence, initiate recovery, or change required telemetry/storage. Use the existing managed foreground scheduling gate; do not add a scheduler, polling of native files, durable UI ledger, automatic retries, or recovery controller. Ensure terminal publication on all entered live paths, including failure/abort, while required native/source settlement remains authoritative.

## D4. Floating observer only by default

Load `extensions/subagents-ui/index.ts` through the package so its keyboard entry is available. Reuse `Ctrl+Alt+F` and `/subagents-ui`; Escape closes only the observer. Check shortcut conflicts through supported host behavior; do not steal a conflicting shortcut or patch CC internals. The command remains a usable alternative if the terminal cannot transmit the shortcut.

The default UI registers no bottom widget, no footer status, and no new durable completion entry. Preserve the existing widget rendering code behind a default-false, explicitly testable opt-in seam, without creating or modifying a user settings file. Enabling that optional widget is not part of this milestone.

The floating panel is read-only. Remove cancellation key handling and event emission from this observer; there are no continue, apply, close, send-message, or task-control actions. Scrolling and view navigation are presentation, not execution control. Core host-abort handling remains unchanged.

Rows show role/ordinal, actual provider/model and reasoning, status/phase, turns, and elapsed. Aggregate counts label launched versus running versus finished clearly. Narrow windows wrap or provide viewport scrolling so model/reasoning/status remain inspectable; they must not silently disappear behind truncation. Long lists have explicit overflow, not a misleading complete prefix.

Opening late in an active dispatch shows the cached current snapshot immediately. Keep the current active dispatch and the latest completed dispatch within a small bounded cache; unrelated refusals or replay must not replace the active view. After completion, freeze terminal elapsed and keep the result view available until replaced or session/branch reset. A new session, branch switch, extension reload, or shutdown clears obsolete live cache. Empty state says there is no observed work, not that all stored handles are closed or successful.

Elapsed display may advance from observed monotonic elapsed plus a local receipt-time delta while fresh, but must stop extrapolating after a missed-heartbeat budget. Mark such rows stale/unknown rather than asserting running or completion from silence. Repaint timers exist only as needed while the overlay is open; core publication remains bounded independently of visibility. Dispose timers/subscriptions/overlay handles on close, settlement where applicable, session reset, and shutdown. Closing the window must not abandon the core event cache or abort work.

No overlay is opened automatically. Headless modes create no UI, shortcut effects, repaint intervals, or display persistence. The observer does not call setFooter or setWorkingMessage and does not depend on CC's tool-card renderers.

## D5. Migration and recovery

The source update intentionally removes the old public tool; callers must use the retained managed tool. No hidden compatibility executor is shipped. Do not reload extensions while an old call is active. Existing interrupted managed records remain inert and protected; any later continuation/apply still requires explicit inspect and parent authorization.

Adopt fix-forward recovery for code and docs. Malformed or unsupported observation events are ignored without changing execution; missing live evidence yields an honest unavailable/stale view. UI disablement must leave the managed executor fully functional. Historical storage recovery, force apply, bulk cleanup, and downgrade migration are outside scope.

This design authorizes no runtime settings mutation, package installation/update, active-session reload, commit, push, provider probe, or production-data operation. Those are separate delivery actions, not implied by the design/plan request.

## Acceptance evidence

- A1: Registration and temporary/installed-host no-inference probes bound explicitly to the final candidate checkout find only the managed execution tool; old tool and one-shot debug command are absent. Installed-host evidence is not a claim that a separately installed package was updated. Plan mode's read-only tool set is unchanged. UI is package-listed and dormant in headless modes.
- A2: Native synthetic-provider fixtures cover explorer/reviewer create and continue, external reads, bounded report-only create dependencies, explicit continue messages, and worker create/candidate/apply. A dependent task in the same batch cannot observe an unapplied predecessor candidate in the parent filesystem; after explicit apply, a separately dispatched dependent task can. No parent write occurs before explicit apply. Tests and guidance distinguish managed host-bash/repo-wide worker authority from the retired shell-free worker. Limits and refusal typing remain enforced.
- A3: Existing replay, CAS/owner/branch, timeout/abort, private-source integrity, native observation, command correlation, provenance, and partial-apply regressions pass. A read-only task can be explicitly closed and release an open-session slot. Disposable fixtures prove that discard retains required history, closed retain cannot be silently discarded, and a store filled by mandatory history still returns its typed storage-limit refusal without deleting history or claiming close recovered capacity.
- A4: Frozen historical one-shot and managed fixtures produce unchanged historical evaluator results. No fixture is reclassified as new managed execution and no live observer reads old runtime files.
- A5: v2 snapshot tests exercise route validation/redaction, no fabricated model, launch/active counts, queued/cached distinction, terminal errors, revision/generation/owner rejection, heartbeat staleness, and subscriber-failure containment.
- A6: Fake-Pi/TUI tests open the actual overlay via shortcut/command; verify row content, scrolling/narrow widths, live updates, terminal retention, empty state, and session/branch reset. Control keys emit no execution requests. Default widget/status/persistence calls are absent; widget code remains testable through explicit opt-in.
- A7: Deterministic co-load TUI evidence with the installed CC on and compact modes proves the observer remains visible while tool cards are collapsed/replaced. Use a disposable HOME/agent directory and synthetic provider, without changing real CC settings or calling a real provider. A headless registration probe alone cannot satisfy this acceptance item.
- A8: Full npm check, six maintained offline probes, Markdown validation, and an independent implementation review pass for the final candidate. Retained live-E2E source is migrated to managed create/explicit apply, but running a real-provider lane remains excluded. Main-session billing forwarding remains unchanged.

## Truth impact and review decision

After implementation verification, update AGENTS, README, subagent architecture/execution/UI docs, evaluator scope guidance, and probe documentation. Stable docs must distinguish an optional display consumer from execution authority and historical decoding from a supported live tool. Do not promote this draft into runtime guidance before behavior is implemented.

Independent design and plan reviews ran because this removes a public execution/convergence path and changes an observation disclosure contract. The parent accepted four findings: the false implication of supported storage reclamation, missing candidate filesystem visibility across dependency edges, loss of the restricted shell-free worker, and ambiguous installed-probe candidate identity. D1/A1–A3 and the companion plan now explicitly cover their consequences and executable evidence. A targeted reconstructed rereview passed with no remaining material contradiction in those boundaries. This is design/plan review, not implementation verification.

The user subsequently approved the managed-only direction and floating-only default for implementation, including the disclosed worker-authority, dependency/apply, and bounded-history capacity tradeoffs. The separately authorized capacity amendment above changes the root budget, not those tradeoffs or the protected runtime records.
