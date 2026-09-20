# Subagent execution primitives

## Availability

`git-workspace.ts` and `session-supervisor.ts` are implemented and component-tested building blocks for the approved asynchronous/worktree change. They are not registered as a second tool and are not yet connected to `ContinuationService`. The installed/default managed tool therefore still has its existing foreground, exact-write, private-source behavior. Installing this checkout does not enable the new asynchronous contract or migrate old sessions.

The implementation and remaining integration work are recorded in [the verification handoff](../plans/changes/2026-09-20-implementation-verification.md). The existing architecture documents remain authoritative for the default runtime. This boundary is deliberate: dependency acquisition and the declared host/toolchain could not be established in the implementation environment, so unverified store/protocol/host changes were not made active.

## Git boundary

`captureGitInput` uses an independent index and Git objects to capture current tracked and non-ignored visible source, including dirty content. Staging categories, parent index, HEAD and branch are unchanged. Ignored dependencies are not prepared by this module. Git content normalization still applies; custom content filters/encodings, sparse checkouts, submodule input, external symlinks, unsupported path encoding and unresolved index conflicts are reported rather than emulated.

`createGitTaskWorkspace` creates a detached linked worktree and records its exact Git registration and owned refs. That trusted ownership record must be persisted by the managed-session owner before treating the workspace as recoverable. The common Git repository is shared; this is file isolation, not a sandbox against arbitrary shell commands. Namespace objects and refs are real local Git mutations, not user-branch commits.

`freezeGitCandidate` fixes the result relative to the input actually received, so inherited dirty input is not counted as child work. `applyGitCandidate` computes the three-way result with Git, publishes only the delta from the current parent, and leaves the parent index unchanged. A candidate is immutable even when later work changes the task directory; episode/version acceptance belongs to the caller. A clean merge is not verification or acceptance.

`refreshGitInputs` is explicit and requires an idle writer. It preserves the previous candidate, merges new parent input, and updates the input basis only on success. Conflict results retain all versions without modifying the parent or throwing away the worker's edits. The caller owns conflict resolution and persistence of the updated ownership record; there is no continuous synchronization daemon.

Capture and apply require coordination with parent file writers. They are not atomic snapshots against arbitrary external edits and do not promise a whole-tree rollback after I/O failure. `discardGitWorkspace` is an explicit disposal operation on recorded ownership only; it does not infer acceptance, delete user branches, or run repository-wide prune/gc. Default retain policy, native history, environment management and legacy migration remain integration responsibilities.

## Asynchronous boundary

`SessionExecutionSupervisor` owns a session-local submission registry, preparation, shared global/role capacity and explicit resource leases. The existing graph scheduler can use `runTask` for capacity; dependencies, semantic task selection and model routing remain outside this module. No polling, provider loop, automatic retry, apply, repair, or acceptance is introduced.

The receipt follows input preparation, not child completion. The initial tool signal governs preparation only; each accepted run has its own cancellation signal. One-shot hosts can explicitly `join` the same execution. Runner callbacks must honor cancellation and retain their existing bounded process cleanup. Runs are retained in memory with a finite admission bound; persistent request replay, close/reclaim and cross-process recovery are not supplied by this class.

Terminal facts are recorded in the in-memory view before `onEvent`, which may await persistence. `onEvent` receives old-owner cancellation facts too, so it must filter owner/generation before updating a current workflow or UI. Wake delivery is separately fenced and coalesced; successful task completions do not get a duplicate successful-run wake. A delivery failure does not erase the result or imply the model consumed it.

Use `suppressWake` for a real parent abort/provider error, not ordinary `agent_end` or compaction. `replaceOwner` fences the old generation before cancelling its work. An asynchronous host adapter must recheck owner identity immediately before calling Pi's message API, including after its own awaits. Completion can precede the tool-result consumer, so the workflow adapter must preserve dispatch-time basis and reconcile by run identity rather than attach a late result to whichever attempt is current.

## Validation boundary

The three component test files use Node's test runner, controlled promises, and disposable Git repositories, without Pi packages or provider calls. They prove local library behavior and composition, not TUI/RPC re-entry, native history reuse, workflow enrollment/acceptance, package co-load, macOS behavior, or wall-clock economic gains. Run the existing full package checks after the declared dependency/toolchain environment is available, and complete the approved integration before enabling the new default.