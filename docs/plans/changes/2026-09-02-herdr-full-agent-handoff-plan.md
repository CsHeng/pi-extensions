```toml
artifact_kind = "plan"
plan_version = 1
approval_status = "ready_for_approval"
decision_state = "ready_for_approval"
design_ref = "docs/plans/changes/2026-09-02-herdr-full-agent-handoff-design.md"
design_sha256 = "04778455a9a5af46ff4ceed8245bcdd4b0a1f6441c26f470f48a9128ac623ba8"
design_approval_status = "ready_for_approval"
implementation_authority = false
truth_sync_required = true
review_required = true
review_status = "passed_after_repair"
live_provider_authority = false
live_checkpoint_status = "manual_checkpoint"
```

# Herdr Full-Agent Handoff Extension Implementation Plan

## Milestone objective

Implement and verify the proposed `herdr-handoff` extension as the fourth independently removable package extension. The milestone gives Pi one explicit-user-only bridge to a persistent vendor-native coding agent through Herdr while preserving Pi's ownership of the canonical plan, repository verification, review adjudication, accepted repair, truth synchronization, closure, and final claims.

The extension will support `delegate-return` and one-way `transfer`, exact `message-existing` and `start-and-ask` targets, user-owned launch profiles, versioned request/return envelopes, non-polling wait, bounded continuation and cancellation, isolated-worktree Git postflight, typed evidence, and redacted package probes. Every recipient checkout remains distinct from the parent checkout.

This plan does not modify `csheng_subagents`, `agent-skills`, the official `herdr` Skill, Herdr-managed integration hooks, provider credentials, native harness configuration, or global installation. It does not authorize a real provider call, Herdr topology mutation outside deterministic fake tests, launch-profile creation, commit, push, publication, deployment, or automatic worktree convergence.

## Design state and approval gates

The controlling design is `docs/plans/changes/2026-09-02-herdr-full-agent-handoff-design.md` at the hash recorded in frontmatter. The user authorized creating the design and plan in this repository but has not yet approved implementation.

Execution gates:

- `G0 — design and plan approval`: unresolved; the user must approve the exact design and plan before repository mutation beyond these stage artifacts.
- `G1 — repository mutation authority`: unresolved; approval must explicitly permit repository-local implementation in `pi-extensions` within the declared write sets.
- `G2 — deterministic prerequisites`: clear; Node, TypeScript, Git, and the existing package dependencies are sufficient. A real Herdr server, native agent, provider account, and credentials are not needed because deterministic tests use a fake CLI.
- `G3 — Herdr implementation-delegation authority`: unresolved; using a real external implementer for `HHO-100..HHO-600` requires the user to authorize the exact existing target or launch profile, provider cost, and real Herdr topology/worktree mutation. `G0` and `G1` alone authorize only parent-local implementation.
- `G4 — live canary authority`: unresolved and optional; the user must separately authorize provider cost, real Herdr topology, a reviewed launch profile or prepared existing agent, and a disposable repository.
- `G5 — selected-harness authentication`: conditional manual prerequisite for `LIVE-800`; whichever native harness is selected must already be authenticated. The installed Grok CLI is currently unauthenticated, but that does not block a separately selected authenticated harness. Implementation must not change authentication or credentials.

`G0` and `G1` block `HHO-100`. `G3` additionally blocks delegated implementation through real Herdr, but not parent-local repository implementation. `G4` and `G5` do not block deterministic acceptance; they block only the optional live checkpoint.

If the design bytes change during review or approval, update its hash and recheck this plan before implementation. A material design change returns `needs_design_decision` rather than being absorbed into a task.

## Repository owner and scope

| Repository ID | Root | Owned work |
| --- | --- | --- |
| PE | `pi-extensions` | Herdr handoff contracts, configuration, envelope, CLI adapter, Git workspace evidence, coordinator, tool integration, tests, fake CLI, probes, package registration, and stable truth |

No writable task crosses a repository root. The sibling `agent-skills` working tree and global Pi/Herdr configuration are read-only external context and are not implementation surfaces.

Expected repository-local scope:

- `extensions/herdr-handoff/**`
- `tests/herdr-handoff-*.test.ts`
- `tests/fixtures/herdr/fake-herdr.mjs`
- `tests/fixtures/herdr/herdr-0.8.2-contract.json`
- `tests/installed-herdr-handoff-probe.test.ts`
- `scripts/run-temporary-herdr-handoff-probe.sh`
- `scripts/run-installed-herdr-handoff-probe.sh`
- `tests/package.test.ts`
- `tests/repository-boundary.test.ts`
- `package.json`
- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/architecture/herdr-handoff.md`

`package-lock.json` is not expected to change because the design requires no new dependency. If implementation proves a direct dependency is required, stop for parent adjudication before modifying the lockfile.

## Fixed implementation constants

`HHO-100` freezes directly tested first-release ceilings:

- canonical plan: `64 KiB` UTF-8;
- objective: `8 KiB`;
- exact write paths: `32`;
- non-goals, verification entries, and context entries: `32` each;
- complete generated handoff prompt: `128 KiB`;
- recipient return envelope: `32 KiB` and `240` recent-unwrapped lines;
- result summary/evidence fields: bounded independently so aggregate model-visible output remains below Pi's default tool cap;
- start profile argv: `32` items, `4 KiB` per item, `16 KiB` total, no NUL;
- initial/continuation wait: minimum `5 seconds`, default `30 minutes`, maximum `30 minutes`;
- launch startup timeout: `3,001..300,000 ms`;
- one active operation per Pi extension session;
- one clarification continuation, one repair continuation, and one blocked-or-timeout recovery wait per delegate-return handle;
- cancellation settlement wait: `5 seconds`, one logical `ctrl+c`, no escalation.

Changing a ceiling after `HHO-100` requires a causal fixture and parent adjudication. A request to add polling, retry, pane close, process kill, automatic merge, or durable state returns `needs_design_decision`.

## Execution graph

```text
G0 design/plan approval + G1 repository authority
└── HHO-100 public contracts and state model
    ├── HHO-200 launch configuration and envelopes ─┐
    ├── HHO-300 Herdr CLI adapter ──────────────────┼── HHO-500 coordinator and session semantics
    └── HHO-400 Git workspace authority ────────────┘
                                                   └── HHO-600 Pi integration, package, and probes
                                                       └── HHO-700 stable truth, full verification, and review
                                                           └── ready for handoff

optional: HHO-700 deterministic pass + G4 + G5 -> LIVE-800 one bounded canary
```

`HHO-200`, `HHO-300`, and `HHO-400` are logically independent after `HHO-100`; their write sets and primary fixtures are disjoint. They may be implemented in parallel only in separate writable checkouts with parent-owned convergence. The preferred Herdr implementation handoff is one full-agent serial package over `HHO-100..HHO-600`, because a persistent external agent working in one checkout should not create concurrent writers. `HHO-700` remains parent-owned.

No task edge crosses a parent decision. `HHO-500` waits for the three mechanical foundations because it composes their frozen contracts. `HHO-600` waits for the complete coordinator. `HHO-700` owns integration verification and adjudication rather than being projected into an external-agent prompt as automatic continuation.

## Delegated implementation package

The user explicitly intends an external full agent to act as implementer through Herdr while Pi remains the convergence owner. After `G0`, `G1`, and the distinct `G3` target/profile/provider/topology authorization, the active Pi may freeze `HHO-100..HHO-600` as one canonical handoff package.

- **Repository owner:** PE
- **Execution profile:** `deep`
- **Reasoning profile:** `deep`
- **Write set:** the union of exact files declared by `HHO-100..HHO-600`; the handoff must enumerate the concrete set after preflight and before prompting
- **Resource locks:** `herdr-handoff-public-contract`, `herdr-handoff-runtime`, `pi-package-manifest`
- **Isolation:** one exclusive linked worktree of the same repository, distinct from the parent checkout, with no parallel writer
- **Convergence owner:** active Pi; external output is untrusted and isolated output is never auto-applied
- **Verification:** focused task commands plus the complete deterministic lane in `HHO-700`
- **Done evidence:** exact changed-file list, focused checks, full checks, postflight evidence, and no scope expansion
- **Failure policy:** one handoff attempt; no provider/profile fallback, retry, permission escalation, or config mutation; blocked scope or authority returns to Pi/user

This plan records semantic profiles only. A later explicit user-selected harness, model, or reasoning route is invocation authority and may be passed through a compatible handoff mechanism without editing this plan or durable route configuration. The plan does not bind a provider or model.

If the Herdr extension does not yet exist, the active Pi may use the installed official Herdr CLI/Skill manually to perform the same bounded `send -> wait -> receive` delegation only after `G3`. That operational choice does not change task dependencies or grant broader authority.

## HHO-100 — Freeze public contracts and state transitions

- **Depends on:** `G0`, `G1`
- **Execution:** serial foundation; delegation-ready only as part of the approved full-agent package
- **Locks:** `herdr-handoff-public-contract`
- **Execution profile:** `deep`
- **Reasoning profile:** `deep`

**Write set:**

- `extensions/herdr-handoff/contracts.ts`
- `tests/herdr-handoff-contract.test.ts`

**Work:**

- Define strict TypeBox schemas and TypeScript types for `begin`, `continue`, `wait`, and `cancel`.
- Encode valid combinations of `delegate-return`, `transfer`, `message-existing`, and `start-and-ask` under the invariant that every recipient occupies a distinct linked worktree.
- Define request, launch-profile, handle, recipient return, workspace evidence, result, lifecycle, continuation counter, and typed-error contracts.
- Export the fixed constants above and UTF-8/array/path bounds.
- Represent recipient evidence without any `verified`, `completed`, or automatic-success field.
- Define a pure handoff state transition table covering new, prompting, waiting, returned, blocked, timed out, transferred, cancelled, failed, and stale handles.
- Keep raw shell command, cwd override, arbitrary environment, native prompt, permission answer, fallback profile, retry count, pane close, process kill, auto-merge, commit, push, and deployment fields out of the tool schema.

**Contract oracle matrix:**

- every valid initial mode/target combination under the distinct-worktree invariant;
- parent-checkout rejection for every handoff and clean distinct-worktree admission for transfer;
- action-specific required and forbidden fields;
- exact path and byte ceilings;
- stable return outcomes and bridge/workspace status separation;
- one clarification, one repair, and one timeout-wait budget;
- malformed unknown fields and invalid enums.

**Verification:**

```bash
node --experimental-strip-types --test tests/herdr-handoff-contract.test.ts
npm run typecheck
```

**Done when:**

- the model-facing schema expresses only the approved operations;
- recipient settlement cannot serialize as verified completion;
- all state and error enums are code-owned and table-tested;
- no Herdr command is executed from this task's tests.

**Recovery:** Fix forward inside the write set. An incompatible need for background state, automatic convergence, or a fifth action returns `needs_design_decision`.

## HHO-200 — Implement launch configuration and correlated envelopes

- **Depends on:** `HHO-100`
- **Parallel group:** `mechanical-foundations`
- **Locks:** `herdr-launch-config`, `handoff-envelope`
- **Execution profile:** `balanced`
- **Reasoning profile:** `deep`

**Write set:**

- `extensions/herdr-handoff/config.ts`
- `extensions/herdr-handoff/envelope.ts`
- `tests/herdr-handoff-config.test.ts`
- `tests/herdr-handoff-envelope.test.ts`

**Work:**

- Load only `herdr-handoff.json` from Pi's public agent directory via `getAgentDir()`; never search project, environment-selected, Herdr, Codex, or Grok configuration.
- Parse version-one exact profile IDs into bounded `{ kind, args, startupTimeoutMs }` values without mutating or normalizing the source file.
- Let absent or malformed configuration leave `message-existing` usable while `start-and-ask` returns typed diagnostics.
- Reject symlinked config, unknown keys, invalid identifiers, NUL, oversized argv, invalid timeout, and duplicate JSON/object ambiguity under the repository's strict parser conventions.
- Build `pi-herdr-handoff/v1` from the exact request bytes, generated correlation ID, canonical Git root, fixed authority exclusions, and strict return instructions, including pretty JSON with every physical line below 96 columns to avoid native-TUI hard wraps inside strings.
- Read repository-relative plan files once through physical containment checks, reject symlink/traversal escape, compute SHA-256, and emit the same canonical content as inline plans.
- Select exactly one structurally valid bounded `pi-herdr-return/v1` envelope for the current handoff ID from the final complete sentinel pair, ignoring prompt-echo delimiters and older mismatched handoffs; validate protocol, outcome, paths, checks, questions, and risks.
- Return structured parse errors without retaining surrounding terminal content.

**Fixture matrix:**

- absent, valid, malformed, symlinked, oversized, and unknown-key launch config;
- exact profile hit and missing profile with zero fallback;
- argv containing spaces and punctuation passed as items, not shell text;
- inline and file plans with identical bytes producing identical hashes;
- path traversal, absolute path, symlink, non-regular file, and oversized plan rejection;
- valid return for every outcome;
- prompt-echo delimiters and an older mismatched handoff before one final correlated return; duplicate current, missing/truncated/trailing sentinel, malformed JSON, wrong protocol, unmatched handoff ID, oversized fields, and invalid changed path;
- assertions that rendered diagnostics contain no argv, plan content, native session reference, or terminal text.

**Verification:**

```bash
node --experimental-strip-types --test \
  tests/herdr-handoff-config.test.ts \
  tests/herdr-handoff-envelope.test.ts
npm run typecheck
```

**Done when:**

- launch selection is exact and read-only;
- no package/provider default exists;
- the same frozen plan bytes are sent regardless of source form;
- return parsing is strict, bounded, correlated, and redacted.

**Recovery:** Fix forward. Do not make malformed launch configuration disable manual existing-agent messaging, and do not recover from an unknown profile by selecting another one.

## HHO-300 — Implement the Herdr CLI adapter

- **Depends on:** `HHO-100`
- **Parallel group:** `mechanical-foundations`
- **Locks:** `herdr-cli-adapter`, `fake-herdr-fixture`
- **Execution profile:** `balanced`
- **Reasoning profile:** `deep`

**Write set:**

- `extensions/herdr-handoff/herdr-client.ts`
- `tests/herdr-handoff-client.test.ts`
- `tests/fixtures/herdr/fake-herdr.mjs`
- `tests/fixtures/herdr/herdr-0.8.2-contract.json`

**Work:**

- Invoke `herdr` only through `pi.exec(command, argv, { signal, timeout })`; never use a shell string.
- Preflight `HERDR_ENV=1`, caller pane/workspace context, executable availability, and the approved minimum CLI version while allowing compatible later versions.
- Add one sanitized, reviewed contract fixture derived from installed Herdr 0.8.2 protocol 20 schema/help, representative real read-only JSON responses, and bounded raw `agent read` stdout. Keep only the request/result fields and command capabilities used by this adapter; record fixture provenance without terminal, session, path, or environment values.
- Parse the exact Herdr CLI outputs needed by the adapter: plain version text; JSON result/error envelopes for `agent get`, `agent start`, `agent prompt`, `agent wait`, logical interrupt, and isolated worktree creation; and bounded raw stdout for `agent read`. Test those decoders against the independent 0.8.2 contract fixture as well as fake runtime responses.
- For JSON-producing commands, reject unexpected result type, multiple JSON values, and non-JSON stdout. Reject oversized output, inconsistent pane/workspace identity, and CLI exit errors across the adapter as bounded typed failures.
- Expose behavior-bearing methods rather than a generic arbitrary-command wrapper.
- Build exact `agent prompt` argv with `--wait --timeout` for delegate-return and `--wait --until working --timeout` for transfer.
- Read only `recent-unwrapped` with the fixed line bound after a settled delegate-return; never use output matching, repeated get/read, or timers.
- Treat all prompt text as non-secret process-visible argv under the documented Herdr 0.8.2 CLI. Return only extension-owned categorical errors so echoed command values from stdout/stderr cannot reach persisted details.
- Pass launch profile args only after `--`, parse startup identity, and discard Herdr's returned argv immediately.
- On abort or explicit cancellation, send one logical `ctrl+c` through a fresh bounded command and perform one settlement wait with no process-kill escalation.

**Fake-Herdr modes:**

- existing idle/done/working/blocked/unknown agent;
- exact kind and agent-session identity;
- successful start, blocked authentication, not-ready, timeout, and argv echo designed to catch leaks;
- prompt transitions to working, idle, done, blocked, stalled, and timeout;
- valid and malformed recent-unwrapped read;
- cancellation settled and unconfirmed;
- CLI syntax error, JSON error response, protocol-shape drift, nonzero exit, abort, and hung command;
- command log written only inside a disposable fixture directory so tests can prove command count/order without exposing prompt bytes.

**Verification:**

```bash
node --experimental-strip-types --test tests/herdr-handoff-client.test.ts
npm run typecheck
```

**Done when:**

- exact command logs prove one prompt wait and one read, transfer waits only for delivery plus observed `working`, and no polling/retry/fallback occurs;
- the reviewed 0.8.2 contract fixture independently constrains command capabilities and decoded response shapes rather than letting the fake define both sides;
- cancellation revalidates identity, emits at most one `ctrl+c`, runs one post-settlement read/postflight through the coordinator, and issues no close/kill command;
- all stdout/stderr and returned argv are bounded and redacted before leaving the adapter;
- tests need no real Herdr server, pane, agent, provider, or credentials.

**Recovery:** Fix forward from the smallest fake response. If Herdr 0.8.2 cannot support one required state transition through documented CLI behavior, return `needs_design_decision`; do not import socket internals.

## HHO-400 — Implement Git workspace authority and postflight evidence

- **Depends on:** `HHO-100`
- **Parallel group:** `mechanical-foundations`
- **Locks:** `herdr-workspace-baseline`, `git-postflight`
- **Execution profile:** `deep`
- **Reasoning profile:** `deep`

**Write set:**

- `extensions/herdr-handoff/workspace.ts`
- `tests/herdr-handoff-workspace.test.ts`

**Work:**

- Resolve the trusted parent Git root, worktree root, common repository identity, `HEAD` or unborn state, and index digest without modifying the index.
- Validate exact repository-relative allowed writes, physical containment, existing symlink ancestors, regular-file create/modify authority, and parent directories for new files.
- Capture porcelain-v2 `-z` status with all non-ignored untracked paths plus type, mode, and content digests for baseline dirty paths and allowed writes.
- Compare postflight evidence to classify allowed create/modify, unchanged pre-existing dirt, outside-path change, delete, rename, symlink, mode, index, `HEAD`, and concurrent drift.
- Treat Git output and paths as data, never shell fragments; retain bounded repository-relative evidence only.
- Reject the parent checkout for every recipient and validate an existing Herdr target's cwd as a distinct linked worktree of the same repository.
- Require clean parent state and valid `HEAD` for managed isolated creation and clean recipient state for transfer. Permit an existing isolated `delegate-return` with pre-existing dirt only by capturing and preserving the complete baseline.
- Keep worktree creation response validation separate from diff application; expose no convergence, reset, remove, branch-delete, commit, or merge operation.

**Disposable-Git matrix:**

- clean isolated recipient checkout allowed create and modify;
- existing isolated delegate-return with a dirty allowed path changed again;
- existing isolated delegate-return with an unrelated dirty path unchanged and changed concurrently;
- new outside path, tracked outside modification, delete, rename, symlink, mode change, staged change, commit/HEAD move, and ignored-file limitation;
- unborn repository classification;
- nested cwd with same worktree root;
- same-repository linked worktree, unrelated repository, dirty transfer worktree, parent checkout rejection for both modes, and dirty existing delegate-return baseline;
- path traversal, absolute path, symlink ancestor escape, duplicate normalized write path, directory path, and missing parent.

**Verification:**

```bash
node --experimental-strip-types --test tests/herdr-handoff-workspace.test.ts
npm run typecheck
```

**Done when:**

- isolated postflight accepts only declared regular-file create/modify deltas;
- pre-existing unrelated dirt in an existing delegate-return worktree is preserved only when byte-identical;
- every recipient is a distinct linked worktree and transfer eligibility additionally requires it to be clean;
- no test mutates the real repository, global Git configuration, or Herdr topology.

**Recovery:** Fix forward inside disposable fixtures. Never reset a failed fixture as runtime behavior, hide ignored/external limitations, or widen exact writes.

## HHO-500 — Compose the handoff coordinator and bounded session state

- **Depends on:** `HHO-200`, `HHO-300`, `HHO-400`
- **Execution:** serial integration of mechanical foundations
- **Locks:** `herdr-handoff-coordinator`, `handoff-session-state`
- **Execution profile:** `deep`
- **Reasoning profile:** `deep`

**Write set:**

- `extensions/herdr-handoff/coordinator.ts`
- `tests/herdr-handoff-coordinator.test.ts`

**Work:**

- Compose dependency-injected config, envelope, Herdr client, and workspace adapters behind action-level coordinator methods.
- Reserve one active operation per Pi extension session before topology or prompt mutation and release it idempotently after all cleanup.
- For `message-existing`, reject self-target, unexpected kind, busy/blocked/unknown startup state, unidentified replacement, parent/unrelated checkout, and dirty transfer target before prompt delivery. Permit dirty existing delegate-return only through the complete workspace baseline.
- For `start-and-ask`, generate a Herdr-safe unique name, create one non-focused isolated worktree/workspace, start exactly one profile, and verify live target and checkout identity.
- Execute the fixed delegate-return and transfer command sequences without polling.
- Parse return evidence only after settlement; classify blocked, timeout, malformed return, recipient outcome, claim mismatch, and workspace violations independently.
- Store bounded in-memory delegate-return handles and verify pane, agent kind, native session fingerprint, checkout, plan hash, write set, and continuation budget before `continue`, `wait`, or `cancel`.
- Enforce one clarification, one repair, and one recovery wait from either blocked or timed out; prohibit all continuation/cancellation after transfer.
- Revalidate the full target/session/worktree fingerprint immediately before every interrupt, send no input on mismatch, run normal postflight after confirmed cancellation, and retain an unresolved owned handle after unconfirmed cancellation.
- Link tool abort and session shutdown to that one best-effort interrupt path for only the actively owned delegate-return operation.
- Never close or remove created topology automatically.

**State-transition scenarios:**

- existing isolated delegate-return with clean or baseline-captured dirty state, valid implemented claim, and allowed diff;
- started isolated delegate-return;
- started isolated transfer returned after delivery plus observed `working`, with no semantic-acceptance claim, read, or postflight;
- every mode rejected on the parent checkout and transfer rejected on a dirty existing worktree;
- blocked before prompt, blocked after partial work, needs-authority envelope, recipient failure, no changes, malformed return, claim mismatch, scope violation, index/history change;
- observation timeout then one recovery wait success and second wait rejection;
- blocked return, manual UI resolution, one recovery wait to valid return, and still-blocked recovery exhaustion;
- one clarification and one repair in either valid order, duplicate intent rejection, and repeated failure stop;
- stale handle from replaced session, moved pane resolution through current live target rules, changed checkout, extension reload, and concurrent action;
- abort/shutdown cancellation with pre-interrupt identity match/mismatch, confirmed partial-write postflight, and unresolved unconfirmed interruption;
- exact assertions that no fallback target/profile, duplicate prompt, automatic answer, retry, merge, close, or kill occurs.

**Verification:**

```bash
node --experimental-strip-types --test \
  tests/herdr-handoff-coordinator.test.ts \
  tests/herdr-handoff-client.test.ts \
  tests/herdr-handoff-workspace.test.ts
npm run typecheck
```

**Done when:**

- all public actions reduce to deterministic state transitions;
- `implemented` always remains an unverified recipient claim;
- transfer finality and checkout isolation are mechanically enforced;
- cleanup releases in-memory state without destroying Herdr or Git evidence.

**Recovery:** Fix forward. A requirement for another continuation, persistent ledger, automatic answer, cleanup, or merge returns `needs_design_decision`.

## HHO-600 — Register the Pi extension, package surface, and offline probes

- **Depends on:** `HHO-500`
- **Execution:** serial package integration
- **Locks:** `herdr-handoff-entrypoint`, `pi-package-manifest`, `package-probes`
- **Execution profile:** `deep`
- **Reasoning profile:** `standard`

**Write set:**

- `extensions/herdr-handoff/index.ts`
- `extensions/herdr-handoff/render.ts`
- `tests/herdr-handoff-extension.test.ts`
- `tests/herdr-handoff-render.test.ts`
- `tests/installed-herdr-handoff-probe.test.ts`
- `tests/package.test.ts`
- `tests/repository-boundary.test.ts`
- `scripts/run-temporary-herdr-handoff-probe.sh`
- `scripts/run-installed-herdr-handoff-probe.sh`
- `package.json`

**Work:**

- Register `herdr_handoff` with the frozen schema, a redacted `/herdr-handoff` status command, and explicit-user-only prompt guidance.
- Require `ctx.isProjectTrusted()` and Herdr caller context before any initial handoff mutation.
- Wire tool signal, progress updates, host `tool_result` error classification, and awaited `session_shutdown` cleanup to the coordinator.
- Render compact mode, action, recipient kind/name, lifecycle, plan hash prefix, workspace class/status, changed-path count, continuation budget, typed error, and “parent verification required” language.
- Never render launch argv, profile content/IDs in status, native session references, prompt/plan bytes, full terminal output, config paths, credentials, environment values, or paths outside the selected checkout.
- Add the extension as the fourth package entry after `subagents` while preserving existing order and behavior.
- Extend package/boundary tests to prove no Herdr npm/runtime dependency, no external Skill import, no subagent module import, no managed hook path, no socket protocol client, and no generic arbitrary Herdr command surface.
- Build temporary-load and installed-package probes around the fake Herdr fixture. Probes must prove registration, status, one bounded delegate-return fixture, extension-off absence, no real topology/provider activity, and fixed redacted output.
- Keep `plan-mode` exact-tool behavior unchanged so the handoff tool remains inactive in plan mode.

**Verification:**

```bash
node --experimental-strip-types --test \
  tests/herdr-handoff-contract.test.ts \
  tests/herdr-handoff-config.test.ts \
  tests/herdr-handoff-envelope.test.ts \
  tests/herdr-handoff-client.test.ts \
  tests/herdr-handoff-workspace.test.ts \
  tests/herdr-handoff-coordinator.test.ts \
  tests/herdr-handoff-extension.test.ts \
  tests/herdr-handoff-render.test.ts \
  tests/installed-herdr-handoff-probe.test.ts \
  tests/package.test.ts \
  tests/repository-boundary.test.ts
npm run typecheck
bash -n scripts/*.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
git diff --check
```

**Done when:**

- fake-Pi tests prove tool/status/guidance registration, trust refusal, action execution, progress, result error mapping, one-active-operation enforcement, abort, and awaited shutdown;
- package tests expose exactly four independent extension entrypoints;
- offline probes make no provider call and do not contact the live Herdr session;
- all existing extension tests remain unchanged or pass with only justified package-count adjustments.

**Recovery:** Fix forward. If integration requires changing another extension, importing Herdr internals, or exposing raw argv/transcript to diagnose, stop for design adjudication.

## HHO-700 — Synchronize stable truth, run full verification, and review

- **Depends on:** `HHO-600`
- **Execution:** parent-owned convergence, not delegable
- **Locks:** `stable-truth`, `full-verification`, `implementation-review`

**Write set:**

- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/architecture/herdr-handoff.md`

**Conditional focused-repair surface:** only exact causal files already authorized under `HHO-100..HHO-600`; review cannot add a new surface or authority.

**Work:**

- Document four independent extensions and keep the prohibition on a second lifecycle engine.
- Make the stable distinction between full external agents and fixed-role subagents explicit.
- Own request/return envelopes, exact target selection, user launch profiles, workspace policies, non-polling sequence, bounded continuation, transfer finality, cancellation, postflight limitations, result semantics, redaction, verification, and removal in `docs/architecture/herdr-handoff.md`.
- State that managed Herdr hooks remain telemetry-only and outside repository ownership.
- State that the official `herdr` Skill is optional manual guidance, not a runtime dependency.
- Document configuration and live-canary prerequisites without embedding a provider/model profile or instructing credential changes.
- Run all deterministic package gates and one independent bounded implementation review.

**Full deterministic validation:**

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
git diff --check
```

The multi-skill mention probes remain outside the deterministic lane because Pi offline mode does not disable inference and those existing probes may call a provider. They are unrelated to this extension's changed behavior.

**Independent review:**

Review the exact implementation diff against the approved design and plan, with focused/full command evidence. Require causal findings only for public schema, Herdr command safety, target/session identity, prompt correlation, no-polling behavior, transfer isolation, Git postflight, cancellation, redaction, host cleanup, package independence, and truth accuracy.

The active Pi adjudicates every finding. At most one focused repair pass may modify only an already authorized causal file, followed by affected focused tests and the entire deterministic validation lane. A finding that requires provider auth, another repository, a new action, broader authority, automatic convergence, topology cleanup, or durable state returns `replan` or `redesign`.

**Completion evidence:**

- exact changed-file list and preservation of unrelated work;
- focused command results for each task;
- full deterministic command results;
- fake-Herdr command-count/order evidence proving no poll/retry/fallback;
- disposable-Git workspace matrix evidence;
- package and probe redaction evidence;
- review verdict, parent adjudications, any one repair, and rerun results;
- explicit statement that no live provider, real topology, credential, launch profile, global install, commit, push, publication, or deployment occurred.

**Done when:**

- stable truth matches verified runtime behavior;
- every deterministic command passes;
- review verdict is `pass` after at most one accepted repair;
- no accepted finding remains;
- optional live evidence is clearly separated.

**Recovery:** Fix forward before installation. Preserve only bounded fake responses or disposable repository reproducers. Do not reset the working tree, remove user Herdr resources, weaken assertions, or run a live agent to bypass a deterministic failure.

## LIVE-800 — Optional authority-gated native-agent canary

- **Depends on:** `HHO-700`, `G4`, `G5`
- **Execution:** manual checkpoint; not required for deterministic milestone acceptance
- **Repository writes:** only one disposable Git repository outside PE; no PE source mutation

**Preflight:**

- user explicitly authorizes one provider call, cost, and real Herdr topology mutation;
- selected harness is authenticated without changing credentials during the lane;
- user names an exact reviewed launch profile or exact existing agent target;
- disposable repository is clean, contains one bounded implementation task, and has no credential or external side-effect access;
- Pi and recipient integrations report identifiable lifecycle state;
- capture only fixed redacted evidence.

**Canary:**

1. invoke one `delegate-return` start or existing-target handoff;
2. require observed working then settled state without polling;
3. require one valid correlated return envelope;
4. independently inspect the actual changed file and run one deterministic check in Pi;
5. optionally send no repair; the canary stops after one implementation result;
6. leave or remove topology only under a separate explicit cleanup action outside this plan.

**Stop conditions:** authentication prompt, blocked approval, target mismatch, timeout, malformed return, scope violation, unexpected cost/route, or failed verification ends the lane. Do not retry, fall back, edit launch config, switch providers/models, answer approval, alter credentials, or widen the task.

**Evidence:** recipient kind, mode, lifecycle states, plan hash prefix, return correlation, workspace status, changed-path count, independent verification status, duration, and bounded usage/cost if the native harness exposes it without secrets.

A Grok-selected canary remains blocked until Grok is authenticated. Another explicitly selected authenticated harness may satisfy `G5`; authentication is always a user/manual prerequisite, not an implementation task.

## Cross-task verification map

| Protected boundary | Oracle | Fixture/environment | Owning suite | Failure meaning |
| --- | --- | --- | --- | --- |
| Public tool and result shape | Contract examples and state table | Pure TypeScript | contract suite | Caller-visible compatibility or authority defect |
| Launch profile ownership | Strict parser examples | Temporary agent dir | config suite | Wrong persistent owner, fallback, or argv leak |
| Request/return correlation | Contract/parser examples | Temporary repo and strings | envelope suite | Stale, injected, truncated, or unbounded result accepted |
| Herdr integration | CLI conformance adapter | Fake executable and command log | client suite | Wrong command, polling, duplicate send, cancellation, or protocol drift |
| Shared/isolated workspace | State and conflict examples | Disposable Git repos/worktrees | workspace suite | Scope/history/index/conflict evidence misclassified |
| End-to-end handoff state | Model/state-transition scenarios | Fake client + disposable Git | coordinator suite | Ownership, continuation, timeout, or transfer state defect |
| Pi host integration | Component tests | Fake ExtensionAPI | extension/render suites | Tool lifecycle, cleanup, guidance, or redaction defect |
| Package behavior | Contract and offline probes | Temporary/installed package with fake Herdr | package/probe suites | Extension coupling, install-shape, or ambient side effect |
| Native harness interoperability | Runtime canary | Explicitly authorized disposable repo | optional live lane | Real CLI/TUI integration gap, never pre-merge correctness alone |

Fast deterministic evidence owns merge readiness. The optional canary owns only live interoperability diagnosis. No test may weaken an exact error or negative path to make a harness fixture pass.

## Authority boundaries

Plan/design approval may authorize only repository-local source mutation and deterministic commands. It does not authorize:

- creating or changing `~/.pi/agent/herdr-handoff.json`;
- editing Herdr, Codex, Grok, Pi, or shell configuration;
- installing/reinstalling Herdr integrations or changing managed hooks;
- authenticating a provider or reading credentials;
- targeting an existing user's agent, starting a real agent, or creating real Herdr tabs/workspaces/worktrees;
- model/provider calls, cost, network side effects, package installation outside `npm ci`, global Pi installation, commit, push, publication, or deployment;
- cleanup that closes a pane or removes a worktree.

Every excluded action requires separate explicit authority. Tests must override `PATH`, HOME/agent directory, repository, and Herdr environment with disposable fixtures so deterministic validation cannot reach live state.

## Rollout and recovery

Implementation is additive and independently removable. Existing extensions remain operational if `herdr-handoff` is absent. Register the new entry only after its entrypoint tests pass. No staged global rollout is part of this plan.

Default recovery is fix forward:

- contract failure: preserve the smallest schema/state example;
- CLI failure: preserve one redacted fake response and command count;
- workspace failure: preserve one disposable Git reproducer;
- integration failure: preserve one fake-Pi action/result fixture;
- probe failure: preserve fixed counts/codes only.

No guarded rollback is needed because deterministic implementation does not install the extension or mutate live Herdr/user state. Do not use destructive Git reset, hook edits, config deletion, provider fallback, retries, or live-agent experiments as recovery.

If a real handoff later fails, preserve the isolated worktree unchanged for Pi/user inspection. Timeout or blocked state leaves a handle, cancellation revalidates identity and stops at logical interrupt, unconfirmed cancellation remains unresolved, and transfer remains recipient-owned. The extension never auto-restores or auto-cleans evidence.

## Truth synchronization

`HHO-700` updates only these stable owners after verified behavior exists:

- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/architecture/herdr-handoff.md`

The design and plan remain stage artifacts under `docs/plans/changes/`. They do not become runtime inputs. Existing `docs/architecture/subagents.md` is a verification input and should not need mutation because the new architecture document and top-level boundaries own the contrast. If a factual link is needed there, the active Pi must adjudicate it before widening the stable-truth write set.

No truth sync is due in `agent-skills`, global Herdr hooks, or user launch configuration.

## Work-package readiness

- `milestone_objective`: one explicit, bounded, non-polling full-agent handoff bridge while Pi retains semantic convergence.
- `non_goals`: subagent integration, hard full-agent sandboxing, automatic retry/fallback/approval/repair/merge/cleanup, durable orchestration, provider setup, and external delivery.
- `future_phases`: structured return file, durable recovery, automatic convergence, cleanup, and concurrent handoffs only under recorded triggers.
- `decision_status`: `ready_for_approval`; `G0` and `G1` block implementation.
- `oracle_strategy`: public contract examples, state-transition tests, fake Herdr CLI conformance, disposable Git workspaces, fake Pi integration, offline package probes, and optional live canary.
- `acceptance_oracles`: each task's command and done conditions plus `HHO-700` full lane.
- `review_budget`: one design review, one plan review, and one implementation review with at most one focused accepted repair at each applicable stage.
- `failure_policy`: fail closed with typed evidence; no polling, retry, route fallback, permission escalation, scope expansion, or destructive cleanup.
- `delegation_readiness`: `HHO-100..HHO-600` are ready as one serial full-agent package only after `G0`, `G1`, `G3`, exact preflight write-set enumeration, and a distinct isolated worktree; `HHO-700` remains parent-owned.
- `manual_checkpoint`: optional live canary remains blocked by `G4` and selected-harness `G5`; Grok is currently unauthenticated, without blocking deterministic implementation.

## Review decision

Independent review is required because this plan introduces a public tool, persistent external processes, user-owned native argv, cooperative writes, linked-worktree topology, stateful continuations, cancellation, and one-way ownership transfer.

The independent reviewer returned `needs plan revision` with five causal candidates. Four were accepted directly and one exposed a design ambiguity repaired in the controlling design. The focused plan repair adds a separate real-Herdr implementation-delegation gate; adds an independent sanitized Herdr 0.8.2 protocol/response contract fixture; aligns existing dirty-worktree behavior with complete delegate-return baselines; keeps missing-parent rejection now that the design explicitly requires a real existing parent directory; and makes live authentication conditional on the selected harness rather than Grok globally.

Rechecking design hash and fidelity, prerequisites, task dependencies, write ownership, delegated-package readiness, deterministic versus live oracles, authority, recovery, and truth sync yields `pass`. Review success does not approve implementation.

## Approval request

`decision_state = ready_for_approval`. Approval should explicitly cover the exact design hash, this plan, repository-local mutation in the declared PE surfaces, and deterministic fake/offline verification. A separate `G3` grant is required if the active Pi may delegate `HHO-100..HHO-600` to one real external full agent through Herdr, and it must name the exact target or profile plus provider-cost and topology authority.

Live canary use, authentication changes, user launch-profile creation, global installation, commit, push, publication, deployment, and destructive cleanup remain separately unauthorized.
