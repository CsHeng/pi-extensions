# Pi Extensions

This repository contains small, independently removable Pi extensions. It exports nine maintained extensions: `multi-skill-mentions`, `fast-gpt`, `subagents`, `subagents-ui`, `status-footer`, `work-timing`, `workflow`, `agent-bark`, and `retained-shell`, while preserving Pi's authoritative host agent loop. `subagents-ui` is default-loaded as a TUI-only read-only observer.

## Multi-skill Mentions

Type `$` in the TUI to search loaded skills and insert one or more `$skill-name` mentions. On submission, the extension expands each uniquely mentioned loaded skill before the original prompt. Unknown names, escaped mentions such as `\$skill-name`, and ordinary shell variables remain unchanged.

`/skill-mentions` shows a short usage reminder and the number of currently loaded skills. The extension does not discover skills independently; Pi's command registry remains authoritative for available skill names and source paths.

## Fast GPT

`/fast-gpt` toggles a branch-local request profile between priority and explicit default service tiers. The extension leaves requests untouched until the first command. In priority mode it adds top-level `service_tier: priority` to correlated official OpenAI and OpenAI-Codex Responses requests; the next toggle sends top-level `service_tier: default`. Unsupported provider, API, or model correlations remain unchanged.

This is only a request payload profile. Its keyed status is a lightning mark confirming that priority was requested, not that the provider served it. Pi's extension API does not expose the final response body's `service_tier`, and the OpenAI-Codex endpoint has an additional response-accounting caveat. Pi and provider-side billing remain authoritative for usage and cost. The extension supplies no model alias, provider override, pricing parser, live call, or workflow behavior. See [`docs/architecture/fast-gpt.md`](docs/architecture/fast-gpt.md) for state, correlation, response observability, ownership, and removal contracts.

## Subagents

The source collaboration contract is v4, using [Git worktrees and session-scoped asynchronous execution](docs/architecture/subagent-execution.md). One business task can read multiple locations and write multiple repositories through one `access` collection of read/write grants with absolute scalar or nonempty-list `scope` selections. Write includes read; unsupported managed-write backends fail honestly. Admission captures dirty/staged/untracked Git input without changing the parent index. TUI/RPC create and continue return accepted receipts while preparation and one native child proceed under the owning session. A receipt is not completed work.

`csheng_subagent_sessions` supports explicit `create`, `continue`, `inspect`, `join`, `cancel`, `refresh`, `apply`, and `close` for explorer, reviewer, and worker tasks. One-shot hosts default to foreground; TUI/RPC callers can request `mode: "foreground"` or explicitly join a dependency. Independent submissions share capacity and locks. Ordinary delegation is a flat create batch; optional hard predecessor edges support approved implementation order with no intervening parent decision. Dependency edges pass predecessor reports, not candidate files. File-dependent successors require explicit parent `apply` between dispatches. Assignments run in separate agent contexts and can execute in parallel within configured capacity. Explorer, reviewer and worker roles describe investigation, evaluation and implementation; grants determine actual permissions. The caller chooses task decomposition, delegation appetite and verification strategy through user direction or applicable method guidance, without requiring a particular Skills collection. Results are candidates with actual evidence and uncertainty; the parent retains integration, continuation, candidate application, acceptance and the final response.

Role labels (`explorer`, `reviewer`, `worker`) express purpose and routing preferences, not a tool ceiling. Eligible configured native, extension and MCP tools remain available; explicit read-only intent, access grants and real ownership still bind. Known typed operations enforce those bounds, but trusted shell and third-party code are not an OS sandbox.

Each managed episode uses retained native history, with a prepared workspace and private index for every writable Git root. One native child can exercise real dependencies between those roots; source-to-prepared mappings keep same-relative-name files distinct. Dependencies and ignored environments are not copied or certified. Actual authorized additions, deletions, renames, mode changes, binary files and contained symlinks form one immutable candidate bundle. Continue keeps its input; only explicit idle refresh changes it.

Apply preflights the complete bundle under destination-resource coordination, then integrates roots without claiming cross-repository atomicity. Already-applied roots stay recorded when a sibling conflicts or has unknown progress; retries reconcile that evidence before mutation and preserve parent staging. Report completion, execution, candidate application, parent acceptance, retention and resource release remain distinct. Close may retain resources; a closed-retained record can later be discarded. Discard retries exact remaining owned refs, worktrees and scratch while retaining registry/native evidence. Historical envelopes are shallowly excluded, not decoded, migrated or used for current action semantics. See [execution and recovery](docs/architecture/subagent-execution.md).

Foreground tool progress uses `Subagents {running}/{total} running, {finished} finished · {turns} turns · {clock}`; asynchronous progress uses the observer, not an already settled submission callback. Persisted terminal events own execution accounting and coalesced current-owner wake. Default-loaded `subagents-ui` is a read-only session-wide floating panel toggled with `/subagents-ui` or `Ctrl+Alt+F`. Fresh running agents stay pinned above Enter-expanded retained history; PageUp/PageDown navigate history pages and arrows reveal wrapped rows. Continuing a handle preserves its identity while episodes are counted separately. Closed and same-session historical-branch records remain visible without broadening mutation authority. Core-owned retained queries provide page-independent recorded usage, explicitly labeling incomplete or unavailable metrics; bounded observer snapshots remain live evidence, not session totals. The themed panel adapts to terminal dimensions and keeps its `[ ✕ ]` close chip; status/widget/completion entries stay off by default. See [Subagents UI](docs/architecture/subagents-ui.md). `status-footer` and `work-timing` remain independent. Managed results distinguish request and episode outcomes, stored state, report completeness, and apply facts. A failure the extension cannot type keeps the `managed_operation_failed` code plus a bounded, path-free `detail` reason (errno code or error name) instead of an opaque code. Acceptance remains a parent judgment, not a runtime result field or warning.

Loading the core extension registers `csheng_subagent_sessions`, `/subagents` status, the current-owner index and observer hooks. It starts no child or workspace until called. Trusted-project admission validates the normalized absolute grants and physical owners before preparation; it does not infer authority from cwd, a role, an environment variable or tool availability. Prepared mappings cover writable Git roots and associated reads, while independent read roots remain read-only. Product-owned IDs are case-sensitive ASCII alphanumerics copied unchanged across calls, storage, events, UI and evaluation; type, relationships and episode live in separate fields. Native session IDs and Git OIDs remain opaque external values.

The repository ships its route baseline at [`config/csheng-subagents.json`](config/csheng-subagents.json). It prefers explorer Luna medium, worker Terra high, and reviewer Sol high, with explicit peer fallback order, global concurrency 10, per-role defaults `4/4/2`, thinking-profile mappings. Tool guidance describes capability and operation, not a default delegation preference. Model names remain opaque configuration; extension code does not rank the peer families.

The optional user override is `csheng-subagents.json` under Pi's agent directory, normally `~/.pi/agent/csheng-subagents.json`. An absent override applies the package baseline. A strict overlay may replace role candidates, add execution-profile candidate lists, override thinking-profile entries, or replace global and per-role concurrency with positive safe integers. When role capacities sum above the global value, the scheduler uses the global value as the launch limit instead of rejecting the configuration. Package and user files are read-only persistent defaults: the extension never creates, edits, or deletes them. A legacy `reasoningProfiles` key is rejected as invalid route configuration and is not applied or rewritten; rename it to `thinkingProfiles`. The retired `guidance` setting is also rejected by the closed config schema; remove it explicitly before using this version, expressing any desired delegation preference through user instructions or an applicable method. Neither change rewrites a personal file.

Tasks may provide optional provider-neutral `executionProfile` and `thinkingProfile` values; missing or unmapped values visibly use the role default. Model-visible results and TUI summaries show the actual provider/model/thinking, requested profiles, whether each applied, and any profile fallback. A requested `deep` profile does not prove a different model was selected, and the parent model does not imply the worker model. An explicitly user-selected `model` or Pi `thinking` level is ephemeral, resolves against Pi's registry, and overrides defaults without fallback on an invalid exact selection. The extension never reads a plan, Skill or Codex agent file, and never changes the parent model or provider settings. JSON owns persistent routing defaults, not grants or a child-only capability ceiling.

Historical one-shot `csheng_subagents`, `/subagents-debug` and snapshot UI v1 are not current runtime surfaces. Current readers distinguish excluded, invalid and unavailable evidence without legacy payload interpretation. Current-version records that still carry `reasoningProfile` request or receipt fields are excluded the same way: they are not migrated, rewritten, or read as profile-less successes. See [Subagents](docs/architecture/subagents.md) for the owner boundary, access, routing, accounting, current-version cut and examples.

## Status Footer

`status-footer` replaces the TUI footer with one compact line: `Grok 4.6 high (xai sub) | ~/project (main) | <session-uuid> | ↑952k ↓62k R13M CH99.7% $8.979 | 270k/500k (54.0%) | MCP 2/2`. Subscription status sits in the model parentheses; the branch comes from Pi's footer data and disappears outside a repository; `R`/`W` are cache read/write and `CH` is the latest prompt cache-hit rate. When the `fast-gpt` keyed status is present, a warning-colored ⚡ sits after thinking, as in `GPT-5.4 high ⚡ (openai sub)`. Narrow terminals wrap field by field — each field flows onto the next row only when it no longer fits the remaining whitespace — adding rows rather than dropping fields, and truncate a row only when a lone segment cannot fit, preserving the full UUID whenever it fits alone. Identity and traffic use a fixed palette; separators, context/MCP indicators, and lower thinking levels use the active Pi theme. Other extension statuses are not shown. The extension is inactive in RPC, JSON, and print modes and stores no state.

## Work Timing

A TUI-only working-row and completion-entry display for the current user message and its model/tool turns. `R / ΣR` means current-turn / cumulative **thinking duration**; the separate `tok/s` value is **decode throughput**, including thinking and tool-call output but excluding pre-output wait (TTFT), tool execution and between-turn gaps. The active `⚙` field times the longest-running current tool, not its progress. None of these displays certifies task completion.

Waiting 20 seconds for first output and then decoding 600 tokens over 10 seconds still gives **60 tok/s**, not a request-wide 20 tok/s average. TTFT is a separate concept, not a standalone metric currently retained by this extension. The status footer's `R` instead counts cache-read tokens and its usage scope is session-wide.

See [Work-timing metrics](docs/architecture/work-timing.md) for the complete legend, overlapping-window diagram, token estimates, live/settled examples, width behavior and maintenance boundaries. When co-loaded with `pi-cc-extensions`, its competing `enableWorkingMessage` writer must be off; source edits do not change user settings or an already-loaded process.

## Agent Bark

`agent-bark` forwards user-message main-agent start and settled events to the optional user-owned `~/.local/bin/agent-bark-hook`. Only a run started by a prompt or `pi.sendUserMessage()` notifies. Pi 1.2 also starts a run for an idle `pi.sendMessage(..., { triggerTurn: true })` custom message — such as the subagent-completion wake — and that internal run stays silent at both start and settlement, so it does not produce extra Bark notifications or inherit a previous user run's eligibility. The adapter returns before registering handlers when `CSHENG_SUBAGENT_CHILD=1`, which excludes a managed subagent's own Pi process; that guard cannot cover internal runs in the parent session, which the per-run message-type eligibility handles. Main-agent TUI and headless sessions retain the same `UserPromptSubmit`, `Stop`, and `StopFailure` events, with a bounded assistant summary. A missing hook is non-fatal; credentials, duration thresholds, deduplication, and actual delivery remain the shared hook's responsibility.

When adopting this packaged adapter, disable or remove the old loose `~/.pi/agent/extensions/agent-bark.ts` entry to avoid duplicate main-agent notifications. The package publisher does not modify loose extensions automatically. Removing this package entry stops the Pi adapter without changing the shared hook or its other consumers.

## Retained shell

In TUI and RPC, builtin `bash` can return while the same command keeps running. The result carries an execution id, a bounded output tail, and a finite deadline. `inspect` reads it, `wait` can be released without stopping it, `renew` extends that same execution, and `cancel` stops it. A running result is not exit 0 and does not get a second result on the original call. Print and JSON keep the native draining shell. A TUI/RPC terminal that the call does not return is delivered once on an idle wake or the next model request, through the shared reservation, and is not a second tool result. See [Retained shell](docs/architecture/retained-shell.md).

## Task Tracking

`csheng_workflow` keeps a branch-local goal and task list for progress, observation and focus. It is a Pi extension usable with any relevant Skills or without this collection. Use `set` for a new or revised list, `update` for a batch of task changes, and `inspect`, `pause`, `resume` or `cancel` as work progresses. Tasks have stable IDs, titles, explicit `todo`, `doing`, `blocked`, `done` or `cancelled` states and optional notes. The main agent judges what is done and which checks the change needs; tracking adds no test, review or delivery-acceptance ceremony.

Current task context helps retain the goal through long work. Active unfinished work may receive a reminder after Pi settles; unchanged state does not generate repeated follow-ups. Host interruption, untrusted projects, queued input and pending managed execution prevent inappropriate wake-ups. Child results remain candidates and never automatically mark tasks done.

`/workflow-ui` toggles the read-only above-editor view; `show`, `hide` and `list` retain their existing roles. Done titles are struck through, blockers and cancellations stay visible, and bounded overflow prioritizes active work. RPC/JSON/print modes mount no UI.

Schema-v5 task snapshots persist in Pi session history. Restored unfinished work is paused until explicit resume. Older completion-contract records are ignored with a visible diagnostic and may be replaced using `set`; no acceptance state is migrated and session history is not rewritten. See [Workflow](docs/architecture/workflow.md) for the protocol and host boundaries. Source changes require separate publication and reload before a daily Pi process uses them.

## Package

The private package exposes exactly:

```text
extensions/multi-skill-mentions/index.ts
extensions/fast-gpt/index.ts
extensions/subagents/index.ts
extensions/status-footer/index.ts
extensions/work-timing/index.ts
extensions/subagents-ui/index.ts
extensions/workflow/index.ts
extensions/agent-bark.ts
extensions/retained-shell/index.ts
```

Each extension keeps independent behavior, state, tests, and removal semantics while sharing one Pi package.

## Documentation

`docs/architecture/` owns self-contained product truth. Shared integration boundaries live at `$AGENT_ARCHITECTURE_DIR/docs/architecture/`; designs/plans and evaluations belong to that owner's `docs/plans/pi-integration/` and `docs/evaluations/pi-integration/`. The local `mise.toml` declares all three source roots; `.mise.local.toml.example` documents overrides. Product checks, loading and publication remain independent of the architecture checkout. See [`docs/README.md`](docs/README.md).

## Project Environment

Use `mise exec -- <command>` for this checkout's development context; `mise run check` is the full source-check entrypoint. `mise.toml` binds `PI_EXTENSIONS_DIR` to the current checkout even when invoked from a subdirectory, and clears inherited `UV_PROJECT_ENVIRONMENT` because this product has no uv project. This targeted reset does not clear unrelated user settings, shared tool caches, or the entire environment. An explicit nonempty caller `TMPDIR`, including worker scratch, takes precedence over a global mise default; the unconfigured fallback is `~/tmp/agent-arch`.

`mise run check` delegates to `bun run check`. The direct Bun entrypoint remains supported without mise, personal global configuration, or the architecture checkout; it does not need a Python environment. Cross-repository callers that need this repository's environment enter its mise context rather than only changing cwd. Cache placement and source-root variables do not enable provider probes, installation, or publication.

## Local Development

Bun 1.4.2 (declared in `packageManager`) runs dependency installation, TypeScript checking, tests, and repository-owned e2e/probe scripts. The tracked `bun.lock` fixes dependency resolution; `bunfig.toml` disables install lifecycle scripts. `bun run test` selects only `tests/*.test.ts` with a 120-second default per-test timeout; deliberate e2e entrypoints stay separate. Installed-host checks still invoke the actual `pi` executable: its runtime, registry package names, and `~/.pi/agent/npm/` layout remain host-owned. Workflow path identity resolves symlinks before parent traversal and is covered by independent fixture expectations, not the runtime's treatment of raw `link/../file` paths.

Use existing dependencies, preparing them with `bun install --frozen-lockfile --ignore-scripts` when needed. During implementation, choose relevant test files and compilation for feedback:

```bash
bun test ./tests/<affected-suite>.test.ts
bun run typecheck
```

The main task coordinates integration and E2E checks, reuses applicable worker results, and selects `bun run check` when broad impact, a delivery requirement or unresolved uncertainty calls for the full source suite. These entrypoints do not require repeating a complete cycle for every worker, edit or repair. Documentation and prompt changes can use inspection and relevant structural checks without creating tests over their wording.

`bun run check` runs typecheck, `test:fast`, `test:isolated`, `test:host-optional`, and shell syntax; its three test groups retain every entry of the original `tests/*.test.ts` glob. The optional host group can skip if Pi, CC, or PTY tooling is missing; a green source check in that environment is **not** host acceptance. The explicit `bun run e2e:host-offline` (real Pi) and `bun run e2e:ui-offline` (Pi, installed CC, util-linux `script`, including the observer click check) fail if their prerequisites or a required test are unavailable. Run the affected required lane for host or fullscreen changes; unrelated source edits need not incur UI cost. See [`docs/test-suite-evidence-lanes.md`](docs/test-suite-evidence-lanes.md) for membership, diagnostic ownership, costs and evidence limits.

Daily Pi should load the local package snapshot at `~/.pi/agent/packages/csheng-pi-extensions`, not this checkout and not `~/.pi/agent/extensions/`. Publish with `mise run publish-local-package`. First-time install is `pi install` of that snapshot after removing the checkout path from user packages. Restart Pi after publishing; `pi update --extensions` does not refresh local-path packages.

Temporary-load and installed-package probes live under `scripts/`. Subagent and workflow probes use RPC or print fixtures without model calls. The small fast-gpt, status-footer, and work-timing boundaries are owned by deterministic unit tests and add no probe commands. The multi-skill mention probes use Pi print mode, cross model/provider preflight, and may make a model call when authentication is available; `PI_OFFLINE=1` disables update traffic but does not disable inference. Run those probes only with explicit provider-call authority.

The four offline probes bind temporary loading or installed-host package discovery to this checkout; installed-host success does not mean the real installed package was updated. The `installed-*-probe.test.ts` tests use shim Pi to check runner protocol only; they cannot replace the real host probes. For changes to installed workflow or co-load behavior, `bun run e2e:installed-offline` runs the real installed Pi against synthetic input and returns a bounded JSON result for the registration, extension-off, co-load, and persisted-snapshot path. This explicit lane fails if Pi or another prerequisite is missing; it does not make provider calls or prove model instruction following. `tests/subagents-cc-tui.test.ts` separately exercises the real installed Pi/CC on and compact TUI through a PTY with a synthetic provider and disposable settings, and `bun run e2e:subagents-ui` runs the deliberate installed-Pi fullscreen close-marker click check from `tests/subagents-ui-tui.e2e.ts`. Those PTY tests explicitly skip when their local prerequisites are absent; see [`docs/architecture/subagents-ui.md`](docs/architecture/subagents-ui.md) for the evidence boundary.

The delegation probe lane measures whether a parent model calls the subagent tool at all for a frozen prompt set, across the production schema, a derived flat schema, and one external reference shape, with current capability-only guidance by default (`off`). The opt-in `balanced` and `aggressive` treatments are frozen historical strings in the probe fixtures, not production policies or route-config settings. It uses a mock executor in a throwaway project, so it reports a call decision and never child quality, and it is a measurement lane rather than a pass/fail gate. Run it only with explicit provider-call authority; results stay as dated evaluation evidence in `$AGENT_ARCHITECTURE_DIR`:

```bash
CSHENG_SUBAGENTS_DELEGATION_PROBE=1 bun scripts/run-delegation-probe.ts --dry-run
CSHENG_SUBAGENTS_DELEGATION_PROBE=1 bun scripts/run-delegation-probe.ts --guidance aggressive,off --trials 6
```

The opt-in live subagent E2E uses Pi's ambient authentication and is separately authorized. Parent owns acceptance of that lane. This document does not treat it as verified package co-load or as a current one-shot runtime proof:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 bun run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 bun run e2e:subagents --installed
```

The first command temporary-loads the complete package with ordinary global extensions disabled. The second uses the globally installed package. Both make real model calls and emit only a bounded summary. Global installation, user route creation, provider calls, and settings changes remain explicit gates and are never performed by `bun run test`.

Maintainers can evaluate an explicitly selected run or an explicit current-epoch scan with `.agents/skills/evaluate-subagent-runs/`. Metric artifact schema **5** is independent of collaboration envelope **4**. Its `source`, `observations` and `managedDispatch` sections distinguish excluded envelopes, invalid records and unavailable provenance; retired one-shot and non-v4 managed payloads are not interpreted. Logical candidates and owned native usage count once rather than once per repository. Per-root integration/release remains separate from aggregate release, so scratch-only failure does not make every root partly released. Native ranges deduplicate replay/inspection and parent/child usage. Child charges are not forwarded through top-level tool-result `usage`, so evaluator totals have a separate recorded-evidence scope from the main footer and `/session`. Explicit parent disposition remains independent of report or apply. The extractor retains no raw prompts, credentials, model selectors, task IDs, child output or external content. Its bounded owned-root status fields intentionally retain candidate/root IDs and destination paths for correlation; other raw paths remain excluded.


Maintainers can also measure what sessions cost and how prompt caching behaved with `.agents/skills/evaluate-session-cost/`. The report reproduces Pi's `Cache Re-billed` tokens, dollars, and miss count from session usage, attributes each miss to an observation-pack rewrite, a provider-side cache stall, or another cause, values avoided observation replays at the price of the request that owned them, and reports per-model totals plus net cost under both the strict and upper-bound attribution conventions. Cost is Pi's recorded nominal cost and savings are a counterfactual valuation, not a recorded credit; managed child sessions and their ledgers are included in the window scan.

## Safety

Fast-gpt leaves unsupported request correlations unchanged and defers usage and cost truth to Pi and the provider response. Subagent graph, route, path, storage, process, and candidate failures return typed bounded evidence and do not widen authority or trigger hidden retries. Probe output contains fixed redacted fields rather than prompts, user settings, credentials, or external file content.
