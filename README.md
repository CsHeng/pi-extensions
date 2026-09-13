# Pi Extensions

This repository contains small, independently removable Pi extensions. It exports eight maintained extensions: `plan-mode`, `multi-skill-mentions`, `fast-gpt`, `subagents`, `subagents-ui`, `herdr-handoff`, `status-footer`, and `work-timing`, while preserving Pi's authoritative host agent loop. `subagents-ui` is default-loaded as a TUI-only read-only observer.

## Plan Mode

`/plan` switches the current session to Pi's read-only `read`, `grep`, `find`, and `ls` tools and appends a compact planning instruction before model turns. `/default` restores the exact tool set that was active before plan mode. The `--plan` startup flag selects the same profile.

The extension stores only the selected profile and the tool set to restore. It does not own workflow phases, task graphs, review policy, approval gates, tool authorization, or settlement. Those decisions remain with the active coding agent, the user, and Pi's host loop.

## Multi-skill Mentions

Type `$` in the TUI to search loaded skills and insert one or more `$skill-name` mentions. On submission, the extension expands each uniquely mentioned loaded skill before the original prompt. Unknown names, escaped mentions such as `\$skill-name`, and ordinary shell variables remain unchanged.

`/skill-mentions` shows a short usage reminder and the number of currently loaded skills. The extension does not discover skills independently; Pi's command registry remains authoritative for available skill names and source paths.

## Fast GPT

`/fast-gpt` toggles a branch-local request profile between priority and explicit default service tiers. The extension leaves requests untouched until the first command. In priority mode it adds top-level `service_tier: priority` to correlated official OpenAI and OpenAI-Codex Responses requests; the next toggle sends top-level `service_tier: default`. Unsupported provider, API, or model correlations remain unchanged.

This is only a request payload profile. Its keyed status is a lightning mark confirming that priority was requested, not that the provider served it. Pi's extension API does not expose the final response body's `service_tier`, and the OpenAI-Codex endpoint has an additional response-accounting caveat. Pi and provider-side billing remain authoritative for usage and cost. The extension supplies no model alias, provider override, pricing parser, live call, or workflow behavior. See [`docs/architecture/fast-gpt.md`](docs/architecture/fast-gpt.md) for state, correlation, response observability, ownership, and removal contracts.

## Subagents

`csheng_subagent_sessions` is the registered model-callable foreground delegation tool. It supports explicit `create`, `continue`, `inspect`, `apply`, and `close` for explorer, reviewer, and worker tasks. Ordinary delegation is a flat create batch; optional hard predecessor edges support approved implementation order with no intervening parent decision. Dependency edges pass predecessor reports, not candidate files. File-dependent successors require explicit parent `apply` between dispatches. The parent Pi supplies the tasks and retains synthesis, verification, review adjudication, repair decisions, continuation, candidate application, acceptance, and the final response.

Fixed roles are:

- `explorer`: read-only factual search with `read`, `grep`, `find`, and `ls`
- `reviewer`: read-only candidate findings with the same tools
- `worker`: trusted-host implementation with native `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`

Managed workers require `scope: ["."]` and add trusted host `bash` to the native file/search tools. Each episode is a new foreground process using retained native history, private source, private Git index, and independently copied declared dependencies. Candidates are returned for explicit parent apply, never auto-accepted or auto-converged. Directory/guard/diff checks are not an OS sandbox or restrictions on bash's host permissions. Close releases open-record slots, not all retained history; discard keeps native/registry evidence. Managed-root storage above 8 GiB or 1,000,000 filesystem entries produces best-effort advisory warnings, not a quota refusal or automatic cleanup; per-workspace, native-row, file and integrity bounds still apply. Cleanup is optional: close unneeded handles with `disposition: "discard"` to remove their working files while keeping registry/native history. For a full reset, stop all Pi/subagent processes using the agent directory, then back up and remove `<agent-dir>/subagent-managed-sessions` (default `~/.pi/agent/subagent-managed-sessions`); this loses retained histories, candidates and replay records. See [`docs/architecture/subagent-execution.md`](docs/architecture/subagent-execution.md) for replay, branch ownership, storage, partial apply, and recovery.

Live tool progress uses `Subagents {running}/{total} running, {finished} finished · {turns} turns · {clock}`. The core also publishes bounded `csheng.subagents.observer.v2` snapshots for TUI observers. Default-loaded `subagents-ui` is a read-only content-fitted floating panel toggled with `/subagents-ui` or `Ctrl+Alt+F`; it paints its rows with the theme's selected background, shows a pinned `Subagents · <phase>` title row with a `[ ✕ ]` close chip, keeps an 80-column floor without filling the terminal, and carries a rule plus a dim key footer. Keyed footer status and the below-editor widget stay off by default, and this observer never appends completion entries. Bounded overlay status shows a two-line task block: role, turns, and truncated assignment headline, then provider/model/thinking, status, elapsed time, and current tools. `status-footer` and `work-timing` remain independent. Managed results distinguish request and episode outcomes, stored state, report completeness, and apply facts. A failure the extension cannot type keeps the `managed_operation_failed` code plus a bounded, path-free `detail` reason (errno code or error name) instead of an opaque code. Acceptance remains a parent judgment, not a runtime result field or warning.

Loading the core extension registers `csheng_subagent_sessions`, `/subagents` status, the ephemeral current-owner index, observation hooks, and the observer publisher. It starts no child and changes no workspace until the parent calls the tool. It does not register historical one-shot `csheng_subagents`, `/subagents-debug`, or snapshot UI v1. Dispatch requires a trusted project whose cwd is a Git worktree. After that trust check, task `scope` is canonicalized against the Git toplevel so physically contained absolute or parent-traversing spellings become repository-relative paths; unsafe, inaccessible, or escaping targets fail before launch. A missing internal target remains admissible when its nearest existing ancestor is physically contained, preserving absence checks and exact create-file workers. Explorer and reviewer tasks may also declare at most eight exact absolute `externalReadRoots` that already exist inside another Git worktree. Those roots are private prompt and session evidence only: the extension does not load the target's project resources, change child cwd, or grant writes. `plan-mode` continues to expose only its original four tools, so subagent dispatch is unavailable while that profile is active.

The repository ships its route baseline at [`config/csheng-subagents.json`](config/csheng-subagents.json). It prefers explorer Luna medium, worker Terra high, and reviewer Sol high, with explicit peer fallback order, global concurrency 10, per-role defaults `4/4/2`, reasoning-profile mappings, and `aggressive` guidance. Model names remain opaque configuration; extension code does not rank the peer families.

The optional user override is `csheng-subagents.json` under Pi's agent directory, normally `~/.pi/agent/csheng-subagents.json`. An absent override applies the package baseline. A strict overlay may replace role candidates, add execution-profile candidate lists, override reasoning-profile entries, or replace global and per-role concurrency with positive safe integers. When role capacities sum above the global value, the scheduler uses the global value as the launch limit instead of rejecting the configuration. Package and user files are read-only persistent defaults: the extension never creates, edits, or deletes them.

Tasks may provide optional provider-neutral `executionProfile` and `reasoningProfile` values; missing or unmapped values visibly use the role default. When the user explicitly selects a concrete model or Pi thinking level, any role may also receive ephemeral `model` and `thinking` task fields. Exact explicit selection resolves against Pi's model registry, overrides role/profile defaults, and either launches that route or returns a typed pre-launch failure with no fallback. The extension never reads a plan or Skill. This serves the model-routing purpose of per-role Codex agent files, but the extension does not read `~/.codex/agents/*.toml`: Pi role prompts and tool ceilings remain code-owned, while JSON contains persistent routing defaults only. The package never changes the parent session model or provider settings.

Historical one-shot `csheng_subagents` auto-apply, `/subagents-debug`, and snapshot UI v1 are not current runtime surfaces. Their remaining meaning is evaluator and architecture reading, not a registered tool. See [`docs/architecture/subagents.md`](docs/architecture/subagents.md) for the three-owner boundary, routing, scheduling, isolation, telemetry, evaluation, failure behavior, removal, and that historical contract.

## Herdr Handoff

`herdr_handoff` is an explicit-user-only bridge to one persistent vendor-native coding agent managed by Herdr. Pi remains the plan, verification, review-adjudication, repair, truth-sync, and closure owner. The extension waits without polling, parses an untrusted return envelope, and records Git postflight in a distinct linked worktree. It does not sandbox the full agent, auto-converge isolated output, or treat recipient settlement as completion.

`mode` is required; `delegate-return` is the preferred handoff pattern: Pi freezes the plan, waits for settlement, then resumes with evidence. `transfer` waits only until Herdr confirms prompt delivery and an observed `working` transition, then relinquishes outcome ownership. Targets are exact: message one already-running named agent, or `start-and-ask` with one user-owned launch profile from `herdr-handoff.json` under Pi's agent directory. There is no package profile, no project overlay, and no fallback to `csheng_subagent_sessions` or another harness.

Recipient write authority is cooperative. First-release recipients must occupy a distinct linked worktree of the same Git repository. Postflight accepts only declared regular-file create or modify operations. Timeout, blocked UI, malformed return, and unconfirmed cancellation return typed handles rather than widening authority.

`/herdr-handoff` reports redacted environment and handle status. `plan-mode` continues to expose only its original four tools, so the handoff tool is inactive while that profile is selected. The official `herdr` Skill remains optional manual guidance and is not a runtime dependency.

See [`docs/architecture/herdr-handoff.md`](docs/architecture/herdr-handoff.md) for the request/return protocol, launch profiles, workspace evidence, cancellation, failure, redaction, and removal contracts.

## Status Footer

`status-footer` replaces the TUI footer with one compact line: `Grok 4.6 high (xai sub) | ~/project (main) | <session-uuid> | ↑952k ↓62k R13M CH99.7% $8.979 | 270k/500k (54.0%) | MCP 2/2`. Subscription status sits in the model parentheses; the branch comes from Pi's footer data and disappears outside a repository; `R`/`W` are cache read/write and `CH` is the latest prompt cache-hit rate. When the `fast-gpt` keyed status is present, a warning-colored ⚡ sits after thinking, as in `GPT-5.4 high ⚡ (openai sub)`. Narrow terminals first wrap into two semantic rows — identity and workdir, then session id and metrics — and each row then shrinks the workdir and traffic first, then other optional fields, preserving the full UUID whenever it fits alone. Identity and traffic use a fixed palette; separators, context/MCP indicators, and lower thinking levels use the active Pi theme. Other extension statuses are not shown. The extension is inactive in RPC, JSON, and print modes and stores no state.

## Work Timing

`work-timing` replaces the active TUI working label and appends one completion entry when the agent settles; both count the span of the current user message, meaning every model turn and tool call it triggered, while the footer keeps its own session-cumulative counters. Durations use carried `h`, `m`, and `s` units, such as `1h 1m 1s`, and non-zero sub-second reasoning renders `<1s` so it never contradicts its share. The live label is `Working... 12s • ↑ 17,234 ↓ 4,321 tokens • R 3s / ΣR 16s • 720 tok/s`: elapsed wall time and upstream/downstream tokens (`↑` provider `usage.input`, `↓` provider `usage.output` or the chars/4 estimate of streamed text, thinking, and tool-call arguments) accumulate for that user message and stay visible while tools run, `R` is the current turn's reasoning, and `ΣR` the reasoning accumulated across its turns. The TUI-only entry repeats the field order with everything cumulative — `Worked for 12s • ↑ 17,234 ↓ 4,321 tokens • ΣR 16s (45%) • 720 tok/s` — and never enters model context. One formatter writes the working line at two cadences: the one-second clock samples elapsed time, `R`, and `ΣR` together, while stream events refresh tokens and `tok/s` immediately using those cached durations. Lifecycle edges can refresh the full sample; settlement renders final values once. Both cadences use the same complete format, and unchanged text is not republished. Narrow terminals fold the live label and the settled entry at ` • ` field boundaries only, using the host's terminal width (`process.stdout.columns`, falling back to `COLUMNS` then 80) minus the loader padding, and resizes repaint immediately. Only one extension should own this row: when using pi-cc-extensions, turn its `enableWorkingMessage` feature off rather than trying to out-refresh it. `tests/work-timing-tui.test.ts` checks the installed Pi/CC TUI with a synthetic provider and disposable settings, without modifying user configuration. `tok/s` is decode throughput: output tokens from turns that actually streamed, divided by first-token-to-pause time. Each turn starts the decode clock on `thinking_start` or the first `thinking_delta` / `text_delta` / `toolcall_delta`, then runs through thinking and stream stalls until assistant `message_end` or the first `tool_execution_start`, so TTFT, tool execution, usage-only turns, and the gap between turns do not count. It is omitted while decode time or streamed output tokens are still zero; an unreported `↑`/`↓` side is omitted, collapsed and expanded states render the same entry line, and version-one entries render without the cumulative token segment. RPC, JSON, and print modes do not run or persist this display timer.

## Package

The private package exposes exactly:

```text
extensions/plan-mode/index.ts
extensions/multi-skill-mentions/index.ts
extensions/fast-gpt/index.ts
extensions/subagents/index.ts
extensions/herdr-handoff/index.ts
extensions/status-footer/index.ts
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

Daily Pi should load the local package snapshot at `~/.pi/agent/packages/csheng-pi-extensions`, not this checkout and not `~/.pi/agent/extensions/`. Publish with `mise run publish-local-package`. First-time install is `pi install` of that snapshot after removing the checkout path from user packages. Restart Pi after publishing; `pi update --extensions` does not refresh local-path packages.

Temporary-load and installed-package probes live under `scripts/`. Plan-mode, subagent, and herdr-handoff probes use RPC fixtures without model calls. The small fast-gpt, status-footer, and work-timing boundaries are owned by deterministic unit tests and add no probe commands. The multi-skill mention probes use Pi print mode, cross model/provider preflight, and may make a model call when authentication is available; `PI_OFFLINE=1` disables update traffic but does not disable inference. Run those probes only with explicit provider-call authority.

The six offline probes bind temporary loading or installed-host package discovery to this checkout; installed-host success does not mean the real installed package was updated. `tests/subagents-cc-tui.test.ts` separately exercises the real installed Pi/CC on and compact TUI through a PTY with a synthetic provider and disposable settings, and `npm run e2e:subagents-ui` runs the deliberate installed-Pi fullscreen close-marker click check from `tests/subagents-ui-tui.e2e.ts`. They explicitly skip when their local PTY prerequisites are absent; see [`docs/architecture/subagents-ui.md`](docs/architecture/subagents-ui.md) for the evidence boundary.

The opt-in live subagent E2E uses Pi's ambient authentication and is separately authorized. Parent owns acceptance of that lane. This document does not treat it as verified package co-load or as a current one-shot runtime proof:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

The first command temporary-loads the complete package with ordinary global extensions disabled. The second uses the globally installed package. Both make real model calls and emit only a bounded summary. Global installation, user route creation, provider calls, and settings changes remain explicit gates and are never performed by `npm test`.

Maintainers can evaluate an explicitly selected persisted run or an explicit current-epoch scan with `.agents/skills/evaluate-subagent-runs/`. Metric schema version four distinguishes tool wall time, scheduler span, worker effort, occupied interval wall, and overlapping wait reasons while preserving older telemetry meanings and explicit unavailable evidence. Current-epoch filtering accepts schema-three and schema-four one-shot provenance. Legacy counters remain historical `csheng_subagents-only` one-shot totals; they do not describe the registered managed tool. The separate `managedDispatch` section counts v2 owned invocations, refusals, launches, and replay, with explicit excluded/unassigned provenance; historical v1 results never gain inferred ownership or missing revision pairs. The `observations` section consumes owned native ranges, deduplicates replay/inspection and parent/child usage, and reports independently nullable command, capability, reasoning, and compaction evidence. Child costs are not currently forwarded through Pi's top-level tool-result `usage`, so the main footer and `/session` total do not include these child charges; evaluator totals have a separate recorded-evidence scope. Explicit parent disposition can be supplied for one entry range; report/apply never implies acceptance. The extractor remains redacted and does not retain raw model selectors, prompts, task IDs, child output, paths, credentials, epoch identifiers, or external content.

## Safety

If a future Pi release does not expose one of the declared plan-mode read-only tools, plan mode activates only the available subset and reports the mismatch. Fast-gpt leaves unsupported request correlations unchanged and defers usage and cost truth to Pi and the provider response. Subagent graph, route, path, storage, process, and candidate failures return typed bounded evidence and do not widen authority or trigger hidden retries. Herdr handoff failures return typed bridge, recipient, and workspace evidence without treating settlement as verification or falling back to another agent. Probe output contains fixed redacted fields rather than prompts, user settings, credentials, or external file content.
