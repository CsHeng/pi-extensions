# Pi Extensions

This repository contains small, independently removable Pi extensions. It exports `plan-mode`, `multi-skill-mentions`, `fast-gpt`, `subagents`, `subagents-ui`, `herdr-handoff`, `session-id-footer`, and `work-timing` while preserving Pi's authoritative host agent loop.

## Plan Mode

`/plan` switches the current session to Pi's read-only `read`, `grep`, `find`, and `ls` tools and appends a compact planning instruction before model turns. `/default` restores the exact tool set that was active before plan mode. The `--plan` startup flag selects the same profile.

The extension stores only the selected profile and the tool set to restore. It does not own workflow phases, task graphs, review policy, approval gates, tool authorization, or settlement. Those decisions remain with the active coding agent, the user, and Pi's host loop.

## Multi-skill Mentions

Type `$` in the TUI to search loaded skills and insert one or more `$skill-name` mentions. On submission, the extension expands each uniquely mentioned loaded skill before the original prompt. Unknown names, escaped mentions such as `\$skill-name`, and ordinary shell variables remain unchanged.

`/skill-mentions` shows a short usage reminder and the number of currently loaded skills. The extension does not discover skills independently; Pi's command registry remains authoritative for available skill names and source paths.

## Fast GPT

`/fast-gpt` toggles a branch-local request profile between priority and explicit default service tiers. The extension leaves requests untouched until the first command. In priority mode it adds top-level `service_tier: priority` to correlated official OpenAI and OpenAI-Codex Responses requests; the next toggle sends top-level `service_tier: default`. Unsupported provider, API, or model correlations remain unchanged.

This is only a request payload profile. Its status confirms that priority was requested, not that the provider served it. Pi's extension API does not expose the final response body's `service_tier`, and the OpenAI-Codex endpoint has an additional response-accounting caveat. Pi and provider-side billing remain authoritative for usage and cost. The extension supplies no model alias, provider override, pricing parser, live call, or workflow behavior. See [`docs/architecture/fast-gpt.md`](docs/architecture/fast-gpt.md) for state, correlation, response observability, ownership, and removal contracts.

## Subagents

`csheng_subagents` is a model-callable foreground delegation tool for one bounded task batch. Ordinary delegation is a flat batch; optional hard predecessor edges support approved implementation order with no intervening parent decision. The tool supports deterministic fan-out, dependency joins, resource locks, default per-role model routes, isolated writable workers, bounded output, and cancellation. The parent Pi supplies the tasks and retains synthesis, verification, review adjudication, repair decisions, continuation, and the final response.

Fixed roles are:

- `explorer`: read-only factual search with `read`, `grep`, `find`, and `ls`
- `reviewer`: read-only candidate findings with the same tools
- `worker`: exact-file create or modify with `read`, `grep`, `find`, `ls`, `edit`, and `write`; no shell, deletion, or recursive delegation

`subagents-ui` is an independently removable TUI consumer. It listens for bounded lifecycle snapshots, shows keyed status and a below-editor panel, opens a live inspector with `Ctrl+Alt+F` or `/subagents-ui`, and can request confirmed run or task cancellation. It never writes the working row or footer. Removing it does not change `csheng_subagents` execution.

Loading the core extension registers the tool, `/subagents` status command, `/subagents-debug` diagnostic command, and delegation guidance. It starts no child and changes no workspace until the parent calls the tool. Dispatch requires a trusted project whose cwd is a Git worktree. After that trust check, task `scope` is canonicalized against the Git toplevel so physically contained absolute or parent-traversing spellings become repository-relative paths; unsafe, inaccessible, or escaping targets fail before launch. A missing internal target remains admissible when its nearest existing ancestor is physically contained, preserving absence checks and exact create-file workers. Explorer and reviewer tasks may also declare at most eight exact absolute `externalReadRoots` that already exist inside another Git worktree. Those roots are private prompt and session evidence only: the extension does not load the target's project resources, change child cwd, or grant writes. `plan-mode` continues to expose only its original four tools, so subagent dispatch is unavailable while that profile is active.

Every launched child writes a private standard Pi session JSONL beneath `<agent-dir>/subagent-sessions/<parent-session>/<run>/<task>.jsonl`, normally `~/.pi/agent/subagent-sessions/...`. This sibling root stays outside Pi's ordinary `sessions/` discovery tree, so `/resume` remains focused on user sessions. `/subagents-debug` shows a bounded read-only metadata timeline and local path without exposing prompts, assistant text, tool arguments, or tool-result content to the parent model. Explicitly opening that path with `pi --session` creates an ordinary continuable Pi session, not a resumed subagent mission; worker snapshots, locks, scheduling, and convergence state are not retained.

Diagnostic evidence is retained for 30 days subject to a 512 MiB total-root admission ceiling, a reserved 256 MiB allowance per active or stale-active run, and 32 MiB per child. Cleanup removes expired then oldest settled runs only. Active and stale-active markers are never deleted automatically; a stale marker remains visible through `/subagents-debug --all` and can block new dispatch until the user inspects and explicitly removes the inactive run.

The repository ships its route baseline at [`config/csheng-subagents.json`](config/csheng-subagents.json). It prefers explorer Luna medium, worker Terra high, and reviewer Sol high, with explicit peer fallback order, global concurrency 10, per-role defaults `4/4/2`, reasoning-profile mappings, and `aggressive` guidance. Model names remain opaque configuration; extension code does not rank the peer families.

The optional user override is `csheng-subagents.json` under Pi's agent directory, normally `~/.pi/agent/csheng-subagents.json`. An absent override applies the package baseline. A strict overlay may replace role candidates, add execution-profile candidate lists, override reasoning-profile entries, or replace global and per-role concurrency with positive safe integers. When role capacities sum above the global value, the scheduler uses the global value as the launch limit instead of rejecting the configuration. Package and user files are read-only persistent defaults: the extension never creates, edits, or deletes them.

Tasks may provide optional provider-neutral `executionProfile` and `reasoningProfile` values; missing or unmapped values visibly use the role default. When the user explicitly selects a concrete model or Pi thinking level, any role may also receive ephemeral `model` and `thinking` task fields. Exact explicit selection resolves against Pi's model registry, overrides role/profile defaults, and either launches that route or returns a typed pre-launch failure with no fallback. The extension never reads a plan or Skill. This serves the model-routing purpose of per-role Codex agent files, but the extension does not read `~/.codex/agents/*.toml`: Pi role prompts and tool ceilings remain code-owned, while JSON contains persistent routing defaults only. The package never changes the parent session model or provider settings.

Workers operate in private snapshots of tracked and non-ignored repository files. The extension accepts only declared create-or-modify results and applies them after exact parent-baseline checks. Parent drift, undeclared changes, symlink writes, deletion, rename, mode changes, or a true zero-diff worker fail closed. Every role now uses the canonical Git toplevel as the repository-relative basis; worker snapshots, exact writes, and convergence remain single-repository. While children run, bounded event updates and a five-second heartbeat expose the effective `provider/model:thinking` route, phase, turn count, active tool names, cumulative intermediate error count, elapsed time, and inactivity age. Tool-call errors remain evidence on a running child and do not change its lifecycle phase or determine its final task status. `agent_settled` starts a ten-second process-exit grace; a child that does not close returns `child_exit_stalled` after TERM/KILL escalation.

See [`docs/architecture/subagents.md`](docs/architecture/subagents.md) for the three-owner boundary, complete tool contract, routing, scheduling, isolation, telemetry, evaluation, failure behavior, and removal semantics.

## Herdr Handoff

`herdr_handoff` is an explicit-user-only bridge to one persistent vendor-native coding agent managed by Herdr. Pi remains the plan, verification, review-adjudication, repair, truth-sync, and closure owner. The extension waits without polling, parses an untrusted return envelope, and records Git postflight in a distinct linked worktree. It does not sandbox the full agent, auto-converge isolated output, or treat recipient settlement as completion.

`delegate-return` is the default: Pi freezes the plan, waits for settlement, then resumes with evidence. `transfer` waits only until Herdr confirms prompt delivery and an observed `working` transition, then relinquishes outcome ownership. Targets are exact: message one already-running named agent, or `start-and-ask` with one user-owned launch profile from `herdr-handoff.json` under Pi's agent directory. There is no package profile, no project overlay, and no fallback to `csheng_subagents` or another harness.

Recipient write authority is cooperative. First-release recipients must occupy a distinct linked worktree of the same Git repository. Postflight accepts only declared regular-file create or modify operations. Timeout, blocked UI, malformed return, and unconfirmed cancellation return typed handles rather than widening authority.

`/herdr-handoff` reports redacted environment and handle status. `plan-mode` continues to expose only its original four tools, so the handoff tool is inactive while that profile is selected. The official `herdr` Skill remains optional manual guidance and is not a runtime dependency.

See [`docs/architecture/herdr-handoff.md`](docs/architecture/herdr-handoff.md) for the request/return protocol, launch profiles, workspace evidence, cancellation, failure, redaction, and removal contracts.

## Session ID Footer

`session-id-footer` keeps Pi's built-in TUI footer and appends the current session UUID to its first line. Long working-directory text is truncated before the session label so the identifier remains visible when terminal width permits. The extension is inactive in RPC, JSON, and print modes and stores no state.

## Work Timing

`work-timing` replaces the active TUI working label with client-observed timing for the current model turn's reasoning, reasoning accumulated across the active user interaction, and total elapsed time through final settlement. Durations use carried `h`, `m`, and `s` units, such as `1h 1m 1s`. On `agent_settled`, the loading row disappears and a TUI-only `Worked for 18s • reasoning 7s (39%)` entry is persisted in the session without entering model context; expanded rendering also shows last-turn reasoning. RPC, JSON, and print modes do not run or persist this display timer.

## Package

The private package exposes exactly:

```text
extensions/plan-mode/index.ts
extensions/multi-skill-mentions/index.ts
extensions/fast-gpt/index.ts
extensions/subagents/index.ts
extensions/herdr-handoff/index.ts
extensions/session-id-footer/index.ts
extensions/work-timing/index.ts
extensions/subagents-ui/index.ts
```

Each extension keeps independent behavior, state, tests, and removal semantics while sharing one Pi package.

## Documentation

`docs/architecture/` owns stable extension truth, `docs/evaluations/` retains bounded redacted evidence, and `docs/plans/` retains stage history outside default documentation search. See [`docs/README.md`](docs/README.md) for the search boundary.

## Local Development

```bash
npm ci --ignore-scripts
npm run check
```

Temporary-load and installed-package probes live under `scripts/`. Plan-mode, subagent, and herdr-handoff probes use RPC fixtures without model calls. The small fast-gpt, session-footer, and work-timing boundaries are owned by deterministic unit tests and add no probe commands. The multi-skill mention probes use Pi print mode, cross model/provider preflight, and may make a model call when authentication is available; `PI_OFFLINE=1` disables update traffic but does not disable inference. Run those probes only with explicit provider-call authority.

The opt-in live subagent E2E uses Pi's ambient authentication, creates and removes a disposable Git repository under `~/tmp`, loads all package extensions together, and requires the three package-default role routes plus successful `explorer`, `reviewer`, and converged `worker` results:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

The first command temporary-loads the complete package with ordinary global extensions disabled. The second verifies the globally installed package. Both make real model calls and emit only a bounded summary. Global installation, user route creation, provider calls, and settings changes remain explicit gates and are never performed by `npm test`.

Maintainers can evaluate an explicitly selected persisted run or an explicit current-epoch scan with `.agents/skills/evaluate-subagent-runs/`. Metric schema version three adds selection mode, current-epoch filtering, and schema-three start/provenance fields while reading older telemetry with explicit unavailable evidence. The extractor remains redacted and does not retain raw model selectors, prompts, task IDs, child output, paths, credentials, epoch identifiers, or external content.

## Safety

If a future Pi release does not expose one of the declared plan-mode read-only tools, plan mode activates only the available subset and reports the mismatch. Fast-gpt leaves unsupported request correlations unchanged and defers usage and cost truth to Pi and the provider response. Subagent graph, route, path, diagnostic-storage, process, and convergence failures return typed bounded evidence and do not widen authority or trigger hidden retries. Herdr handoff failures return typed bridge, recipient, and workspace evidence without treating settlement as verification or falling back to another agent. Probe output contains fixed redacted fields rather than prompts, user settings, credentials, or external file content.
