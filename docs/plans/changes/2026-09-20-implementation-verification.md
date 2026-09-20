# Best-effort implementation verification

Status: partial implementation. This document distinguishes tested primitives from default runtime integration. Do not treat the approved design as shipped behavior.

Base: `12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd`. The user authorized implementation, offline validation, local commits and full Git ZIP delivery, and allowed blocked work to be recorded. No remote push, installation, provider call, publication, or production access was performed.

## Git backend checkpoint

`extensions/subagents/git-workspace.ts` implements native Git input capture with an independent index, detached linked workspaces, immutable input-relative candidates, three-way integration, parent worktree-only apply, explicit idle-writer input refresh, and exact-owned resource discard. It does not introduce custom content hashes or a merge implementation. The caller still owns episode state, single-writer exclusion, environment preparation, persistence, and acceptance.

Twenty-two disposable-Git tests passed. They exercise dirty/staged/untracked input, unborn repositories, staged-new ignored files, staged deletion with visible content, file/directory transitions, independent workspaces, dynamic additions, compatible and conflicting merges, inherited-input deletion, rename/delete/mode/binary/internal symlink changes, refresh and conflict preservation, immutable candidates, repeated apply, candidate identity, owned cleanup and ref changes, existing destinations, unsupported external symlinks/filters, and unresolved index conflicts. The standalone strict TypeScript result is in the matching log.

These are library tests, not proof that the installed tool has migrated. The existing `ContinuationService`, persisted schema, native capability guards, workflow observation, UI, telemetry, and default source backend have not yet been switched in this checkpoint. No second writable backend is enabled in production.

## Environment blockers

`npm ci --ignore-scripts` failed because the configured npm mirror could not resolve (`EAI_AGAIN`). Available Node is 22.16.0, below the dependency-declared minimum 22.19.0 for Pi 0.86.0. Full package typecheck, Pi-backed tests, TUI/RPC probes, and installed/live combination validation are not reported passed. Dependency retries and live provider calls were not used to bypass this blocker.

Raw logs are retained under `docs/evaluations/2026-09-20-async-worktree/`. Further implementation checkpoints update this record rather than replacing unverified outcomes with a success claim.

## Final delivered checkpoint

The final component run passed **52 tests: 24 Git workspace tests, 25 supervisor tests, and 3 combined Git/async tests**. Standalone strict TypeScript checking passed for both new modules and all three new suites. It used the available global TypeScript and ts-node Node declarations, not the unavailable package-locked dependency set. Existing shell scripts passed `bash -n`. Exact tool versions and raw final logs are retained alongside the earlier checkpoint logs.

`session-supervisor.ts` implements accepted-versus-completed receipts, shared cross-submission role/global capacity, explicit locks, request deduplication, owner generations, preparation-only tool cancellation, independent task terminal events, persistence-before-wake callbacks, cancellation, explicit join, wake suppression and shutdown. No live agent loop is created. The combined tests exercise dirty parent input, two independently writing tasks, parent progress, an early result applied before a sibling finishes, explicit refresh and same-workspace repair, subsequent integration, fixed queued inputs, cancellation retention, and owned cleanup. They do not exercise the existing Pi/native runner or native conversation history.

## Plan accounting

| Plan work | Delivered | Still required |
| --- | --- | --- |
| X01 | Internal typed receipt, task/run result, event, owner and workspace interfaces. | Version the public tool/store envelope and implement v1/v2 legacy read-only handling. |
| X02 / X04 | Tested Git capture, detached worktree, candidate, merge, refresh and apply primitives. | Wire them into allocation/episodes; replace private-Git assumptions in environment and file guards; make initial write regions advisory. |
| X03 / X05 | Tested session supervisor, shared capacity, task events and wake/cancellation controls. | Replace the existing global foreground gate; use the native runner and real Pi lifecycle/message hooks; preserve host mode and task-local mutation semantics. |
| X06 | No production workflow changes. | Persist dispatch-time attempt/basis association, reconcile early/late terminal events, distinguish waiting from no progress, and prevent duplicate continuation. |
| X07 | Exact-owned worktree/ref discard primitive with tests. | Integrate retain/discard, native evidence retention and legacy record close into the persistent store. |
| X08 | Internal task preparation/queue/start/end facts only. | Adapt observer/UI and cost/telemetry consumers without counting receipts as child execution. |
| X09 | 52 deterministic/component tests, standalone typecheck, shell syntax, targeted author review. | Full package checks, real Pi offline probes and independent integration review. No paid model lane is required merely to prove the local protocol. |
| X10 | Complete original Git ancestry plus committed code, tests, records and standalone repository ZIP. | User installation/publication is outside this delivery. |

## Direct continuation path

Do not redesign the approved goals or repeat completed Git mechanism experiments. First restore the package-declared Node and dev dependencies and run baseline checks. Then use the internal types to make the public v3 store/tool change in one coherent integration: allocate and persist source/basis before receipt, hand the existing runner to the supervisor, use Git workspace/candidate records instead of fixed-file manifests, and update file/environment guards together. Keep the old default operational until the replacement path is coherent; do not silently accept new writes through old exact-write validation.

Wire terminal facts to the workflow using the original dispatch association, not the latest attempt. Handle a fast terminal arriving before the submission tool-result observation. Only after persistence should the Pi adapter request a current-owner turn; ordinary waiting must not create a follow-up polling loop. Update observer and accounting at the execution event boundary, not when the submission tool returns. Finally connect close/legacy handling and run the actual host probes.

This is a substantive but **partial runtime implementation**, not a completed asynchronous tool migration. The unchanged production `ContinuationService` still waits for its batch and still uses the existing private-source backend. No README statement or approved plan should be interpreted as changing that fact.