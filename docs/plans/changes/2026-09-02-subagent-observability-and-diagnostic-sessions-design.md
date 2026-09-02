+++
artifact_kind = "design"
design_version = 1
design_depth = "design-full"
approval_status = "approved"
approval_basis = "The user approved the repaired design and its total-root reservation model on 2026-09-02 and explicitly requested implementation."
decision_state = "decided"
truth_impact = "high"
truth_sync_required = true
review_required = true
review_status = "passed_after_revision"
+++
# Subagent observability and diagnostic sessions design

## Objective

Make every launched `csheng_subagents` child diagnosable during execution and after settlement without treating a reopened transcript as resumed mission state or replacing Pi's parent loop. A standard Pi session is technically continuable when a user explicitly opens it; the extension supplies a read-only diagnostic path by default and assigns no scheduler, workspace, convergence, or task-continuation meaning to later manual use.

Each child will write a standard Pi session JSONL under the user agent directory using this hierarchy:

```text
<agent-dir>/subagent-sessions/<parent-session>/<run>/<task>.jsonl
```

The default agent directory makes this normally:

```text
~/.pi/agent/subagent-sessions/<parent-session>/<run>/<task>.jsonl
```

This dedicated root stays outside Pi's default session-discovery tree, so ordinary `/resume` does not list child sessions. A user can inspect a bounded read-only timeline through `/subagents-debug`; direct `pi --session <path>` remains an explicit operator escape hatch that opens an ordinary continuable Pi session rather than an inspection-only viewer. While a child is running, the parent tool must also receive bounded structured activity and periodic heartbeat updates so active, retrying, tool-blocked, settled-but-closing, and inactive children are distinguishable.

## Current truth and observed failure

- `extensions/subagents/runner.ts` launches each child with `--mode json -p --no-session`. Pi documents `--no-session` as ephemeral mode backed by an in-memory `SessionManager`; no session JSONL is persisted.
- Pi JSON mode writes a JSONL event stream to stdout. That stream is a transport, not a saved session file.
- `JsonlProtocolParser` currently ignores every child event except assistant `message_end`. It accumulates final text, usage, stop reason, and error text but exposes them only when `finish()` runs.
- `runChild()` calls `finish()` only after the child process emits `close`. Until then the scheduler retains only `running` and emits no child-internal state.
- The observed incident contained a worker that produced sixteen assistant turns and ended its visible evidence at `toolUse`, while the parent displayed no distinguishing progress for approximately thirteen minutes. Pressing Escape aborted the parent signal, closed the child, completed the tool Promise, and finally rendered `aborted`.
- Existing timeout and cancellation behavior is bounded, but silence until the fifteen-minute task timeout is not adequate operator evidence when child sessions cannot be inspected.
- Stable architecture currently says children are non-session processes and there is no second ledger. Persisted diagnostic sessions deliberately supersede only those two statements; the graph, scheduler, authority, and continuation boundaries remain unchanged.

## Pi contract evidence

Pi 0.84.4 provides the required public behavior:

- `docs/sessions.md` defines `--no-session` as “Ephemeral mode; do not save” and documents `--session <path|id>` plus `--session-dir <dir>`.
- `docs/session-format.md` defines persisted sessions as versioned tree-structured JSONL and documents direct `SessionManager` creation/opening semantics.
- `docs/json.md` defines JSON mode as a live event stream containing agent, turn, message, and tool-execution lifecycle events.
- Pi accepts `--mode json -p --session <explicit-path>`. An explicit path may be outside the default `~/.pi/agent/sessions/` tree.
- Pi has no public “persist but hide from `/resume`” flag. Hiding is achieved through the documented storage/discovery boundary: ordinary `/resume` scans the active/default session directory, not this extension-owned sibling root.

The implementation will rely only on these public CLI and event contracts, not internal Pi imports or a filename-extension trick. The diagnostic timeline reader treats the session file as versioned external input and never opens it through a mutating session-resume path.

## Requirements

### DS-1 — Pi-native postmortem evidence

Every child that reaches process launch must receive an explicit standard `.jsonl` session path and persist normal Pi session entries. Aborted, timed-out, model-error, tool-error, and successful children retain the same diagnostic artifact.

### DS-2 — Hidden from ordinary resume discovery

The extension stores child sessions under `<agent-dir>/subagent-sessions/`, not Pi's default `<agent-dir>/sessions/` tree. Ordinary parent `/resume` therefore remains focused on user sessions.

### DS-3 — Explicit debug access

The parent result retains a bounded relative diagnostic reference. A user-only extension command resolves that reference and renders a bounded read-only metadata timeline without copying prompt or result content into model context. Direct `pi --session <path>` or `pi --session-dir <run-directory> -r` is documented only as an explicit operator choice to open a normal continuable Pi session; it is not the default inspection path and conveys no subagent scheduler or convergence authority.

### DS-4 — Live liveness evidence

The parent receives immediate bounded updates for child spawn, assistant turn completion, tool execution start/end, retry/error observation, `agent_end`, `agent_settled`, and process close. A heartbeat updates elapsed and inactivity age while any task is running.

### DS-5 — Settlement and stall distinction

`agent_settled` means Pi has no automatic retry, compaction, or queued continuation left, but process `close` remains the resource-settlement boundary. If a settled child does not close within a fixed grace period, the runner terminates it and returns `child_exit_stalled` instead of waiting for the full task timeout.

### DS-6 — Privacy and authority

Raw child prompts, tool arguments, tool results, model text, stderr, environment values, and session paths do not enter progress text, evaluator output, probes, or logs. The retained Pi session itself is intentionally sensitive user-owned diagnostic evidence and is stored with private permissions.

### DS-7 — No resumable mission semantics

A diagnostic session records what the child did; it does not preserve scheduler state, resource locks, a worker snapshot, convergence eligibility, or authority to continue the original task. The read-only command never resumes a session. Pi can still open the standard file as an ordinary session when the user explicitly requests it; a worker session may reference a deleted snapshot, and any continued conversation is a new user-owned Pi action outside this extension's task and convergence contract. The parent remains the only owner of retry, repair, continuation, verification, and final response decisions for the active subagent run.

## Ownership and data boundaries

| Owner | Owns | Does not own |
| --- | --- | --- |
| Pi | Session JSONL format and writes, live JSON event semantics, model/tool loop, and process-level settlement | Diagnostic path policy, parent/run/task association, redacted progress projection, or child-exit grace |
| `pi-extensions` | Private diagnostic path creation, explicit child `--session`, event summarization, heartbeat, process-close stall handling, diagnostic references, and user-only lookup | Session-format migration, child replay, semantic retry, verification, or durable graph recovery |
| Parent agent | Task submission, interpretation of status, repair or retry decisions, verification, and continuation | Child process internals or silent inference that a child completed |
| User | Provider cost, cancellation, retained diagnostic data, explicit inspection, and deletion | Automatic semantic completion claims from a partial child transcript |

The session JSONL is a second evidence ledger but not a second execution ledger. The authoritative active run remains the foreground in-memory scheduler; the parent tool result remains the authoritative aggregate outcome.

## Selected architecture

### Diagnostic path and file creation

The extension resolves the root through Pi's public `getAgentDir()` rather than hard-coding `~/.pi/agent`.

Path segments are:

- parent segment: the current `ctx.sessionManager.getSessionId()`, converted to a filesystem-safe deterministic segment if it is not already in the safe identifier alphabet;
- run segment: the extension-generated UUID already stored in run telemetry;
- task filename: the graph-validated safe task ID plus `.jsonl`.

Before spawn, the extension:

1. inspects every existing extension-owned ancestor with `lstat`, rejects symlinks and non-directories, verifies current-user ownership where the platform exposes it, and rejects group/world permission bits rather than trusting a prior `mkdir` mode;
2. creates missing diagnostic-root and parent directories with mode `0700`, then rechecks their type, ownership, and effective permissions;
3. creates the new run directory exclusively with mode `0700` and an extension-owned active marker;
4. creates each task file exclusively with mode `0600` and verifies its effective private mode where supported;
5. passes the exact file through `--session` and omits `--no-session`.

Pi 0.84.4 initializes an existing empty explicit session file with a valid header. Exclusive creation prevents one run from overwriting another session. A diagnostic setup failure returns typed `diagnostic_session_unavailable` before that child starts; the extension does not silently fall back to an unrecorded child.

If process spawn itself fails, the unused empty placeholder is removed. Once a child starts, its diagnostic file is retained even when it remains header-only or ends by abort, timeout, signal, or malformed output.

### Retention and deletion

Diagnostic sessions are sensitive retained evidence with bounded automatic retention. The approved defaults are thirty days, a 512 MiB total-root admission ceiling, 32 MiB per child session, and 256 MiB per run.

Each run directory carries an active marker created under the extension-owned cross-process allocation/cleanup lock before child launch and removed only after aggregate settlement. Every active or stale-active marker reserves the full 256 MiB run allowance. Admission prunes expired settled runs first and then oldest settled runs until `settled bytes + existing active reservations + one new 256 MiB reservation <= 512 MiB`; if that inequality cannot be established safely, the new run fails before launch with `diagnostic_storage_unavailable`. Cleanup after settlement applies the same total-root ceiling to settled bytes plus all remaining reservations. It skips every active or stale-active run and never truncates a Pi session file.

The runner checks each active child file and aggregate run bytes on event or heartbeat boundaries. A child that crosses 32 MiB is terminated and returns `diagnostic_session_limit`; a run that crosses 256 MiB aborts its remaining children with the same typed storage failure. Existing bytes are retained for diagnosis. A first-cause-latched cancellation reason keeps user abort, timeout, diagnostic limit, and exit stall from overwriting one another. Concurrent Pi processes use the allocation/cleanup lock so admission, reservation, active-marker creation, and settled cleanup cannot race through the total-root ceiling.

The extension owns policy enforcement and private cleanup; the user owns explicit inspection and may delete `<agent-dir>/subagent-sessions/` or any inactive parent/run subtree. Package removal does not delete diagnostic sessions. Retention limits are package-owned constants in the first milestone rather than new route-config fields. Configuration belongs to a future design only after real use shows that one policy cannot serve the local operator.

Abrupt process termination may leave an active marker. `/subagents-debug --all` identifies stale active markers but never deletes them automatically; the user may inspect and remove that inactive run explicitly. Each stale marker continues to reserve 256 MiB and can therefore block new admission rather than permit unsafe growth.

### Child launch

The child remains a single-shot process:

```text
--mode json -p --session <diagnostic-session-path>
--no-extensions -e <capability-guard>
--no-skills --no-prompt-templates
--tools <role-tools>
--model <route> --thinking <level>
--approve --append-system-prompt <private-role-file> -- @<private-task-file>
```

Only `--no-session` is removed. Extension, Skill, tool, model, project-trust, capability, prompt, timeout, and foreground behavior remain unchanged.

The persisted session contains Pi's normal expanded conversation and tool results. The separate private role/task/capability files and worker workspace remain temporary and are still removed on every normal, failed, timed-out, or aborted settlement path.

### Structured child activity

The JSONL parser gains a bounded event projection. It never copies event payloads; it records only:

- lifecycle phase: `starting`, `running`, `retrying`, `settling`, `settled-awaiting-exit`, or `closed`;
- cumulative assistant turn count;
- active tool names from the fixed child allowlist;
- latest lifecycle event type;
- latest assistant stop reason;
- whether an error stop was observed;
- whether `agent_end` and `agent_settled` were observed;
- monotonic last-activity and elapsed durations.

Every accepted JSON line refreshes liveness even when its payload is not otherwise summarized. Malformed lines increment the existing bounded malformed count without exposing content.

Runner activity flows through an explicit callback into scheduler-owned running task state. The scheduler emits the complete bounded task snapshot through the existing tool `onUpdate` seam. No child event mutates graph topology, locks, route choice, convergence, or final status.

### Heartbeat and inactivity rendering

One run-scoped timer emits progress every five seconds while at least one task is running. It updates elapsed and `inactiveForMs` from an injected monotonic clock. It does not create work, poll a provider, inspect session files, or outlive the foreground tool call.

Progress rendering shows, per running child:

```text
[task] worker running elapsed=… turns=… tool=… inactive=…
```

A retry/error observation and `settled-awaiting-exit` replace the ordinary phase label when applicable. Tool arguments, output, prompt content, raw errors, routes not already shown by current rendering, and absolute diagnostic paths remain absent.

The timer is cleared on success, failure, timeout, abort, thrown error, and session shutdown. Host `tool_execution_update` remains the Pi-owned TUI rerender trigger.

### Settled child that does not exit

On `agent_settled`, the parent immediately receives `settled-awaiting-exit`. The runner starts a ten-second exit grace independent of the fifteen-minute task deadline.

If `close` arrives within the grace, existing final classification applies. If it does not:

1. mark the process as exit-stalled;
2. send `SIGTERM`;
3. reuse the existing five-second TERM-to-KILL escalation;
4. await `close` and return failed status with `child_exit_stalled`;
5. preserve the diagnostic session.

`agent_end` alone does not trigger termination because Pi may still retry, compact, or process queued continuation. `agent_settled` is the authoritative no-more-automatic-work event.

A child that never emits `agent_settled` remains governed by activity updates and the existing fifteen-minute timeout. Inactivity is evidence, not an automatic failure, because a provider or tool call may legitimately be quiet.

### Diagnostic references and user-only lookup

Each launched task result gains a relative `diagnosticSessionRef` rooted at `subagent-sessions/`. Final model-visible content does not include the path. Runtime telemetry schema version two remains unchanged because routing, admission, concurrency, and duration meanings do not change.

A `/subagents-debug [reference|--all]` command provides user-only lookup:

- without an argument, show the latest bounded run directories for the current parent session;
- with `parent-session/run` or `parent-session/run/task`, resolve exactly one retained scope after strict safe-segment validation;
- with `--all`, show a bounded newest-first list across parent directories, including stale active-marker evidence, so sessions from an ephemeral or crashed parent remain discoverable;
- for an exact task, stream the selected file read-only and render at most 200 metadata entries, 1 MiB per input line, 64 KiB total rendered bytes, and 20 discovered scopes; include only timestamps, message roles, assistant stop reasons, tool names, tool-result error flags, and transcript/tool-result completeness;
- never infer `agent_end`, `agent_settled`, or process-close outcome from session entries; those remain parent-result evidence;
- never render prompts, thinking, assistant text, tool arguments, tool-result content, stderr, model selectors, credentials, or external file content;
- never call `SessionManager.open`, rewrite or migrate a file, delete evidence, or start/resume an agent.

The command reports the exact local path only in its user-facing UI response. It warns that an explicit later `pi --session <path>` opens a normal continuable Pi session and that a worker's original snapshot no longer exists. The command's bounded global discovery removes dependence on the current parent session or persisted parent tool details and needs no durable index.

The parent session's structured tool details preserve relative references when available. The evaluator continues to ignore diagnostic paths and raw child evidence. Tests explicitly prove that its metric schema output remains redacted.

## Failure behavior

| Failure | Result |
| --- | --- |
| Diagnostic root/run/file cannot be created privately | Typed pre-launch `diagnostic_session_unavailable`; no unrecorded child fallback |
| Retention cleanup, lock, or safe capacity is unavailable | Typed pre-launch `diagnostic_storage_unavailable`; preserve existing evidence and do not launch |
| Child or aggregate run exceeds its diagnostic byte ceiling | Terminate affected work with `diagnostic_session_limit`; preserve existing valid bytes |
| Child spawn fails | Existing `spawn_failure`; remove unused empty placeholder |
| Pi session initialization or write fails after spawn | Child/process failure evidence; preserve any file bytes for diagnosis |
| Child emits error but Pi may retry | Show bounded `retrying` or error-observed progress; do not settle early |
| Child emits `agent_settled` but does not close in ten seconds | TERM/KILL and `child_exit_stalled` |
| Child remains active or quiet without settlement | Heartbeat plus inactivity age until completion, abort, or fifteen-minute timeout |
| Parent Escape or shutdown | Abort child, await close and workspace cleanup, preserve diagnostic session, return existing aborted aggregate |
| Parent crashes abruptly | Pi session bytes already flushed remain; `--all` can rediscover the run and reports its stale active marker; normal in-memory aggregate and temporary workspace recovery remain unavailable |

No failure permits path widening, unrecorded fallback, automatic model retry, session replay, or treating child prose as successful completion.

## Alternatives

### Keep `--no-session` and tee stdout into a file

Rejected as the primary artifact. The stdout stream is useful transport evidence but is not Pi's resumable/session-format JSONL and duplicates content without gaining standard session tooling. Live event projection still consumes stdout, but only Pi's native session is retained.

### Remove `--no-session` and use Pi's default session directory

Rejected because read-only child sessions would pollute the parent project's ordinary `/resume`, while worker sessions would be grouped under disposable snapshot paths. The dedicated explicit path is more predictable.

### Hide sessions by using a non-`.jsonl` filename

Rejected because it relies on current picker suffix filtering rather than a documented storage boundary and makes the artifact misleading. Dedicated storage preserves a normal `.jsonl` session.

### Persist only failed or aborted children

Rejected because the decision arrives after execution, would require copying or replaying session state, and would lose the evidence needed to compare a healthy child with a failed one.

### Retain worker snapshots for resume

Rejected. Snapshots can contain broad repository state, materially increase retention risk, and would turn evidence storage into resumable execution state. Worker workspaces continue to be deleted.

### Retain sessions indefinitely without a storage ceiling

Rejected after review. A task timeout does not bound aggregate durable bytes across repeated runs. Fixed age, settled-root, child, and run ceilings plus active-run exclusion contain disk use without silently truncating a valid Pi session.

### Treat assistant error or `agent_end` as final

Rejected. Pi may retry or compact after a low-level agent end. Only `agent_settled` proves no automatic continuation remains, and process `close` still owns OS-resource settlement.

### Add interactive attach or switch into a live child

Deferred. Children are single-shot print-mode processes with ignored stdin and no supported TUI attachment channel. Live bounded event projection solves the observed diagnosability requirement without introducing an RPC controller, terminal multiplexer, or second agent lifecycle.

## Scope

In scope:

- Pi-native persisted child session JSONL under the accepted hierarchy;
- secure path/file creation, ownership/mode validation, explicit `--session` launch, active markers, and allocation locking;
- fixed age and byte retention, oldest-settled cleanup, and active-file/run byte ceilings;
- relative diagnostic references, bounded cross-parent discovery, and user-only read-only timeline lookup;
- bounded JSON event activity projection;
- five-second foreground heartbeat and inactivity rendering;
- ten-second settled-exit grace plus typed stall failure;
- preservation of diagnostic sessions across every launched-child outcome;
- deterministic fake-Pi, protocol, scheduler, extension, rendering, redaction, and filesystem tests;
- stable truth updates for the new evidence and liveness boundaries.

Out of scope:

- durable graph, mission, locks, workspace, retry, review, repair, or continuation state;
- resuming a worker against its deleted snapshot;
- background children or an attachable interactive child TUI;
- raw stdout event-log retention in addition to the Pi session;
- user-configurable retention or deletion of active diagnostics;
- reading child session content into the parent model automatically;
- changing roles, tools, routing, concurrency, snapshots, convergence, telemetry schema, evaluator metric schema, or provider behavior;
- Pi core changes, global settings changes, provider calls during deterministic verification, installation, commit, push, publication, or deployment.

## Oracle strategy and acceptance evidence

Use contract examples, disposable private-directory tests, fragmented JSON event fixtures, controlled child processes, injected clocks, fake extension contexts, host update seams, and stable redaction checks.

Acceptance requires:

- launched children omit `--no-session` and receive one exact `--session` path under the current parent/run/task hierarchy;
- new and existing root, parent, and run directories pass type, owner, and effective-private-mode checks; files are mode `0600`; paths cannot traverse or follow an attacker-provided symlink; and collisions do not overwrite;
- ordinary Pi default session listing does not discover the dedicated sessions, while a separately isolated Pi session-format oracle recognizes the produced file shape without making the runtime inspector mutating;
- thirty-day and 512 MiB total-root admission cleanup removes oldest inactive runs only, every active or stale-active marker reserves 256 MiB under the cross-process lock, stale reservations block unsafe admission, and 32 MiB child plus 256 MiB run ceilings terminate growth without truncation;
- success, failure, abort, timeout, storage-limit, and settled-exit-stall fixtures retain diagnostic sessions; spawn failure removes only its unused empty placeholder;
- protocol fixtures summarize lifecycle and tool activity without copying arguments, content, error text, paths, or environment values;
- at least one update reaches the parent before child process close, and a five-second heartbeat advances elapsed/inactivity evidence without provider activity;
- `agent_end` does not settle or terminate a child, while `agent_settled` starts the ten-second exit grace;
- a settled but non-closing child is terminated and returns `child_exit_stalled` before the fifteen-minute timeout;
- Escape and session shutdown still await process/workspace cleanup while preserving the child session;
- `/subagents-debug` performs bounded current-parent and cross-parent discovery, rejects unsafe input, reads exact sessions without mutation, and exposes only the approved metadata timeline plus a user-only local path;
- an ephemeral-parent or abrupt-crash fixture remains discoverable through `--all` without parent tool details;
- evaluator, model-visible tool content, progress text, and probes remain free of diagnostic paths and raw child content;
- `npm run check`, required offline plan-mode/subagent probes, and `git diff --check` pass without a model call.

A live provider run is optional follow-up evidence and requires separate authority. If later authorized, one child should demonstrate a persisted session plus at least one live progress update before final close; no retry or route mutation is permitted.

## Truth impact

Verified implementation must update:

- `AGENTS.md`: replace the blanket memory-only/no-durable-run wording with a precise allowance for user-owned diagnostic session evidence while continuing to prohibit durable orchestration or resume state;
- `README.md`: document the default diagnostic root, ordinary `/resume` exclusion, `/subagents-debug`, direct inspection, and diagnostic-only worker limitation;
- `docs/architecture/subagents.md`: replace “non-session child” and “no second ledger” with the selected evidence boundary, live activity contract, settlement grace, retention and stale-marker ownership, privacy, read-only inspection, explicit ordinary-session escape hatch, and removal behavior.

The runtime telemetry and evaluator schema stay at version two. Historical designs and plans remain unchanged; this artifact supersedes only their non-session/no-second-ledger decisions for current stable truth.

## Recovery and removal

Implementation recovery is fix forward. Preserve the smallest synthetic event stream, fake process mode, private-directory fixture, or parent progress snapshot and repair only its owner. Never disable session persistence, drop status updates, widen filesystem permissions, expose raw child content, or treat `agent_end` as settled to make tests pass.

If Pi no longer accepts an explicit session path in JSON print mode, cannot initialize an existing private empty file, or omits `agent_settled` from the JSON stream, stop with `needs_design_decision`; do not import Pi internals or silently degrade to an unrecorded child.

Removing the extension stops new diagnostics, retention enforcement, and liveness updates but does not delete existing user-owned sessions. The user may remove the whole `subagent-sessions` root or an inactive parent/run subtree explicitly. No package uninstall or reload performs destructive cleanup.

## Review decision

A bounded independent design review was required because this change creates a durable sensitive-data boundary, changes subprocess settlement, and supersedes stable non-session architecture. The reviewer found four material candidates: direct `pi --session` was incorrectly described as inspection-only; ephemeral/crashed parent evidence lacked cross-parent discovery; indefinite retention did not contain disk exhaustion; and pre-existing diagnostic ancestors lacked owner/mode checks.

All four findings were accepted and repaired in one focused artifact edit. The selected default path became a non-mutating `/subagents-debug` metadata timeline, direct Pi session opening became an explicit continuable operator escape hatch outside subagent task semantics, bounded `--all` discovery covered ephemeral and crashed parents, and existing ancestors gained type, owner, and effective-private-mode validation.

The subsequent plan review reopened the design because a 512 MiB settled-only budget plus unreserved 256 MiB active runs did not create a global bound across concurrent Pi processes. It also showed that lifecycle completeness cannot be reconstructed from Pi's message/session JSONL alone. The design now limits the inspector to transcript/tool-result completeness, preserves process outcome only in parent result details, uses first-cause-latched cancellation, and adds no event sidecar.

The user approved the total-root reservation repair: every active or stale-active run reserves its full 256 MiB under the cross-process allocation lock, and admission fails unless settled bytes plus existing reservations plus the new reservation fit beneath the 512 MiB ceiling. The review candidates are therefore resolved and `review_status = passed_after_revision`.

## Approval

`approval_status = approved` and `decision_state = decided`. The user explicitly approved this repaired artifact and requested repository-local implementation on 2026-09-02. Provider calls, installation, mutation of real diagnostic data or global settings, commit, push, publication, and deployment remain unauthorized.
