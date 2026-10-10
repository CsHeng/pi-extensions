# Subagents

`extensions/subagents/index.ts` registers `csheng_subagent_sessions`. The parent delegates bounded business outcomes; Pi owns each native agent loop and session append; the extension owns execution, isolated input, retained state and transport. It does not decide the business plan, accept a candidate, install dependencies, publish changes or turn a successful report into delivery acceptance.

[Managed Subagent Execution](subagent-execution.md) owns the current action, authority, process, persistence, candidate and observation contracts. [Execution Primitives](subagent-execution-primitives.md) owns the Git and supervisor mechanics. [Subagents UI](subagents-ui.md) owns display behavior. Keep those explanations with the implementation rather than copying executable rules into shared architecture or portable Skills.

## One business scope, explicit access

A task selects ranges using `access`: each rule pairs `permission: "read" | "write"` with an absolute path or a nonempty path list in `scope`. Write includes read. Physical identity, containment and supported Git layout are validated; paths and task prose do not themselves grant user authority. A broad selector can only refer to an explicitly available finite enclosing scope, never host-wide discovery or automatic permission expansion.

One logical subagent may write several Git repositories and read other Git or non-Git evidence. Each writable repository has an owned input and isolated worktree; the session freezes one candidate bundle and reports per-root outcomes. A partial path selection remains narrow at native file access, candidate freeze and actual merged application. Read dependencies in the same repository use its prepared input without becoming writable. Unsupported non-Git write delivery is reported as unavailable, not silently converted to read access.

There are no parallel public `repository`, `writePaths` or `externalReadRoots` grant channels. Repository objects remain internal execution units, not mandatory public subagents or business-task partitions. Current-checkout work, an explicit standalone worktree and managed internal workspaces are different methods; choose the method the host supports without inventing an additional user obligation.

## Roles, tools and routing

`explorer`, `reviewer` and `worker` describe purpose and routing defaults. They are not an identity-based privilege hierarchy. An explicitly read-only review remains read-only because of its requested purpose and access, not because every child or reviewer permanently loses otherwise eligible tools. Available configured tools and actual scoped authority determine operations; a real unavailable capability is reported explicitly.

Native host execution is trusted, not an OS sandbox. Native file and typed-Git guards protect their declared path operations; arbitrary shell and third-party tool code remain subject to the task's authority and applicable host controls. The extension does not copy credentials or grant control over another session merely because a tool is present. Delegated implementation can organize its own authorized work; the parent still owns integration and final acceptance of the delegated outcome.

The native `read`, `grep`, `find`, `ls`, `edit`, `write` and `bash` behaviors share prepared input and bounded process ownership. `git_read` provides structured, bounded evidence queries without arbitrary Git arguments or mutation. Models must not interpret incomplete evidence as a complete diff, or availability as permission to change unrelated state.

Routing comes from the task's explicit invocation override or the user's configured role/profile policy. Product defaults are owned by the packaged configuration and its tests, not a second table of provider names here. Explicit model/thinking requests are validated against current host support; the runtime does not silently substitute a provider or persist a task's override into user settings. Tool capability is separate from route choice and from a role's resource budget.

## Scheduling and integration

A create call may submit a flat batch. Use hard predecessor edges only for outputs a successor actually needs, and explicit locks for genuinely shared mutable resources. Reports do not transport candidate files. When a successor needs changed files in its fixed input, the parent explicitly applies the relevant candidate and supplies a fresh input binding before dispatch.

Separate private workspaces can execute concurrently even when their selected paths overlap. Application coordinates actual destinations: shared mutation targets serialize, disjoint destinations need not wait behind one global apply flag. A conflict or interrupted root leaves truthful partial progress; repair stays within the authorized outcome and is verified before acceptance. There is no distributed cross-repository commit or automatic rollback of unrelated changes.

The admission-selected session ID is stable across create, continue, cancel, inspection and retained state. Run and candidate IDs identify their own objects; episode, version, type and relationships are separate data. The model copies outward references unchanged rather than reconstructing implementation IDs or parsing identity prefixes. Native Pi tokens and Git object IDs remain unchanged external values.

## Completion and resource ownership

Admission, execution completion, report completeness, candidate application, parent acceptance and resource release are distinct. A submission receipt is not completed work; a complete report can still describe a defect; an applied candidate can still fail verification. Preserve already integrated roots while repairing a sibling, and do not label partial or unknown progress as complete delivery.

Continuation retains the session's prepared input and native history. Refresh is explicit and requires an idle writer; it is not a side effect of apply. Known writers and subprocesses settle before freezing a candidate or handing off. An interrupted mutation is reconciled against retained evidence before another mutation is attempted.

Close and retention are separate. A closed retained session can later be discarded. Discard releases only owned worktrees, refs and scratch, retaining the audit/native records required by policy and preserving applied parent changes. Missing worktrees do not erase the inventory of remaining refs. Partial cleanup remains visible and retryable; version exclusion, successful tests and a closed label are not authority for global pruning or historical deletion.

## Current-version observation and verification

The current collaboration contract is version 4. Old envelopes and the retired one-shot `csheng_subagents` name are recognized only for shallow exclusion. There are no historical success readers, payload adapters, dual writes or migrations. Existing data is left untouched; installed activation uses fresh contexts and coordinates ownership of any old processes instead of hot-upgrading them.

Observers and evaluators correlate current events using exact session/run/candidate identities. They distinguish admission from actual launch, terminal execution from model text, and complete application from partial root status. Multiple repositories or repeated inspection do not multiply model usage, launches or logical applied-candidate counts. Unsupported, malformed and unavailable evidence are reported separately; missing evidence is not manufactured from current configuration.

Component tests use independent Git repositories and controlled host fixtures. Native offline lanes exercise the actual selected Pi with a synthetic provider and disposable state; their evidence does not establish live-provider effectiveness or unrelated platform behavior. [Test Suite Evidence Lanes](../test-suite-evidence-lanes.md) defines those claims. Installation, user configuration, source commits and publication remain separate operations under matching authority.
