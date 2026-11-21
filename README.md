# Pi Extensions

This repository contains small, independently removable Pi extensions. It exports thirteen maintained extensions: `multi-skill-mentions`, `fast-gpt`, `agents`, `agents-ui`, `status-footer`, `work-timing`, `tasklist`, `notices`, `tasks-ui`, `jobs-ui`, `agent-bark`, `async-bash`, and `cache-keepalive`, while preserving Pi's authoritative host agent loop. `agents-ui` is default-loaded as a TUI-only read-only observer.

## Multi-skill Mentions

Type `$` in the TUI to search loaded skills. A leading selection prefix accepts repeated or mixed `$skill-name` and `/skill:name` tokens in either order; dollar mentions elsewhere still select loaded Skills and preserve the user's prose. Selections deduplicate in encounter order. Multiple selections use one native-compatible card showing every selected name, with each actual path, reference base and body preserved. Unknown names, escaped mentions such as `\$skill-name`, ordinary shell variables and non-leading slash prose remain literal. A read failure restores the original input and discards the partial selection.

`/skill-mentions` shows a short usage reminder and the number of currently loaded skills. Pi's command registry supplies the extension's authoritative available skill names and source paths.

## Fast GPT

`/fast-gpt` toggles a branch-local request profile between priority and explicit default service tiers. The extension leaves requests untouched until the first command. In priority mode it adds top-level `service_tier: priority` to correlated official OpenAI and OpenAI-Codex Responses requests; the next toggle sends top-level `service_tier: default`. Unsupported provider, API, or model correlations remain unchanged.

This is only a request payload profile. Its keyed status is a lightning mark confirming that priority was requested; provider service requires separate evidence. The final response body's `service_tier` remains unavailable through Pi's extension API, and the OpenAI-Codex endpoint has an additional response-accounting caveat. Pi and provider-side billing remain authoritative for usage and cost. Model aliases, provider overrides, pricing parsers, live calls, and workflow behavior remain outside the extension's scope. See [`docs/architecture/fast-gpt.md`](docs/architecture/fast-gpt.md) for state, correlation, response observability, ownership, and removal contracts.

## Agents

Start a named agent with `invoke_agent`: choose a role and a name, give it an assignment prompt, and grant read or write access over absolute paths. Agents have separate native conversations and can work in parallel. Write includes read, and a single assignment can span multiple Git checkouts. The main agent assigns outcomes, follows progress and accepts the work with the user; agents can coordinate findings and repairs directly within their briefs.

Use `message_agent` to reach an agent by name. A running agent reads the message at its next model call; an idle agent starts a turn whose result returns to the sender. The result of an already-running turn still goes to its original initiator. Results delivered to peers do not start another turn. Use `list_agents` to see the roster or read a named report, and `wait_agents` to wait within a time budget. The main agent can read any report; an agent can read its own assignees' reports and see peer summaries according to its roster capability. Messages to the main agent are identified as agent messages, distinct from user instructions or approval.

Writers share the granted checkouts by default. Give parallel writers distinct files or responsibilities and review their working-tree changes alongside existing uncommitted work. `stop_agent` stops the turn and can revert last-turn file-tool writes that still match what the agent left; shell changes remain unattributed. Use `release_agent` after settlement to keep or discard private working resources. The name stays bound for the rest of the main session.

Choose `workspace: "isolated"` when you want a private Git worktree for each writable repository and explicit integration. A successful changed turn can yield one candidate bundle. Use `agent_candidate` to apply, refresh or discard by name, after seeing the latest result. Integration preserves parent staging and reports partial progress per root. Confirm the result before accepting it. Native file and typed Git operations enforce granted ranges; trusted shell and third-party tools retain host privileges.

`explorer`, `reviewer` and `worker` ship with shared workspace, messages to their assigner and peers, roster visibility and permission to invoke within their grants. Other roles can come from Pi's `agent-roles/` or a trusted project's `.pi/agent-roles/`. An invocation can override the role's coordination settings with `may`. The [routing baseline](config/agent-routes.json) and optional user-owned `agent-routes.json` configure routes by role name; `/agents` shows the available roles, routing and limits. Use optional execution or thinking profiles for preferences. An explicit user choice of model or thinking applies only to the invocation and fails visibly if unavailable.

In the TUI, `/agents-ui` toggles the above-editor section independently of Tasks and Jobs. `/agents-ui list` and `Ctrl+Alt+F` open the floating panel. Fresh running agents stay above retained history; press H to expand history, PageUp/PageDown to change pages and Enter to see the selected turn's details. The panel shows role, name, route, activity or outcome, elapsed time and available recorded usage. See [Agents UI](docs/architecture/agents-ui.md) for coverage and navigation.

The source uses collaboration contract version 5. Version 4 records remain untouched; the retired `agent` tool has no alias. An agent keeps one native history in `sessions/<parent-project>/agents/` across turns; registries, provenance and any isolated resources live under `managed-agents/`. See [Agents](docs/architecture/agents.md) and [Agent Execution](docs/architecture/agent-execution.md) for access, roles, telemetry, recovery and the [historical usage export](docs/architecture/agent-execution.md#historical-usage-export).

## Status Footer

`status-footer` replaces the TUI footer with one compact line: `Grok 4.6 high (xai sub) | ~/project (main) | <session-uuid> | ↑952k ↓62k R13M CH97.4% $8.979 RB2 31k $0.084 | ✻ 2m10s TTFT 8.1s 25 tok/s | 270k/500k (54.0%) | MCP 2/2`. It is the session lane of the [usage metrics](docs/architecture/usage-metrics.md): every metric is a pure function of the persisted session entries, so a request moves it only when Pi persists that request's assistant message. Subscription status sits in the model parentheses; the branch comes from Pi's footer data and disappears outside a repository; `R`/`W` are cache read/write and `CH` is the session cache-hit rate weighted by prompt tokens across all assistant prompts (the latest request's rate belongs to the working row). `RB` after cost is the session's cumulative cache re-bill count, re-billed tokens and extra dollars, computed exactly as Pi's `/session` "Cache Re-billed" (dollars omitted when the recorded amount is zero, such as on subscriptions); it separates re-bill losses from ordinary new input. `✻ TTFT tok/s` are the session's thinking total, mean time to first token and output tokens per second of request duration, joined read-only from `work-timing` request entries; when those entries are absent only `✻` and `TTFT` are omitted. `$` excludes Pi cache-warming and cache-keepalive usage. When the `fast-gpt` keyed status is present, a warning-colored ⚡ sits after thinking, as in `GPT-5.4 high ⚡ (openai sub)`. Narrow terminals wrap field by field — each field flows onto the next row only when it exceeds the remaining whitespace — adding rows and preserving fields, and truncate a row only when a lone segment cannot fit, preserving the full UUID whenever it fits alone. Identity and traffic use a fixed palette; separators, timing, context/MCP indicators, and lower thinking levels use the active Pi theme. Other extension statuses remain hidden. The extension is inactive in RPC, JSON, and print modes and remains stateless.

## Work Timing

A TUI-only working-row and timing-entry display for one external human interaction, across its model/tool turns, automatic result runs and owned asynchronous waits. `Worked for` settles once the main loop, related executions and pending/reserved result delivery are all quiet; explicit human-only UI wait is excluded, and interrupted or unavailable state receives its corresponding label. The working row is the request lane: the current request's `↓` estimate, `✻` thinking, a running `TTFT…` counter and live `tok/s`, replaced by that request's settled `↑ ↓ R W CH $ RB ✻ TTFT tok/s` on the next display sample. The `Worked for` entry is the interaction lane of the same fields, with `✻` shown as a share of work elapsed. `TTFT` and `tok/s` follow OpenRouter's definitions: `tok/s` is output divided by the whole request duration including TTFT, and lane values are ratios of sums. Elapsed time measures wall time independently of parallel child duration sums. The active `⚙` field times the longest-running current tool; tool progress has separate evidence. The main agent judges task completion and continuation; these displays provide timing evidence.

The working text publishes one complete sample per second, coalescing stream, request and tool events instead of flashing their intermediate states. Measurements and persistence stay immediate. Initial display and cleanup are immediate; resize reflows the last sample, and Pi's spinner animates independently. The extension also appends one context-free `work-timing-request` entry per main-session request from its `message_end` handler, before Pi persists the assistant message; it carries the request's `TTFT` and thinking duration, which Pi leaves unpersisted, and the footer joins it read-only.

See [Usage metrics](docs/architecture/usage-metrics.md) for the lane model, field matrix and update cadence, and [Work-timing metrics](docs/architecture/work-timing.md) for request timing, interaction settlement, width behavior and maintenance boundaries. When co-loaded with `pi-cc-extensions`, its competing `enableWorkingMessage` writer must be off; user settings and an already-loaded process retain their existing state after source edits.

## Agent Bark

`agent-bark` sends the optional user-owned `~/.local/bin/agent-bark-hook` one `UserPromptSubmit` when an external interaction starts and one completion when it ends: the moment a person needs to look again. In TUI and RPC it runs its own instance of the shared interaction boundary that also ends `Worked for`, so an intermediate main-run settlement while owned Bash or Agent work still runs, and the internal result-wake runs that follow, stay silent. A quiescent end sends `Stop`; a main-run error or unverifiable execution state sends `StopFailure`, the latter with a `State unavailable:` summary prefix; an abort or new human input stays silent because the person is already present. The payload carries a bounded assistant summary and `duration_ms`, the same main-agent wall time excluding human wait. Print and JSON hosts cannot resume from asynchronous results, so a user run's settlement ends the interaction there. The adapter returns before registering handlers when `PI_EXTENSIONS_AGENT_CHILD=1`, which excludes a managed agent's own Pi process. A missing hook is non-fatal; credentials, thresholds, deduplication, and actual delivery remain the shared hook's responsibility.

When adopting this packaged adapter, disable or remove the old loose `~/.pi/agent/extensions/agent-bark.ts` entry so each main-agent notification is sent once. Loose extensions remain user-owned and unchanged by the package publisher. Removing this package entry stops the Pi adapter and leaves the shared hook and its other consumers unchanged.

## Async Bash

In TUI and RPC, the enhanced `bash` can return while the same native Pi Bash operation keeps running. Pi owns shell selection, launch and process-tree teardown; the wrapper retains output, an execution-scoped abort signal and renewable deadline. Configured cwd, environment and shell command prefix apply once. `inspect` reads the retained result, `wait` can be released while work continues, `renew` extends the same execution, and `cancel` aborts it through Pi. A running result remains distinct from exit 0; the original call returns only once. Print and JSON keep the native draining shell. Notices delivers a terminal result left unreturned by the tool. Start with `{"command":"bun test"}` and control it with `{"action":"inspect","executionId":"exec_example"}`; an execution id requires an explicit action; otherwise the request is rejected before execution. See [Async Bash](docs/architecture/async-bash.md).

## Cache Keepalive

`cache-keepalive` keeps an idle TUI/RPC session's Anthropic prompt cache warm while Pi's own idle warming (still in 1.5.1) stops after a custom message enters the context. It acts only while Pi's global `cacheWarming` setting is explicitly `"streaming"` (Pi's default is `"idle"` since 1.5.1), replays the last real provider payload with a one-token response on Pi's own schedule and economics, and records each refresh as a context-free `cache-keepalive.refresh` entry. Setting `cacheWarming` to `"idle"` returns to the official warmer and makes this extension stand down. See [Cache Keepalive](docs/architecture/cache-keepalive.md).

## Tasklist And Notices

`tasklist` keeps a passive branch-local list with an ordinary title, stable item IDs, text, `todo`, `doing`, `blocked`, `done` or `cancelled` status and optional notes. Use `set`, `update` and `inspect`; `cancel` is a bulk edit of unfinished items; execution cancellation uses its execution's control. List pause/resume, automatic interruption mutation and inferred task completion remain outside Tasklist's behavior. The main agent judges completion and necessary checks; this independent capability works with any Skills collection and leaves update scheduling and turn-ending conditions to the main agent.

Tasklist continues publishing passive facts. Notices alone decides execution-result delivery; task-only notices remain disabled. Unfinished, blocked or cancelled items remain passive while Notices delivers Agent/Bash results, including when a sibling execution is still running. Results supply evidence; the user owns approval and the main agent judges task completion.

`tasks-ui`, `jobs-ui` and `agents-ui` share an above-editor widget with independently expandable Tasks → Jobs → Agents sections. Each heading reads `Name (done/total done) active · alerts`, for example `Tasks · <list title> (3/7 done) 2 doing` or `Jobs (22/24 done) 2 running`, so the line ends on current work. Header clicks fold inline and leave focus with the editor. To inspect work, click a Job or Agent row in fullscreen, or use `/jobs-ui focus` or `/agents-ui focus` in either TUI mode. Move with ↑/↓, press Enter for that record's read-only detail and Esc to return to the same item; Esc again returns to your chat draft. Commands accept `expand`, `collapse`, `show`, `hide` and bare visibility toggles; `/xxx-ui list` opens the corresponding central inspector without changing the bottom section. Updates preserve visibility and folding. Done titles remain struck through. Headless modes keep the tools available and leave the UI unmounted.

Jobs shows background Bash executions, with running jobs before stopped ones. `/jobs-ui list` provides the same jobs even when they do not fit inline. The activity or command preview uses the available pane width while leaving room for the outcome or duration; previews keep their source redaction and size limits. Foreground completions are excluded. The current success-duration threshold is zero. Unavailable data is labeled separately from zero jobs.

Tasklist writes schema-v6 `tasklist.state` snapshots and restores supported current-version data immediately. Other versions or malformed snapshots are reported explicitly and remain unchanged; an empty list represents supported empty state. The naming cutover uses the current storage/event names without compatibility readers. See [Tasklist](docs/architecture/tasklist.md) and [Notices](docs/architecture/notices.md). Source changes still need separately authorized publication and reload before a daily Pi process uses them.

## Package

The private package exposes exactly:

```text
extensions/multi-skill-mentions/index.ts
extensions/fast-gpt/index.ts
extensions/agents/index.ts
extensions/status-footer/index.ts
extensions/work-timing/index.ts
extensions/agents-ui/index.ts
extensions/tasklist/index.ts
extensions/notices/index.ts
extensions/tasks-ui/index.ts
extensions/jobs-ui/index.ts
extensions/agent-bark.ts
extensions/async-bash/index.ts
extensions/cache-keepalive/index.ts
```

Each extension keeps independent behavior, state, tests, and removal semantics while sharing one Pi package.

## Documentation

`docs/architecture/` owns self-contained product truth. Shared integration boundaries live at `$AGENT_ARCHITECTURE_DIR/docs/architecture/`; designs/plans and evaluations belong to that owner's `docs/plans/pi-integration/` and `docs/evaluations/pi-integration/`. The local `mise.toml` declares all three source roots; `.mise.local.toml.example` documents overrides. Product checks, loading and publication remain independent of the architecture checkout. See [`docs/README.md`](docs/README.md).

## Project Environment

Use `mise exec -- <command>` for this checkout's development context; `mise run check` is the full source-check entrypoint. `mise.toml` binds `PI_EXTENSIONS_DIR` to the current checkout even when invoked from a subdirectory, and clears inherited `UV_PROJECT_ENVIRONMENT` because this product has no uv project. This targeted reset preserves unrelated user settings, shared tool caches, and the rest of the environment. An explicit nonempty caller `TMPDIR`, including worker scratch, takes precedence over a global mise default; the unconfigured fallback is `~/tmp/agent-arch`.

`mise run check` delegates to `bun run check`. The direct Bun entrypoint works independently of mise, personal global configuration, the architecture checkout, and a Python environment. Cross-repository callers that need this repository's environment enter its mise context as well as changing cwd. Provider probes, installation, and publication require their own authorization; cache placement and source-root variables govern their respective paths.

## Local Development

Bun 1.4.2 (declared in `packageManager`) runs dependency installation, TypeScript checking, tests, and repository-owned e2e/probe scripts. The tracked `bun.lock` fixes dependency resolution; `bunfig.toml` disables install lifecycle scripts. `bun run test` selects only `tests/*.test.ts` with a 120-second default per-test timeout; deliberate e2e entrypoints stay separate. Installed-host checks still invoke the actual `pi` executable: its runtime, registry package names, and `~/.pi/agent/npm/` layout remain host-owned. Path identity resolves symlinks before parent traversal and is covered by independent fixture expectations; those expectations remain independent of the runtime's treatment of raw `link/../file` paths.

Use existing dependencies, preparing them with `bun install --frozen-lockfile --ignore-scripts` when needed. During implementation, choose relevant test files and compilation for feedback:

```bash
bun test ./tests/<affected-suite>.test.ts
bun run typecheck
```

The main task coordinates integration and E2E checks, reuses applicable worker results, and selects `bun run check` when broad impact, a delivery requirement or unresolved uncertainty calls for the full source suite. Choose the applicable checks for each worker, edit or repair; the main task coordinates the complete cycle. Documentation and prompt changes can use inspection and relevant structural checks; tests target independently specified behavior.

`bun run check` runs typecheck, `test:fast`, `test:isolated`, `test:host-optional`, and shell syntax; its three test groups retain every entry of the original `tests/*.test.ts` glob. The optional host group can skip if Pi, CC, or PTY tooling is missing; host acceptance requires the applicable required host lane even when that source check is green. The explicit `bun run e2e:host-offline` (real Pi) and `bun run e2e:ui-offline` (Pi, installed CC, util-linux `script`, including the observer click check) fail if their prerequisites or a required test are unavailable. Run the affected required lane for host or fullscreen changes; select UI checks for changes that affect fullscreen behavior. See [`docs/test-suite-evidence-lanes.md`](docs/test-suite-evidence-lanes.md) for membership, diagnostic ownership, costs and evidence limits.

Daily Pi should load the local package snapshot at `~/.pi/agent/packages/csheng-pi-extensions`; this checkout is authored source and `~/.pi/agent/extensions/` is loose-extension auto-discovery. With publication authority, `mise run publish-local-package` runs the Bash/rsync publisher to copy `package.json`, `config/` and `extensions/` into the snapshot, leaving user settings, routes, provider configuration and loose extensions unchanged. Preserve that package layout: Agents resolves packaged roles and routes relative to the extension. The loose-extension directory is shared discovery and stays outside mirror-delete targets. First-time installation removes the checkout package path with `pi remove`, then uses `pi install` for the snapshot. Restart Pi after publishing; `pi update --extensions` leaves local-path packages unchanged.

Temporary-load and installed-package probes live under `scripts/`. Agent and Tasklist probes use RPC or print fixtures without model calls. Deterministic unit tests cover the small fast-gpt, status-footer, and work-timing boundaries; those boundaries add no probe commands. The multi-skill mention probes use Pi print mode, cross model/provider preflight, and may make a model call when authentication is available; `PI_OFFLINE=1` disables update traffic while inference remains enabled. Run those probes only with explicit provider-call authority.

The Tasklist offline probes bind temporary loading or installed-host package discovery to this checkout. The `installed-*-probe.test.ts` tests use shim Pi to check runner protocol only; real host probes provide separate evidence. The Agent registration probes still look for the retired `agent` tool. For version-5 peer behavior, `bun test ./tests/agents-peer-host.test.ts` exercises an RPC host with synthetic inference and real native child processes. For installed Tasklist behavior, `bun run e2e:installed-offline` requires real Pi and uses synthetic input without provider calls. The PTY tests separately exercise installed Pi/CC and agent UI navigation; see [Agents UI](docs/architecture/agents-ui.md) for prerequisites and coverage.

The historical delegation probe measures parent-model invocation decisions on a frozen prompt set. It compares the retired version-4 `agent` action shape (`production`), a derived `flat` shape and an external `agent-shape`. [`scripts/fixtures/delegation-probe-surface.ts`](scripts/fixtures/delegation-probe-surface.ts) retains the capability-only tool text (`off`); the optional `balanced` and `aggressive` treatments are also frozen. The probe uses a mock executor in a throwaway project and measures the call decision, with child quality and the current seven-tool surface outside that evidence. Run it only with explicit provider-call authority; results stay as dated evaluation evidence in `$AGENT_ARCHITECTURE_DIR`:

```bash
PI_EXTENSIONS_AGENTS_DELEGATION_PROBE=1 bun scripts/run-delegation-probe.ts --dry-run
PI_EXTENSIONS_AGENTS_DELEGATION_PROBE=1 bun scripts/run-delegation-probe.ts --guidance aggressive,off --trials 6
```

The opt-in live Agent E2E script in this checkout still prompts for the retired version-4 `agent` actions. These commands identify that legacy lane; version-5 live acceptance requires an updated check. Provider calls and use of ambient authentication require explicit authorization:

```bash
PI_EXTENSIONS_AGENTS_LIVE_E2E=1 bun run e2e:agents
PI_EXTENSIONS_AGENTS_LIVE_E2E=1 bun run e2e:agents --installed
```

The first command temporary-loads the complete package with ordinary global extensions disabled. The second uses the globally installed package. Both make real model calls and emit only a bounded summary. Global installation, user route creation, provider calls, and settings changes remain explicit gates; `bun run test` leaves them to separately authorized actions.

Collaboration envelope **5** versions the current runtime. The maintained `.agents/skills/evaluate-agent-runs/` extractor in this checkout still reads the retired version-4 `agent` surface and emits metric artifact schema **5**, independently of the runtime version. Use it only for explicitly selected supported historical evidence. Its projections separate excluded envelopes, invalid records, unavailable provenance, per-root integration and release, deduplicated native usage, and explicit parent disposition. Its version-4 evidence does not establish version-5 execution or acceptance.


Maintainers can also measure what sessions cost and how prompt caching behaved with `.agents/skills/evaluate-session-cost/`. The report reproduces Pi's `Cache Re-billed` tokens, dollars, and miss count from session usage, attributes each miss to an observation-pack rewrite, a provider-side cache stall, or another cause, values avoided observation replays at the price of the request that owned them, and reports per-model totals plus net cost under both the strict and upper-bound attribution conventions. Cost is Pi's recorded nominal cost and savings are a counterfactual valuation; recorded credits are separate; managed child sessions and their ledgers are included in the window scan.

## Safety

Fast-gpt leaves unsupported request correlations unchanged and defers usage and cost truth to Pi and the provider response. Agent graph, route, path, storage, process, and candidate failures return typed bounded evidence; existing authority remains in force and retries require explicit action. Probe output contains fixed redacted fields; prompts, user settings, credentials, and external file content remain excluded.
