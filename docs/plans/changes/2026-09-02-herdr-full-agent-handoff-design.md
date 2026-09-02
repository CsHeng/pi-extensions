```toml
artifact_kind = "design"
design_version = 1
design_depth = "design-full"
approval_status = "ready_for_approval"
approval_basis = "The user selected pi-extensions as the sole repository owner for the Herdr handoff design and plan and authorized both artifacts on 2026-09-02. Implementation remains unauthorized until the artifacts are approved."
decision_state = "ready_for_approval"
truth_impact = "high"
truth_sync_required = true
review_required = true
review_status = "passed_after_repair"
```

# Herdr Full-Agent Handoff Extension Design

## Objective

Add an independently removable `herdr-handoff` Pi extension that lets the active Pi remain the canonical-plan and convergence owner while handing one bounded implementation package to a persistent vendor-native coding agent managed by Herdr. The default mode is a delegated handoff with return: Pi freezes and sends the plan, waits without polling, receives bounded return evidence, then resumes to inspect the actual workspace, verify behavior, adjudicate review findings, authorize any bounded repair, synchronize truth, and close the change.

The extension also supports an explicit one-way transfer mode. Transfer waits only until Herdr confirms prompt delivery and observes the recipient transition to `working`, returns a durable Herdr target and workspace handle, and makes no semantic-acceptance or completion claim. It is not a background workflow owned by Pi.

This design keeps four mechanisms separate:

- semantic Skills decide whether implementation is approved and what Pi must still judge;
- Pi owns the active parent loop, plan, user interaction, verification, review adjudication, repair decisions, and final response;
- `herdr-handoff` owns a narrow request/wait/read bridge and bounded handoff-session mechanics;
- Herdr owns persistent terminal topology, agent detection, lifecycle state, and agent messaging.

`csheng_subagents` remains the tool for temporary fixed-role Pi children with mechanical path capabilities and isolated convergence. A Herdr recipient is instead a full external coding agent with its native harness and permissions. The Herdr extension is not a `csheng_subagents` runner and shares no scheduler, child role, route, or workspace-convergence implementation with it.

## Current truth and observed demand

The package currently exposes `plan-mode`, `multi-skill-mentions`, and `subagents`. It has no Herdr dependency, no full-agent handoff tool, no persistent external-agent handle, and no cross-harness return protocol.

The local environment currently has Herdr 0.8.2 and managed integrations for Pi, Codex, and Grok. Herdr exposes stable CLI commands with JSON envelopes for agent discovery, startup, prompting, blocking waits, lifecycle state, terminal topology, worktrees, and notifications, while `agent read` returns bounded raw text on stdout. `herdr agent prompt <target> <text> --wait --timeout <ms>` already supplies the required non-polling wait primitive. Herdr reports `idle`, `working`, `blocked`, `done`, and `unknown`; `idle` or `done` means only that the harness settled, not that implementation is correct.

The managed integration hooks report agent session and lifecycle state to Herdr. They neither route work nor carry a complete implementation result. Pi's integration reports `working`, `blocked`, and `idle` from host events. Codex and Grok integrations report native session identity while Herdr also uses screen detection. Those files are Herdr-owned installed state and are outside this repository.

The former `implement-change-via-herdr` Skill mixed semantic workflow guidance with one provider-specific execution bridge. It has been retired from the Skill repository. The remaining official `herdr` Skill is optional manual CLI guidance and is not an extension dependency.

The proven demand is one ownership handoff, not more child parallelism:

- Pi should stop spending turns and context on an implementation another full harness can own temporarily;
- the user should not have to poll panes or copy responses back into Pi;
- an external agent should receive one immutable correlated plan with explicit write and authority boundaries;
- Pi should resume automatically when Herdr reports settlement;
- blocked, timeout, cancellation, malformed return, and scope-expansion cases must return typed evidence rather than silently widening authority;
- one-way transfer must remain distinguishable from delegated work that Pi later verifies and closes.

Grok authentication is currently unavailable, so no live Grok canary is design evidence. Deterministic implementation does not depend on provider credentials.

## Domain terms

Use these terms consistently in the public contract and stable documentation:

- **handoff request**: the versioned, correlated objective, canonical plan, allowed writes, non-goals, verification expectations, and fixed authority boundary sent to a recipient;
- **delegate-return**: Pi retains outcome ownership, waits for the recipient to settle, and resumes with untrusted implementation evidence;
- **transfer**: Pi relinquishes outcome ownership after confirmed prompt delivery and an observed `working` transition, without claiming semantic acceptance, and returns only a live Herdr/workspace handle;
- **message-existing**: send to one already-running, explicitly named Herdr agent after identity, state, and checkout validation;
- **start-and-ask**: select one exact user-owned launch profile, create approved Herdr topology, start the agent, and then send the handoff;
- **handoff handle**: an extension-session opaque token plus bounded public Herdr/workspace coordinates used for a delegated continuation;
- **recipient return**: the recipient's versioned result envelope; it is a claim, not verification;
- **workspace postflight**: mechanical Git evidence about repository mutations observed after a delegate-return wait; it cannot prove that the recipient caused every change or that behavior is correct.

Do not call recipient settlement, `idle`, `done`, a return envelope, or a clean postflight “completion.” Only the active Pi may claim completion after repository inspection and verification.

## Constraints

- The extension operates only when `HERDR_ENV=1`, caller pane context is present, and a compatible `herdr` executable is available. There is no fallback to direct harness execution, `csheng_subagents`, another pane manager, or a default agent.
- The installed Herdr CLI is the integration authority. The extension invokes commands as argv through `pi.exec`; it does not import Herdr internals, speak the socket protocol directly, parse the Herdr config file, or modify managed integration hooks. Herdr 0.8.2 exposes prompt text only as a CLI argument, so every handoff input is explicitly local-process-visible and must contain no secret; code-owned errors never echo command values.
- Every first-release recipient works in a distinct linked worktree of the same Git repository. Shared-checkout handoff is excluded because timeout, blocking, failed cancellation, shutdown, or extension reload can return Pi control while the recipient remains a live writer.
- Only one handoff operation may be active in a Pi extension session. The first release has no batch, DAG, autonomous retry, background poller, or durable workflow ledger.
- A recipient is a full native coding agent. Prompt instructions and Git postflight are cooperative and detective controls, not a capability sandbox. The extension cannot prevent arbitrary shell, network, ignored-file, sibling-repository, credential, or external-system actions available to that harness.
- Because capability isolation is not supplied, Herdr handoff is explicit-user-only. The model-facing tool guidance must not select Herdr opportunistically and must never silently substitute it for bounded subagents.
- The handoff grants repository-local create-or-modify authority only for exact declared files. Commit, staging, branch rewrite, push, publication, deployment, credential changes, authentication, package installation, external mutation, deletion, rename, and scope expansion remain excluded.
- The extension never answers an approval or question UI, grants new authority, edits a plan, adjudicates findings, applies an isolated-worktree diff, commits, or closes a change.
- Provider authentication, native model availability, and permission policy remain owned by the selected external harness and the user. Startup failure or an authentication screen is visible and has no fallback.
- Plan mode remains independent and continues to expose only its exact read-only tool set, so the handoff tool is inactive while that profile is selected.

## Ownership and authority

| Owner | Owns | Does not own |
| --- | --- | --- |
| User | Explicit Herdr use, recipient harness/profile choice, provider cost, permission posture encoded in a launch profile, new authority, cancellation intent, and one-way ownership transfer | Mechanical result parsing, Git postflight, Pi verification, or hidden fallback |
| Skills and active Pi | Approved implementation scope, canonical plan, exact allowed writes, answers derivable without new authority, verification, finding adjudication, one bounded repair decision, truth sync, closure, and final claims | Herdr terminal topology, native agent detection, provider authentication, or persistent agent sessions |
| `herdr-handoff` | Request and return schemas, launch-profile loading, Herdr CLI adaptation, target/workspace validation, one blocking wait, result parsing, bounded continuation counters, cancellation request, postflight evidence, redacted rendering, and extension-session handles | Semantic eligibility, plan approval, correctness judgment, automatic approval answers, automatic repair, automatic convergence, or final completion |
| Herdr | Workspace/tab/pane topology, native agent startup, live target resolution, prompt delivery, lifecycle observation, terminal reads, and persistent target handles | Plan semantics, implementation correctness, repository scope judgment, result schema meaning, or Pi closure |
| Recipient harness | Native agent loop, its configured model and tools, implementation actions inside the selected checkout, native approval UI, and returned claims | Widening the handoff, modifying Pi state, judging its own completion as verified, or transferring authority onward |

The extension cannot prove that a model-facing `profile` selection originated from explicit user intent. As with explicit model routing in `subagents`, the parent guidance and tool description own that semantic projection; runtime records the exact profile selection and never replaces it.

## Architecture decision

### Selected option: a foreground synchronous adapter with optional ownership transfer

Implement one `herdr_handoff` model-callable tool as an adapter around Herdr's CLI. In `delegate-return`, a single tool execution performs `resolve or start -> prompt --wait -> get -> read once -> parse -> workspace postflight -> return`. In `transfer`, it performs `resolve or start -> prompt --wait --until working -> get -> return handle` and then relinquishes outcome ownership.

This is the smallest sufficient boundary. The constrained resources are user attention, Pi context, and manual cross-pane coordination. Herdr already supplies persistent sessions, lifecycle detection, and a blocking wait, while Pi already supplies the semantic loop. A new daemon, queue, event bus, persistent ledger, or workflow controller would duplicate those owners and add recovery state without improving the one-handoff use case.

The adapter pattern is material rather than pass-through because it translates and enforces a Pi-owned request/return contract, explicit target and workspace policy, launch-profile selection, bounded continuations, typed failure semantics, cancellation behavior, postflight evidence, and redaction around a volatile external CLI.

Lifecycle cost belongs to `pi-extensions`: maintain Herdr 0.8.2-or-later CLI conformance fixtures, typed command adapters, fake-Herdr tests, and stable handoff semantics. Herdr retains the lower-level compatibility burden for native harnesses. The user owns configured launch arguments and provider availability.

### Decision horizon and upgrade triggers

The first release serves one active handoff and at most one clarification plus one repair continuation. Add durable handles only if observed Pi reloads or crashes repeatedly prevent recovery and Herdr coordinates alone cannot re-establish identity safely. Add automatic isolated-worktree convergence only if repeated accepted handoffs show that parent-owned manual convergence is the dominant failure or latency source and an exact conflict/rollback contract is separately designed. Add multiple concurrent handoffs only if demand cannot be satisfied by `csheng_subagents` and independent full-agent workspace ownership can be proven mechanically.

## Public tool contract

Register one tool named `herdr_handoff` with an action-discriminated schema.

### `begin`

`begin` starts a new handoff:

```text
action: begin
mode: delegate-return | transfer
target: message-existing | start-and-ask specification
request: bounded handoff request
waitTimeoutMs: optional bounded observation deadline
```

A `message-existing` target contains one exact live agent name or pane ID and the expected Herdr agent kind. The extension resolves it with `herdr agent get`, rejects the caller pane, verifies the detected kind, requires an identified interactive agent in `idle` or `done`, and checks repository/workspace ownership before sending anything. It does not infer a target from focus, pane order, agent kind, or current Herdr selection.

A `start-and-ask` target contains one exact launch profile ID. The extension creates a non-focused linked worktree/workspace from the validated parent `HEAD`, generates a unique Herdr-safe agent name from the handoff ID, starts exactly that profile in the returned root pane, and fails visibly if startup does not become ready. It never tries another profile or kind. A `message-existing` target must already occupy a distinct linked worktree of the same repository.

### `continue`

`continue` sends one parent-owned continuation to a live `delegate-return` handle:

```text
action: continue
handle: opaque extension-session token
intent: clarification | repair
message: bounded answer or accepted repair brief
waitTimeoutMs: optional bounded observation deadline
```

A clarification may answer only from the frozen plan or observed repository facts without granting new scope or authority. A repair may contain only parent-adjudicated findings inside the original exact write set. The extension enforces at most one clarification and one repair continuation per handoff. It does not generate either message.

Before continuing, the extension resolves the same pane, agent kind, agent-session fingerprint, and checkout. Occupant replacement, moved checkout, unknown identity, transferred ownership, an exhausted budget, or an active operation returns a typed failure.

### `wait`

`wait` performs one additional blocking recovery wait after an observation timeout or blocked return without sending another prompt:

```text
action: wait
handle: opaque extension-session token
waitTimeoutMs: bounded observation deadline
```

Only one recovery wait is allowed. The extension first revalidates the target/session/worktree fingerprint, invokes one `herdr agent wait`, then performs the normal single read, return parse, and workspace postflight after settlement. It is not a periodic status loop. A blocked recipient must be resolved manually through Herdr before this action; the extension never answers the UI.

### `cancel`

`cancel` makes one best-effort interruption request for a live `delegate-return` handle:

```text
action: cancel
handle: opaque extension-session token
```

It revalidates the complete pane, agent-kind, native-session, and worktree fingerprint immediately before sending logical `ctrl+c`; a mismatch returns `stale_handle` without writing input. It performs one short blocking settlement wait and, after confirmed settlement, the normal workspace postflight before returning `cancelled`. An unconfirmed interrupt returns `cancel_unconfirmed`, preserves an unresolved owned handle, and blocks a new `begin` in that extension session until manual recovery. It never closes a pane, kills an agent process, removes a worktree, resets Git state, or acts on a transferred handoff.

## Handoff request envelope

The caller supplies:

- one bounded objective;
- a canonical plan as either inline text or one repository-relative regular file;
- exact repository-relative `allowedWrites`;
- explicit non-goals;
- verification expectations as text, not extension-executed commands;
- optional bounded context facts.

For a plan file, the extension resolves the path physically inside the parent Git root, rejects symlink or traversal escape, reads it once, and hashes the exact bytes. For inline text, it hashes the exact UTF-8 bytes. Every `allowedWrites` entry is separately normalized relative to the selected worktree, checked through its existing path or nearest existing ancestor, and rejected when an existing component is a symlink or special file, physical containment escapes, the exact target is a directory, or the target's real parent directory does not already exist. For inline or file plans, the extension sends the complete bounded plan and returns only `planSha256`, never a mutable path-only reference. The recipient therefore sees the same plan even in a separate worktree.

The generated `pi-herdr-handoff/v1` envelope adds fixed authority statements:

- create or modify only `allowedWrites`;
- do not delete, rename, stage, commit, push, install, publish, deploy, authenticate, change credentials, modify another checkout, or act on an external system;
- do not redesign or widen scope;
- stop with `needs_authority` when the plan is insufficient;
- run requested verification where possible, but report evidence as a claim;
- emit exactly one bounded `pi-herdr-return/v1` object at the end of the final response.

Input ceilings are code-owned and directly tested: 64 KiB canonical plan, 8 KiB objective, 32 exact write paths, 32 non-goals, 32 verification entries, 32 context entries, 128 KiB complete generated prompt, and a 30-minute maximum wait. User configuration may lower launch startup timeout but cannot increase hard ceilings. Because the documented Herdr CLI takes prompt text as an argv value, all objective, plan, path, non-goal, verification, and context content is process-visible to same-user local process inspection; the request schema and guidance prohibit credentials, tokens, private keys, or other secrets.

## Recipient return envelope

The final response must end with unique start and end sentinels surrounding one pretty-printed JSON object whose physical lines stay below 96 columns so native terminal rendering does not split a JSON string:

```text
protocol: pi-herdr-return/v1
handoff_id: exact correlation ID
outcome: implemented | no_changes | blocked | needs_authority | failed
summary: bounded text
changed_paths: bounded repository-relative paths
verification: bounded records of check, passed | failed | not_run, and evidence
questions: bounded strings
risks: bounded strings
```

The extension reads `recent-unwrapped` once after settlement, caps the returned bytes and lines, and selects exactly one structurally valid envelope for the current handoff ID from the final complete sentinel pair. Prompt-echo delimiters and older envelopes with different handoff IDs are ignored; a duplicate current envelope, a trailing malformed pair, missing or truncated delimiters, oversized or malformed content, or an unmatched handoff ID fails closed with the live handle and no raw transcript in the persisted tool result.

The structured result separates three evidence classes:

- `bridgeStatus`: `returned`, `transferred`, `blocked`, `timed_out`, `cancelled`, or `failed`;
- optional `agentOutcome`: the recipient's untrusted envelope outcome;
- `workspaceStatus`: `within_declared_writes`, `scope_violation`, `history_changed`, `not_inspected`, or `unavailable`.

No combination is represented as `verified` or `completed`. An `implemented` outcome with `within_declared_writes` is rendered as “implementation claimed; parent verification required.” An `idle` or `done` lifecycle state without a valid envelope is `malformed_return`, not success.

Result details include a schema version, handoff ID, mode, action, plan hash, bounded handle, recipient kind and name, opaque Herdr pane/workspace/tab IDs, checkout kind and path, lifecycle state and sequence, continuation counters, parsed return envelope, postflight changed paths and violations, duration, and typed error. They exclude launch argv, raw profile content, Herdr config, native session ID/path, complete terminal text, prompt text, credentials, and environment values.

## Launch profiles and exact recipient selection

`start-and-ask` reads an optional strict user-owned `herdr-handoff.json` under Pi's public agent directory returned by `getAgentDir()`. Project repositories and the package do not provide launch profiles. The extension never creates, edits, deletes, or normalizes the user file.

Version one maps a profile ID to:

```text
kind: one Herdr agent kind
args: bounded native argv passed after herdr agent start --
startupTimeoutMs: optional 3,001..300,000
```

Profile IDs and agent kinds use bounded Herdr-compatible identifiers. Native argv is treated as opaque user-owned policy, limited by count, item bytes, total bytes, and NUL rejection. It may choose a native model or permission posture, but must not contain secrets because process arguments and Herdr startup responses can expose argv. Authentication remains ambient in the native harness.

The tool accepts only an exact profile ID. Missing configuration, malformed configuration, unknown profile, unsupported kind, startup timeout, blocked authentication, or startup identity mismatch fails without fallback. The client parses and immediately discards the `argv` returned by Herdr's `agent_started` response; renderers and errors never include it.

`message-existing` requires no profile. It can verify Herdr's detected harness kind and native session continuity, but it cannot prove the recipient's concrete model or permission settings. The result marks route details `externally_configured_unverified`; callers requiring an exact launch route must use a reviewed `start-and-ask` profile.

## Workspace authority and isolation

### Distinct linked worktree invariant

Every first-release recipient must occupy a distinct linked worktree of the trusted parent Git repository. The parent checkout is never the recipient cwd. This invariant contains repository mutations when timeout, blocking, cancellation failure, shutdown, transfer, or extension reload returns control while a recipient may still be working. It does not sandbox the full agent from external paths, network actions, ignored files, or harness-owned state.

A managed `start-and-ask` requires a clean parent checkout and a valid `HEAD`. The extension asks Herdr to create a non-focused linked worktree/workspace from that exact base, verifies the returned common-repository identity and checkout path, and starts the recipient in its root pane. A `message-existing` target must already occupy a different linked worktree of the same repository; the parent checkout and an unrelated repository are rejected.

Transfer requires the selected recipient worktree to be clean at admission. Delegate-return may begin in an existing dirty recipient worktree only after capturing its complete baseline; this supports an intentional continuation while preserving attribution. A managed start is clean by construction.

### Baseline and postflight

Before every delegate-return prompt or continuation, the extension captures in the recipient worktree:

- Git common-repository and worktree identity;
- current `HEAD` identity, including an explicit unborn state where applicable;
- index-state digest;
- porcelain-v2 status with all non-ignored untracked paths;
- type, mode, and content digest for every pre-existing dirty path and every allowed write path.

After settlement, blocked return, or confirmed cancellation, it captures the same evidence. New or changed regular-file create/modify operations are accepted mechanically only inside `allowedWrites`. Deletion, rename, symlink, mode change, index change, `HEAD` change, a changed pre-existing dirty path outside the write set, or any new non-ignored changed path outside the write set returns a typed violation. Existing unrelated dirty paths may remain only if their captured state is byte-identical. Recipient-declared `changed_paths` is compared with observed deltas but never trusted.

This is detective evidence rather than a capability boundary. Concurrent edits within the recipient worktree are indistinguishable and fail closed. Ignored files, external paths, network effects, and harness-owned state remain outside postflight observability. Users requiring hard write capabilities should use `csheng_subagents`, not a full-agent handoff.

The isolated checkout receives the canonical plan in the prompt rather than relying on an uncommitted plan file. Recipient writes never converge automatically into the parent checkout. Delegate-return gives Pi the checkout path and postflight evidence so the active Pi can inspect and later apply an accepted diff under normal implementation authority. Transfer leaves the worktree and Herdr workspace with the recipient and user and states that Pi no longer owns completion, cancellation, continuation, convergence, or closure.

The first release does not automatically close tabs, stop agents, delete worktrees, delete branches, reset files, or prune Git metadata. Those actions can destroy evidence and require a separate explicit cleanup request through manual Herdr/Git control. Extension removal likewise leaves existing Herdr topology untouched.

## Non-polling lifecycle protocol

A delegate-return operation performs a bounded fixed sequence:

1. validate `HERDR_ENV`, CLI compatibility, trusted Git project, request, target, profile, workspace, and baseline;
2. resolve the existing agent or create non-focused topology and start exactly one profile;
3. call `herdr agent prompt <target> <envelope> --wait --timeout <ms>` once;
4. on settled `idle`, `done`, or `blocked`, call `agent get` once and `agent read --source recent-unwrapped` once;
5. parse return evidence and run one Git postflight;
6. return control to Pi.

A transfer substitutes `--until working` and returns immediately after confirmed prompt delivery plus the observed transition, without claiming semantic acceptance. A single recovery continuation from either `blocked` or `timed_out` uses one `agent wait`, followed on settlement by one get/read/parse/postflight sequence. No code path uses periodic `agent get`, sleep/retry loops, pane-output polling, filesystem polling, or lifecycle hooks as a result channel.

Herdr's five-second `agent_prompt_stalled` behavior remains authoritative. The extension does not compensate by resending the prompt because duplicate delivery would be unsafe.

## Bounded clarification and repair

The extension stores only bounded in-memory handle state for the current Pi session: target identity fingerprint, workspace identity, request hash and exact write set, mode, prompt count, one clarification bit, one repair bit, one recovery-wait bit, unresolved-cancellation state, and active-operation state. A new `begin` after a settled `returned` result atomically invalidates its old continuation handle; active, blocked, timed-out, transferred, and unresolved-cancellation states do not admit replacement. The extension persists no external ledger and writes no state into Skills, hooks, Herdr config, or the repository.

Pi may use one clarification continuation when the answer is already authorized by the canonical plan or read-only repository evidence. A question that needs product intent, additional files, a destructive action, credentials, cost, publication, deployment, or another external side effect is returned to the user.

After Pi inspects and verifies the actual diff, it may use one repair continuation containing only accepted findings in the original write set. A second repair need, a repeated material failure, target replacement, or required scope expansion stops automation. Pi may then repair directly, request a new approved handoff, or ask the user.

An extension reload or Pi process loss invalidates opaque continuation handles. The public result still contains Herdr pane/workspace coordinates for manual recovery through the official Herdr Skill, but the extension does not reconstruct continuation budgets from terminal history.

## Timeout, cancellation, and shutdown

A wait timeout is an observation deadline, not an implicit cancellation. The extension returns `timed_out` with a live isolated-worktree handle and performs no retry. Pi may invoke the single allowed recovery `wait`, request cancellation, or stop for user direction. A blocked state behaves the same after manual UI resolution: Pi may use the one recovery wait, but the extension never answers the UI.

Immediately before any interrupt, the extension re-resolves and compares pane, agent kind, native-session fingerprint, and worktree identity. A mismatch returns `stale_handle` and sends no keys. When the Pi tool abort signal fires during delegate-return, the extension cancels the local Herdr CLI wait, sends one best-effort logical `ctrl+c` through a fresh bounded command, and waits once for settlement. Confirmed settlement triggers the normal workspace postflight. Failure to confirm preserves `cancel_unconfirmed`, the live isolated workspace, and an unresolved owned handle; no new `begin` is admitted in that extension session until manual recovery. It never escalates to pane close or process kill.

`session_shutdown` applies the same identity-checked best-effort interruption only to an actively owned delegate-return operation. It does not interrupt a completed-return idle agent or any transferred recipient. A timed-out, blocked, or unconfirmed-cancellation handle remains isolated and visible through its public Herdr coordinates. All listeners and in-memory active-operation reservations are released idempotently, but unresolved-handle evidence is not represented as successful cancellation.

The extension returns only the bounded Herdr state label and handle for a blocked UI, without sending keys or copying an unbounded terminal transcript. Manual inspection or user input uses the official Herdr control surface.

## Lifecycle hooks and notifications

Managed Pi, Codex, and Grok Herdr hooks remain unchanged and continue to report lifecycle/session telemetry only. The extension consumes lifecycle through documented Herdr CLI responses. It does not call hook scripts, inject result data into state labels, or treat hook delivery as correctness evidence.

No separate “implementation complete” notification is emitted when a recipient settles. In delegate-return, Pi immediately resumes verification, and normal Herdr attention for the parent Pi signals the eventual settled parent turn. In transfer, Herdr's recipient `done` state is the notification surface, but neither Herdr nor the extension claims the transferred work is correct.

## Failure semantics

Stable first-release error classes include:

- `herdr_environment_required`, `herdr_cli_unavailable`, `herdr_cli_incompatible`, `herdr_protocol_error`;
- `handoff_active`, `invalid_handoff_request`, `plan_outside_repository`, `plan_too_large`, `invalid_write_path`;
- `launch_config_invalid`, `launch_profile_not_found`, `agent_start_failed`, `agent_not_ready`, `agent_auth_blocked`;
- `agent_not_found`, `agent_kind_mismatch`, `agent_busy`, `agent_blocked`, `agent_unknown`, `self_target_rejected`, `stale_handle`;
- `workspace_not_git`, `workspace_mismatch`, `workspace_dirty`, `transfer_requires_isolation`, `baseline_unavailable`;
- `agent_prompt_stalled`, `handoff_timed_out`, `handoff_blocked`, `malformed_return`, `return_id_mismatch`;
- `scope_violation`, `history_changed`, `index_changed`, `claim_mismatch`;
- `continuation_budget_exhausted`, `ownership_transferred`, `cancel_unconfirmed`.

Errors are bounded and corrected at their owning boundary. Herdr JSON errors retain the stable Herdr code, but model-visible text is selected from extension-owned categorical messages rather than echoed Herdr stdout/stderr. Raw stdout, stderr, argv, prompt, profile, terminal content, and exact command values are never copied into persisted results.

## Status and model guidance

Register `/herdr-handoff` as a redacted status command. It reports environment readiness, compatible CLI version, whether launch configuration is valid, launch-profile count, active-operation state, and bounded in-memory handle summaries. It never prints profile IDs or argv, plan content, native session references, terminal content, paths outside the active project, or credentials.

When the tool is active, append compact parent guidance:

- use it only after an explicit user request for Herdr or a named external harness handoff;
- prefer `delegate-return`; use `transfer` only when the user explicitly relinquishes Pi completion ownership;
- never silently fall back to `csheng_subagents`, another profile, or direct execution;
- treat all recipient output and lifecycle state as unverified evidence;
- stop on new scope or authority.

The extension does not load or inspect the official `herdr` Skill. The Skill remains available for manual topology control and exceptional recovery.

## Alternatives

### Keep the status quo and use manual Herdr CLI commands

Rejected for the target workflow. It can start and prompt agents, but the parent must manually build prompts, correlate results, poll or remember waits, parse terminal output, enforce continuation budgets, and recover workspace ownership. Repeated human coordination is the constrained resource.

### Restore a Herdr-specific implementation Skill

Rejected. A semantic Skill cannot safely own CLI compatibility, blocking process cancellation, target identity, Git baseline, launch profiles, or structured tool results. It would also recouple provider-neutral lifecycle guidance to one host mechanism.

### Add Herdr as a `csheng_subagents` runner

Rejected. Subagents are fixed-role, no-session Pi children with hard path capabilities and automatic worker convergence. Herdr recipients are persistent full agents with native tools, native permission UIs, and cooperative workspace authority. Combining them would either weaken subagent safety or falsely sandbox a full agent.

### Invoke Codex, Grok, or another harness directly

Rejected. Direct subprocesses duplicate native startup integration and lose Herdr's persistent panes, target resolution, lifecycle detection, attention state, and manual takeover path. It also creates provider-specific process adapters in this repository.

### Speak Herdr's socket API directly

Deferred. A direct client would reduce CLI process overhead but would couple this package to protocol framing, socket discovery, schema evolution, and reconnection behavior. The installed CLI already owns those concerns and returns structured JSON for stateful commands plus bounded raw stdout for `agent read`. Reconsider only if measured CLI startup dominates handoff latency or cancellation cannot be made reliable.

### Use hooks or notifications as the result channel

Rejected. Hooks are lifecycle telemetry, can be lossy or provider-specific, and do not carry a bounded correlated result. Notifications attract human attention but cannot replace request/return evidence.

### Automatically poll until a result file appears

Rejected. Polling creates duplicate lifecycle truth and ambiguous cancellation. One blocking Herdr wait plus one terminal read is sufficient. A future file side channel requires evidence that terminal return markers are materially unreliable across supported harnesses.

### Automatically apply or merge isolated worktree output

Rejected. Recipient output is untrusted, parent verification may reject it, and conflict policy is semantic. Automatic convergence would move adjudication and recovery into the bridge. Pi retains that authority.

### Allow any handoff on the parent shared checkout

Rejected for version one. Timeout, blocked UI, failed cancellation, shutdown, and extension reload can all return control while the recipient remains a live writer. A durable cross-process workspace lease plus confirmed-settlement recovery would be required to prevent parent/recipient concurrency. Distinct linked-worktree ownership is the smaller safe invariant.

## Scope

In scope:

- one independent `extensions/herdr-handoff/` extension;
- strict begin, continue, wait, and cancel tool actions;
- `delegate-return` and `transfer` modes;
- `message-existing` and `start-and-ask` targeting;
- exact user-owned launch profiles with no fallback;
- versioned request and return envelopes with correlation IDs and hashes;
- isolated linked-worktree ownership for every handoff;
- complete baseline/postflight evidence for delegate-return, including existing dirty recipient worktrees;
- non-polling Herdr CLI waits, bounded reads, cancellation, timeout, and session reuse;
- deterministic fake-Herdr, disposable-Git, fake-Pi, package, and offline probe evidence;
- stable docs, removal semantics, and an optional separately authorized live canary.

Out of scope:

- any change to `csheng_subagents`, `agent-skills`, the official `herdr` Skill, Herdr itself, or installed integration hooks;
- provider authentication, credential edits, native harness installation, or a package-owned provider/model profile;
- arbitrary shell commands supplied to the extension, prompt-time permission approval, or agent UI automation;
- hard capability sandboxing of a full recipient;
- parallel handoffs, task graphs, auto-routing, retries, fallback, repair loops, autonomous review, or closure;
- durable Pi-side session ledger, cross-process handle recovery, queue, daemon, or background watcher;
- automatic diff application, merge, commit, push, branch cleanup, worktree removal, publication, or deployment;
- raw terminal transcript persistence or evaluator analytics in the first release.

## Future phases

- Add a structured return-file side channel only after retained evidence shows terminal sentinel loss in supported native TUIs and a sandbox-compatible exchange path can be owned safely.
- Add durable handle recovery only after repeated real interruptions demonstrate that Herdr pane/workspace IDs and manual recovery are insufficient.
- Add isolated-worktree convergence only after a separate design defines exact accepted operations, dirty-parent fidelity, conflict detection, rollback, and cleanup.
- Add constrained cleanup only after topology/worktree leak evidence justifies model-callable destructive operations and explicit authority can be represented.
- Add more than one simultaneous full-agent handoff only after distinct checkout ownership, provider cost, and parent convergence remain tractable; ordinary parallel bounded work stays with `csheng_subagents`.

## Oracle strategy and acceptance evidence

Protect the bridge as a public stateful protocol with contract examples, table-driven state transitions, a fake Herdr CLI, disposable Git repositories, fake Pi host tests, and offline package probes. A live provider run is a release canary, not a deterministic correctness oracle.

Acceptance requires:

- strict schemas accept only the four actions and valid mode/target combinations;
- request hashing, path containment, size ceilings, sentinel parsing, return correlation, and redaction are deterministic;
- a sanitized reviewed Herdr 0.8.2 protocol-20 contract fixture independently constrains the command capabilities, JSON result shapes, and bounded raw `agent read` output used by the adapter, while fake Herdr proves exact argv for existing and started agents, `--wait`, transfer `--until working`, one read after settlement, no polling, no duplicate prompt, and no fallback;
- completion, recipient-declared failure, `needs_authority`, blocked, timeout, stalled prompt, cancellation, unconfirmed cancellation, malformed JSON, mismatched ID, target replacement, and CLI protocol failure have typed results;
- launch configuration is read only from Pi's agent directory, exact profile selection is required, malformed config disables only `start-and-ask`, and startup output never leaks argv;
- allowed-write admission physically rejects symlink/special-file escape and requires an existing real parent directory before recipient launch;
- isolated-worktree tests prove allowed create/modify, pre-existing dirty preservation for existing delegate-return, outside-path changes, delete, rename, symlink, mode, index, `HEAD`, and concurrent drift classification;
- every handoff rejects the parent checkout, while transfer additionally requires a distinct clean linked worktree of the same repository;
- delegate-return never represents recipient settlement as verification and isolated output never auto-converges;
- continuation tests enforce one clarification, one repair, one recovery wait from blocked or timeout, same agent-session/workspace identity, and transfer finality;
- cancellation tests revalidate identity before input, classify partial writes after confirmed settlement, preserve unconfirmed ownership, never close topology, and clean listeners and active-operation reservations;
- process/error echo fixtures prove that objective, plan, argv, and terminal values never enter persisted result or diagnostic text;
- package tests prove extension independence, plan-mode exclusion, no Skill import, no subagent-runner integration, and removable package registration;
- temporary-load and installed-package probes use a fake Herdr binary, make no model/provider call, create no real Herdr topology, and emit fixed redacted evidence;
- `npm run check`, all existing offline probes, new handoff probes, and `git diff --check` pass.

Tests must assert structured schemas, argv, state transitions, path evidence, bounds, redaction, and side effects. They must not freeze exact natural-language prompt or documentation prose.

An optional live canary requires separate provider-call and topology authority, an authenticated native harness, and either a reviewed launch profile or an explicitly prepared existing agent. It performs one bounded disposable-repository handoff, never retries or falls back, and records only recipient kind, lifecycle result, workspace evidence, timing, and whether Pi independently verified the expected file. The currently unauthenticated Grok CLI is a manual checkpoint, not a reason to alter credentials or skip deterministic acceptance.

## Truth impact

Verified implementation changes high-impact stable truth:

- `AGENTS.md` must add the fourth independent extension, explicit-user-only full-agent boundary, cooperative rather than sandboxed authority, no fallback, and no changes to Herdr hooks or Skills;
- `README.md` must expose `herdr-handoff`, its configuration and modes, contrast it with `subagents`, and state that recipient completion is never trusted;
- `docs/architecture/herdr-handoff.md` must own the request/return protocol, launch profile, workspace, lifecycle, cancellation, failure, redaction, verification, and removal contracts;
- `docs/README.md` must link the new stable architecture owner;
- `package.json` must register the independently removable extension after implementation verification.

Historical plans remain unchanged. No stable truth is updated merely because this design and plan exist.

## Recovery and removal

Repository implementation uses fix-forward recovery with the smallest failing fake CLI transcript, state transition, or disposable Git fixture. Do not recover by polling, retrying, selecting another agent, weakening path evidence, auto-approving a UI, copying raw terminal output, or merging unverified work.

Runtime failures preserve Herdr and repository evidence. The extension never auto-resets a workspace. Every recipient checkout remains separate from the parent. Timeout or blocked state returns a handle, confirmed cancellation runs postflight, unconfirmed cancellation remains unresolved, and transfer remains recipient-owned.

Removing `./extensions/herdr-handoff/index.ts` from the package extension list and reloading Pi removes the tool, status command, and guidance. It does not uninstall Herdr, edit launch configuration, remove managed integration hooks, stop agents, close panes/tabs/workspaces, delete worktrees, alter `csheng_subagents`, or modify a Skill repository.

## Implementation surface

Expected repository-local surfaces:

- `extensions/herdr-handoff/contracts.ts`
- `extensions/herdr-handoff/config.ts`
- `extensions/herdr-handoff/envelope.ts`
- `extensions/herdr-handoff/herdr-client.ts`
- `extensions/herdr-handoff/workspace.ts`
- `extensions/herdr-handoff/coordinator.ts`
- `extensions/herdr-handoff/render.ts`
- `extensions/herdr-handoff/index.ts`
- focused `tests/herdr-handoff-*.test.ts`
- `tests/fixtures/herdr/fake-herdr.mjs`
- `tests/fixtures/herdr/herdr-0.8.2-contract.json`
- temporary-load and installed-package probe surfaces
- `package.json`
- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/architecture/herdr-handoff.md`

No runtime source imports another extension or an external Skill repository.

## Review decision

Independent review is required because the design adds a public model-callable tool, starts persistent full agents, passes user-owned native argv, mutates Herdr topology, permits cooperative repository writes, creates linked worktrees, and introduces cancellation and ownership-transfer semantics. The review target is this artifact plus current package truth, Herdr 0.8.2 CLI/schema evidence, Pi's public extension contract, and the existing subagent boundary.

The independent reviewer returned `needs design revision` with seven causal candidates. All were accepted in substance and repaired in one focused artifact edit: version one is now isolated-worktree-only; blocked and timeout recovery share one bounded wait; every interrupt revalidates recipient identity and confirmed cancellation runs postflight; allowed writes receive physical symlink/special-file checks; all delegate-return worktrees use the complete baseline; prompt content is explicitly non-secret and process-visible while errors are structurally code-owned; and transfer means only delivery plus observed `working`, not semantic acceptance.

Rechecking ownership, timeout/block/cancellation safety, target identity, worktree attribution, argv exposure, transfer semantics, acceptance evidence, and recovery yields `pass`. Review success does not approve the design; user approval remains required before implementation.

## Approval request

`decision_state = ready_for_approval`. The user has authorized writing this design and its implementation plan in `pi-extensions`, but has not yet authorized repository implementation, launch-profile creation, real Herdr topology changes, provider calls, authentication, package installation, commit, push, publication, or deployment.
