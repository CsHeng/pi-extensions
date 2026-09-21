# Herdr Handoff

`extensions/herdr-handoff/index.ts` registers `herdr_handoff`, an explicit-user-only bridge to one persistent vendor-native coding agent managed by Herdr. Pi remains the canonical-plan, verification, review-adjudication, repair-decision, truth-sync, and closure owner. The extension owns request/wait/read mechanics, launch-profile loading, isolated-worktree evidence, bounded continuations, and redacted results. It is not a `csheng_subagents` runner and shares no scheduler, child role, route, or workspace-convergence implementation with that extension.

## Ownership

| Owner | Owns | Does not own |
| --- | --- | --- |
| User | Explicit Herdr use, recipient harness/profile choice, provider cost, permission posture, new authority, cancellation intent, and one-way transfer | Mechanical parsing, Git postflight, Pi verification, or hidden fallback |
| Skills and active Pi | Approved scope, canonical plan, exact allowed writes, verification, finding adjudication, one bounded repair decision, truth sync, closure, and final claims | Herdr topology, native detection, provider authentication, or persistent agent sessions |
| `herdr-handoff` | Request/return schemas, launch-profile loading, Herdr CLI adaptation, target/workspace validation, one blocking wait, result parsing, continuation counters, cancellation request, postflight evidence, redaction, and in-memory handles | Semantic eligibility, plan approval, correctness judgment, automatic UI answers, automatic repair, automatic convergence, or completion |
| Herdr | Topology, native startup, live targets, prompt delivery, lifecycle observation, terminal reads, and persistent handles | Plan semantics, implementation correctness, repository scope, result schema meaning, or Pi closure |
| Recipient harness | Native loop, configured model and tools, implementation actions in the selected checkout, native approval UI, and returned claims | Widening the handoff, modifying Pi state, judging its own completion as verified, or transferring authority onward |

## Activation

Loading the extension registers the tool, `/herdr-handoff` status command, and compact parent guidance. It starts no agent and changes no topology until the parent calls the tool. Dispatch requires `ctx.isProjectTrusted()`, `HERDR_ENV=1`, caller pane/workspace context, and a compatible `herdr` executable. There is no fallback to subagents, another pane manager, or a default agent.

The official `herdr` Skill is optional manual guidance and is not a runtime dependency. Managed Herdr integration hooks remain telemetry-only and outside this repository.

## Modes and actions

The tool is action-discriminated:

- `begin` starts `delegate-return` or `transfer` against a `message-existing` or `start-and-ask` target.
- `continue` sends one parent-owned clarification or repair to a live delegate-return handle.
- `wait` performs one additional blocking recovery wait after timeout or blocked return without sending another prompt.
- `cancel` sends one identity-checked logical `ctrl+c` and, after confirmed settlement, runs postflight.

`delegate-return` waits until the recipient settles, reads `recent-unwrapped` once, parses the return envelope, and captures Git postflight. `transfer` waits only until prompt delivery plus an observed `working` transition, then relinquishes outcome ownership. Neither mode claims semantic acceptance or completion.

## Targeting and launch profiles

A `message-existing` target is one exact live agent name or pane ID plus expected kind. The extension rejects the caller pane, busy/blocked/unknown startup states, kind mismatch, the parent checkout, and unrelated repositories. Route evidence is `externally_configured_unverified`.

`start-and-ask` reads optional user-owned `herdr-handoff.json` from Pi's public agent directory returned by `getAgentDir()`. Project repositories and this package do not provide profiles. The file is version 1 `{ version, profiles: { id: { kind, args, startupTimeoutMs? } } }`. Selection is exact, with no fallback. Absent or malformed configuration leaves existing-agent messaging usable and disables only `start-and-ask`. Native argv is opaque user-owned policy and must not contain secrets. Herdr's returned startup argv is discarded immediately.

## Workspace authority

Every first-release recipient occupies a distinct linked worktree of the trusted parent Git repository. The parent checkout is never the recipient cwd. Transfer additionally requires a clean recipient worktree. Delegate-return may begin in an existing dirty isolated worktree only after capturing a complete baseline.

Allowed writes are exact repository-relative regular files. Admission rejects traversal, absolute paths, duplicates, directories, symlink/special-file ancestors, physical escape, and missing parent directories. Postflight accepts only regular-file create/modify inside that set. Deletion, rename, symlink, mode, index, `HEAD`, outside-path, and concurrent dirty-path drift are typed violations. Ignored files, external paths, network effects, and harness-owned state are unobservable. Isolated output never auto-converges into the parent checkout.

## Request and return

The generated `pi-herdr-handoff/v1` prompt includes the full canonical plan bytes, correlation ID, plan hash, exact writes, non-goals, verification expectations, and fixed authority exclusions. Plan files are read once through physical containment checks. Prompt text is process-visible Herdr CLI argv and must contain no secrets. The return instructions require pretty-printed JSON with every physical line below 96 columns so native TUI rendering does not split JSON strings.

Herdr 0.8.2 returns structured JSON for stateful commands and bounded raw stdout for `agent read`. After one `recent-unwrapped` read, the extension selects exactly one structurally valid envelope for the current handoff ID from the final complete sentinel pair. It ignores prompt-echo delimiters and older envelopes with another handoff ID; duplicate current envelopes, trailing malformed pairs, missing or truncated delimiters, oversized content, malformed JSON, and unmatched IDs fail closed without persisting the transcript.

Results separate `bridgeStatus`, untrusted `agentOutcome`, and `workspaceStatus`. An `implemented` outcome with `within_declared_writes` is rendered as an unverified claim that still requires parent verification. No combination is `verified` or `completed`.

## Continuations, timeout, and cancellation

One clarification, one repair, and one blocked-or-timeout recovery wait are allowed per delegate-return handle. A new `begin` after a settled `returned` result invalidates that old handle; active, blocked, timed-out, transferred, and unresolved-cancellation states remain closed to replacement. Transfer admits no continuation or cancellation. Handles are in-memory only; reload invalidates opaque tokens while public Herdr coordinates remain for manual recovery.

A wait timeout is an observation deadline, not implicit cancellation. Cancel and session shutdown revalidate pane, kind, session fingerprint, and worktree identity before sending `ctrl+c`. Confirmed settlement runs postflight. Unconfirmed cancellation preserves an unresolved owned handle and blocks a new `begin` until manual recovery. The extension never closes panes, kills processes, removes worktrees, or answers a blocked UI.

## Redaction and removal

Persisted results and `/herdr-handoff` omit launch argv, profile IDs, native session paths, prompt/plan bytes, terminal transcripts, credentials, and environment values. Removing `./extensions/herdr-handoff/index.ts` from the package extension list removes the tool, status command, and guidance without uninstalling Herdr, editing launch configuration, stopping agents, or deleting worktrees.
