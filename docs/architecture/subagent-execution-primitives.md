# Subagent execution primitives

## Availability

`git-workspace.ts` and `session-supervisor.ts` are the integrated primitives behind the current `ContinuationService`, not a second tool. The [managed execution contract](subagent-execution.md) owns multi-root runtime behavior and shallow unsupported-version exclusion. This document owns the lower-level Git/supervisor boundaries.

The verification handoff distinguishes imported component evidence from subsequent full runtime integration. Historical records are indexed under `$AGENT_ARCHITECTURE_DIR/archived/README.md`; cross-owner collaboration changes are registered in `$AGENT_ARCHITECTURE_DIR/docs/plans/coordination/README.md`. Authored source changes do not update an installed local package snapshot automatically.

## Git boundary

`captureGitInput` uses an independent index and Git objects to capture current tracked and non-ignored visible source, including dirty content. Staging categories, parent index, HEAD and branch are unchanged. Ignored dependencies are not prepared by this module. Git content normalization still applies; custom content filters/encodings, sparse checkouts, submodule input, external symlinks, unsupported path encoding and unresolved index conflicts are reported rather than emulated.

`createGitTaskWorkspace` creates a detached linked worktree and records its exact Git registration and owned refs. That trusted ownership record must be persisted by the managed-session owner before treating the workspace as recoverable. The common Git repository is shared; this is file isolation, not a sandbox against arbitrary shell commands. Namespace objects and refs are real local Git mutations, not user-branch commits.

`freezeGitCandidate` fixes the result relative to the input actually received, so inherited dirty input is not counted as child work. The apply primitives compute a three-way result with Git, distinguish conflict from an executable clean plan, publish only the validated parent delta and leave the parent index unchanged. The managed owner persists per-root pre/post evidence and owned resources before destination mutation, checks the complete bundle under destination locks, and reconciles interruption against that evidence. Exact integration-ref creation intent is checkpointed before creating the ref and promoted before its plan becomes executable. Failed promotion or failed compensating cleanup cannot erase this inventory; release handles an uncreated intent idempotently but still rejects changed ref ownership. A candidate is immutable even when later work changes the task directory; episode/version acceptance belongs to the caller. A clean merge is not verification or acceptance.

`refreshGitInputs` is explicit and requires an idle writer. It preserves the previous candidate, merges new parent input, and updates the input basis only on success. Conflict results retain all versions without modifying the parent or throwing away the worker's edits. The caller owns conflict resolution and persistence of the updated ownership record; there is no continuous synchronization daemon.

Capture and apply require coordination with parent file writers. They are not atomic snapshots against arbitrary external edits and do not promise a whole-tree rollback after I/O failure. `discardGitWorkspace` is an explicit disposal operation on recorded ownership only; it does not infer acceptance, delete user branches, or run repository-wide prune/gc. Release can resume after a worktree or some owned refs are already absent; remaining expected refs are not forgotten. Retain policy, native history, environment management and supported-version selection belong to integration; historical migration is not provided.

## Multi-root sequence

```mermaid
sequenceDiagram
    participant Parent
    participant Host as Managed host
    participant Child as One logical subagent
    participant Inputs as Isolated API and client roots
    participant API as API destination
    participant Client as Client destination
    Parent->>Host: create one task with explicit access
    Host->>Inputs: capture and bind both inputs
    Host->>Child: launch one native session
    Child->>Inputs: edit and verify the real inter-root dependency
    Child-->>Host: report; known writers settle
    Host-->>Parent: immutable complete bundle and candidate ID
    Parent->>Host: explicit apply
    Host->>Host: preflight all roots under destination locks
    Host->>API: integrate API result
    Host->>Client: integration conflicts
    Host-->>Parent: API applied, client blocked; truthful partial result
    Parent->>Host: scoped repair and explicit refresh when needed
    Host->>Child: next episode, same session identity
    Child-->>Host: repaired candidate and check evidence
    Host-->>Parent: result for integration and acceptance judgment
```

Execution/report state, per-root application, parent acceptance and resource release remain independent; this sequence is not a distributed transaction or an automatic repair loop.

## Asynchronous boundary

`SessionExecutionSupervisor` owns a session-local submission registry, preparation, shared global/role capacity and explicit resource leases. The existing graph scheduler can use `runTask` for capacity; dependencies, semantic task selection and model routing remain outside this module. No polling, provider loop, automatic retry, apply, repair, or acceptance is introduced.

The receipt follows input preparation, not child completion. The initial tool signal governs preparation only; each accepted run has its own cancellation signal. One-shot hosts can explicitly `join` the same execution. Runner callbacks must honor cancellation and retain their existing bounded process cleanup. Runs are retained in memory with a finite admission bound; persistent request replay, close/reclaim and cross-process recovery are not supplied by this class.

Terminal facts are recorded in the in-memory view before `onEvent`, which may await persistence. `onEvent` receives old-owner cancellation facts too, so it must filter owner/generation before updating a current workflow or UI. Wake delivery is separately fenced and coalesced; successful task completions do not get a duplicate successful-run wake. A delivery failure does not erase the result or imply the model consumed it.

Use `suppressWake` for a real parent abort/provider error, not ordinary `agent_end` or compaction. `replaceOwner` fences the old generation before cancelling its work. An asynchronous host adapter must recheck owner identity immediately before calling Pi's message API, including after its own awaits. Completion can precede the tool-result consumer, so the workflow adapter must preserve dispatch-time basis and reconcile by run identity rather than attach a late result to whichever attempt is current.

## Validation boundary

The three component test files use Node's test runner, controlled promises, and disposable Git repositories, without Pi packages or provider calls. They prove local library behavior and composition, not TUI/RPC re-entry, native history reuse, workflow enrollment/acceptance, package co-load, macOS behavior, or wall-clock economic gains. The integrated runtime has separate full-package, offline host/native-child and workflow tests; see the verification handoff for their actual results. Neither component nor offline host results establish live-provider effectiveness, macOS coverage or wall-clock economic gains.