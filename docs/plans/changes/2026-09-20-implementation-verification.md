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