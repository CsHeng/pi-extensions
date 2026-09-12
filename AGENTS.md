# AGENTS.md

## Project

This repository is the authored source for small local Pi extensions. Extensions may change the host loop's active tools, prompt context, editor completion behavior, provider request payload, or execute one bounded foreground delegation call, but must not replace the coding agent with a second lifecycle engine.

The package exposes eight maintained extensions: `plan-mode` as a reversible loop profile, `multi-skill-mentions` as an explicit prompt expansion mechanism, `fast-gpt` as a branch-local request profile, `subagents` as a bounded foreground managed-delegation executor, `subagents-ui` as a default-loaded TUI-only read-only observer, `herdr-handoff` as an explicit-user-only bridge to one persistent Herdr-managed full agent, `status-footer` as a TUI-only compact status footer, and `work-timing` as TUI-only timing feedback. Keep each extension's behavior, state, tests, and removal semantics independent.

## Layout

- `extensions/plan-mode/`: reversible read-only tool profile
- `extensions/multi-skill-mentions/`: TUI completion and input expansion for loaded skills
- `extensions/fast-gpt/`: branch-local OpenAI Responses service-tier request profile
- `extensions/subagents/`: fixed roles, routes, foreground scheduling, managed native/source continuity, explicit candidates, bounded observations, and the managed observer-event publisher
- `extensions/subagents-ui/`: default-loaded TUI-only read-only observer overlay; widget, keyed footer status, and completion entries remain off unless explicitly enabled
- `extensions/herdr-handoff/`: explicit-user-only Herdr CLI adapter, launch profiles, isolated-worktree evidence, and bounded continuations
- `extensions/status-footer/`: TUI one-line footer with model/thinking, optional fast-gpt lightning, original workdir, session UUID, usage stats, context fill, and MCP counts
- `extensions/work-timing/`: live request and reasoning timing with durable TUI-only completion entries
- `config/csheng-subagents.json`: packaged role routes, semantic-profile mappings, and concurrency defaults
- `.agents/skills/evaluate-subagent-runs/`: maintainer-only read-only evaluator, excluded from the npm package
- `tests/`: deterministic, fake-Pi, subprocess, filesystem, evaluator, and disposable-Git tests
- `scripts/`: redacted temporary-load, installed-package, and explicitly gated live E2E probes, plus the local package snapshot publisher
- `mise.toml`: `publish-local-package` task for the local Pi package snapshot
- `docs/architecture/`: stable product and maintenance truth
- `docs/evaluations/`: bounded retained evidence, not a second truth owner
- `docs/plans/`: stage artifacts and migration history, not runtime input
- `docs/.ignore`: default search boundary that excludes stage history without affecting Git tracking
- `contracts/markdown-prose.toml`: exact immutable prose-format exceptions for retained historical artifacts

## Local Package Snapshot

This checkout is authored source. Daily Pi must load a copied local Pi package, not this working tree and not `~/.pi/agent/extensions/`.

- Pi `packages` local paths load a directory without copying. Pointing user settings at this checkout applies dirty edits on every new process or reload.
- `~/.pi/agent/extensions/` is auto-discovery for loose `*.ts` files and `*/index.ts` trees. It is not this package's install location. `rsync --delete` there would remove unrelated files, and subagents resolves packaged routes as `../../config/csheng-subagents.json` from the extension file, so an extensions-only dump breaks the package baseline.
- Publish with `mise run publish-local-package`. The task runs `scripts/publish-local-package.sh` and rsyncs `package.json`, `config/`, and `extensions/` into `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/packages/csheng-pi-extensions`.
- The publisher is bash plus a mise task because the copy is short linear rsync orchestration, this repository already owns bash probes, and mise is the local task runner. It does not edit `settings.json`, the user route overlay, provider/model settings, or `~/.pi/agent/extensions/`, and it does not npm-publish.
- One-time switch: `pi remove` this checkout path from user packages, then `pi install` the snapshot directory. Later publishes only refresh the snapshot; restart Pi to load it. `pi update --extensions` does not update local-path packages.
- Temporary-load probes keep binding to this checkout. Installed-host probes use a disposable settings file that also points at this checkout; they do not publish the snapshot. Live `--installed` E2E uses the real globally installed package.

## Boundaries

- Pi's public extension API, active tool set, model context and registry, project trust, session events, and startup flags are runtime inputs.
- The host Pi loop remains authoritative for parent model turns, tool execution, persistence, user interaction, and final responses.
- A profile may select tools and append compact loop guidance. It must not introduce task graphs, schedulers, approval protocols, review gates, settlement, or a generic permission framework.
- The fast-gpt extension may toggle branch-local official OpenAI and OpenAI-Codex Responses requests between top-level `service_tier: priority` and explicit `default`. Until the first `/fast-gpt` command, and for unsupported provider/API/model correlations, requests remain unchanged. Its keyed TUI status is a warning-colored ⚡ when priority is requested on a supported model. Pi and the provider remain authoritative for usage and cost; the extension owns no model alias, provider override, pricing parser, live call, or workflow.
- The status-footer extension may replace the TUI footer with a compact one-line status: model and thinking, an optional warning-colored ⚡ after thinking when Pi's keyed `fast-gpt` status is present, optional `(provider sub)` when the active model is on a subscription, the session's original workdir with the Pi-provided git branch, the full session UUID, session-cumulative ↑ input, ↓ output, R cache-read, optional W cache-write, latest-prompt CH hit rate, cost, current context fill, and `MCP enabled/all` from the mcp-adapter status bus. It must keep the UUID visible when width is tight, omit generic extension-status chrome, remain inactive in RPC, JSON, and print modes, and must not persist session metadata. It reads the branch and keyed statuses from Pi's footer data provider without importing `fast-gpt`, spawning Git, or resolving worktree layout, and does not own Git state or chrome, working-message timing, provider billing truth, or the request-profile selection.
- The work-timing extension may customize the TUI working message while an interaction is active and append one context-free completion entry after `agent_settled`. Reasoning duration is client-observed time between streamed thinking start and end events; total duration spans `before_agent_start` through final settlement. The working label reports the current user message with `Working... 12s • ↑ 17,234 ↓ 4,321 tokens • R 3s / ΣR 16s • 720 tok/s`: the elapsed clock and the upstream/downstream token counts accumulate across every turn and tool call that message triggered and therefore never disappear while a tool runs, `R` is the current turn's reasoning, and `ΣR` the message's cumulative reasoning. The settled entry keeps that field order and is fully cumulative for the message: `Worked for 12s • ↑ 17,234 ↓ 4,321 tokens • ΣR 16s (45%) • 720 tok/s`. `↑` comes from provider `usage.input`; `↓` prefers provider `usage.output` and falls back to the chars/4 estimate of streamed text, thinking, and tool-call arguments; an unreported side is omitted. `tok/s` divides the message's output tokens by model occupancy: each turn starts at `turn_start` and retimes to `before_provider_request` when that hook fires, then runs through thinking, TTFT, and stream stalls until assistant `message_end` or the first `tool_execution_start`; tool execution and the gap between turns do not count. It disappears while occupancy or output tokens are still zero. The footer keeps its own session-cumulative counters. Stream events repaint the label at most every 150 ms so token counters climb in real time, while duration fields are re-sampled on a one-second tick so they all advance in the same frame. Collapsed and expanded states render that same entry line, version-one entries render without the cumulative token segment, and a non-zero sub-second reasoning duration renders `<1s` instead of a share-contradicting `0s`. It must clean up its interval on settlement and session shutdown and remain inactive in headless modes.
- The subagent extension may validate and execute one foreground, hard-bounded, in-memory managed task batch with optional hard predecessor edges submitted by the parent. Ordinary delegation stays flat; semantic hard-edge eligibility remains parent-owned. The extension owns physical child routing, readiness, concurrency, locks, cancellation, path capabilities, managed native/source continuity and candidate apply, bounded observations, opaque effective-revision provenance, and TUI observer-event publication. After parent-project trust, it canonicalizes current-repository `scope` against the Git toplevel and may grant explorer or reviewer tasks at most eight exact Git-contained `externalReadRoots` supplied by the parent call. It does not load external project resources, grant external writes, read Pi trust storage, or treat another repository as child cwd. Managed records retain bounded owner/branch identity, native/source state, request replay, and candidate facts, not a semantic mission. Candidates are never auto-applied or auto-converged. File-dependent successors require explicit parent apply between dispatches; dependency edges pass reports, not candidate files. The package index does not register historical one-shot `csheng_subagents`, `/subagents-debug`, or snapshot UI v1. The extension owns no semantic lifecycle, approval, verification judgment, review adjudication, repair/continuation decision, automatic recovery, or durable orchestration. Task-targeted cancellation during worker candidate freeze returns too-late; run cancellation stops cancellable work and lets an entered critical section finish.
- Managed workers use trusted host native file/search/bash tools in a private source with private Git index and independently copied declared dependencies. File guards and candidate inventories are not OS restrictions on bash, credentials, network, or hostile process escape. Full workers require explicit repo-wide input and exact candidate write paths; there is no extension-owned sandbox/container or provisioning. Unknown writer cleanup, source/candidate drift, partial apply, and native-owner/leaf mismatch fail visibly. Optional observation failures never weaken mandatory lifecycle/source/candidate evidence. Close releases open-record slots, not all retained history; discard keeps native/registry evidence. Managed-root 8 GiB / 1,000,000-entry thresholds are best-effort warnings with user-owned cleanup guidance, never admission gates or automatic cache reclamation. Users may ignore them; no exact or concurrency-safe quota accounting is promised. Per-workspace, file, candidate, parser, session and integrity limits remain enforced. A full storage reset requires stopping all users of the agent directory and deliberately abandoning retained histories, candidates and replay records.
- The subagents-ui extension is default-loaded. It is a TUI-only read-only observer of bounded managed `csheng.subagents.observer.v2` snapshots (payload version 3; version 2 rows remain readable). `/subagents-ui` and `Ctrl+Alt+F` toggle a content-fitted floating overlay with a two-line task block: role, turns, and truncated assignment headline, then provider/model/thinking, status, elapsed, and current tools; the themed panel wraps its rows in a background fill, keeps a pinned title row with a `[ ✕ ]` close chip on its right, stays above an 80-column floor without filling the terminal, and Escape is unbound. Keyed footer status, below-editor widget, and custom completion entries stay off by default. It must not call `setWorkingMessage` or `setFooter`, must stay inactive in headless modes, must not emit cancellation, and must not own scheduler state or final outcomes. `status-footer` and `work-timing` remain independent.
- The herdr-handoff extension may validate and execute one explicit-user-only foreground handoff to a persistent full coding agent through Herdr. Recipients are not capability-sandboxed; write authority is cooperative and detective via isolated linked worktrees and Git postflight. The extension owns the request/return bridge, launch-profile loading, CLI adaptation, identity checks, one blocking wait, bounded continuations, cancellation request, and redaction. It owns no semantic eligibility, plan approval, verification judgment, review adjudication, repair decision, automatic UI answers, automatic convergence, or completion claim. There is no fallback to `csheng_subagent_sessions`, another profile, or direct harness execution. Managed Herdr hooks and the official `herdr` Skill remain outside this package.
- Pi's skill command registry remains authoritative for loaded Skill names and source paths. This package does not independently discover, execute, or enforce a Skill repository, and subagent children load no Skills.
- Child roles are code-owned and fixed. The repository ships tested role-preferred peer routes and optional semantic profile mappings; a user-owned Pi-agent-directory overlay may change persistent defaults. Project repositories cannot provide routes, and the package never changes the parent model or provider settings.
- A task may provide fixed provider-neutral execution and reasoning profiles. When the user explicitly selects a concrete model or Pi thinking level, the parent may also pass ephemeral task `model` and `thinking` overrides for any role. Those fields override default selection without mutating package or user route configuration. The parent owns semantic projection; the extension never reads a plan or Skill.
- Missing declared plan-mode tools, invalid route configuration, project distrust, unsafe graphs, path escape, writable isolation failure, child failure, and candidate drift fail visibly without widening authority.

## Working Rules

- Keep each extension small and independently reversible.
- Persist only the minimum state needed to restore host behavior. Scheduling and active control remain foreground and memory-only. Managed native/source, replay, and candidate state persists only for explicit same-task actions. Historical one-shot workspaces were temporary diagnostic resources and are not a current runtime tool. Private JSONL remains evidence, never automatic orchestration or semantic resume state. The provenance manifest stores only the current opaque extension and configuration pair.
- Preserve ordinary Pi behavior outside each selected profile or explicit tool call and when an extension is disabled.
- Keep child prompts, capability files, snapshots, process output, and diagnostic storage bounded. Clean temporary resources on success, failure, timeout, abort, and session shutdown while retaining launched-child diagnostic sessions under their explicit retention policy.
- Keep probe and evaluator output redacted. Never print raw user settings, route files, model selectors, prompts, task IDs, credentials, environment values, session paths, or external file content.
- Treat package and user route files as read-only persistent defaults. Never create, edit, or delete either file to satisfy one dispatch; explicit task route failure is typed and has no fallback or retry.
- Do not add dynamic roles, shell to read-only/legacy children, background missions, durable orchestration ledgers, hidden model fallback, automatic retry, or a Skill-specific runtime contract without a separately approved design.
- Do not commit, push, npm-publish, deploy, create a remote, install packages globally, create a user route file, or change provider/model settings without explicit authority. The local snapshot publisher is `mise run publish-local-package` and still requires that explicit authority; it must not rewrite Pi settings.

## Validation

Run:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
```

The multi-skill mention probes use Pi print mode and cross model/provider preflight. `PI_OFFLINE=1` does not disable inference, so these probes require explicit provider-call authority and do not belong to the deterministic offline lane:

```bash
bash scripts/run-temporary-multi-skill-mentions-probe.sh
bash scripts/run-installed-multi-skill-mentions-probe.sh
```

The live subagent provider lane is separately authorized and never belongs to `npm test`. Parent owns acceptance of that lane; these instructions do not treat it as verified package co-load:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

The installed-host observer click check is also deliberate and never belongs to `npm test`; it resolves the installed `pi` binary and skips when that binary or util-linux `script` is unavailable:

```bash
npm run e2e:subagents-ui
```
