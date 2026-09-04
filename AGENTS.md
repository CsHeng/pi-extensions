# AGENTS.md

## Project

This repository is the authored source for small local Pi extensions. Extensions may change the host loop's active tools, prompt context, editor completion behavior, provider request payload, or execute one bounded foreground delegation call, but must not replace the coding agent with a second lifecycle engine.

The package exposes `plan-mode` as a reversible loop profile, `multi-skill-mentions` as an explicit prompt expansion mechanism, `fast-gpt` as a branch-local request profile, `subagents` as a bounded foreground delegation DAG executor with retained diagnostic session evidence, `herdr-handoff` as an explicit-user-only bridge to one persistent Herdr-managed full agent, `session-id-footer` as a TUI-only decoration of Pi's built-in footer, and `work-timing` as TUI-only timing feedback. Keep each extension's behavior, state, tests, and removal semantics independent. `subagents-ui` remains in source as an optional TUI consumer and is not in the default package load list.

## Layout

- `extensions/plan-mode/`: reversible read-only tool profile
- `extensions/multi-skill-mentions/`: TUI completion and input expansion for loaded skills
- `extensions/fast-gpt/`: branch-local OpenAI Responses service-tier request profile
- `extensions/subagents/`: fixed child roles, routing, scheduling, subprocess, path guard, writable snapshots, and convergence
- `extensions/subagents-ui/`: optional TUI-only lifecycle status, inspector, and confirmed cancellation requests; not loaded by default
- `extensions/herdr-handoff/`: explicit-user-only Herdr CLI adapter, launch profiles, isolated-worktree evidence, and bounded continuations
- `extensions/session-id-footer/`: TUI footer decoration that keeps the current session UUID visible
- `extensions/work-timing/`: live request and reasoning timing with durable TUI-only completion entries
- `config/csheng-subagents.json`: packaged role routes, semantic-profile mappings, and concurrency defaults
- `.agents/skills/evaluate-subagent-runs/`: maintainer-only read-only evaluator, excluded from the npm package
- `tests/`: deterministic, fake-Pi, subprocess, filesystem, evaluator, and disposable-Git tests
- `scripts/`: redacted temporary-load, installed-package, and explicitly gated live E2E probes
- `docs/architecture/`: stable product and maintenance truth
- `docs/evaluations/`: bounded retained evidence, not a second truth owner
- `docs/plans/`: stage artifacts and migration history, not runtime input
- `docs/.ignore`: default search boundary that excludes stage history without affecting Git tracking
- `contracts/markdown-prose.toml`: exact immutable prose-format exceptions for retained historical artifacts

## Boundaries

- Pi's public extension API, active tool set, model context and registry, project trust, session events, and startup flags are runtime inputs.
- The host Pi loop remains authoritative for parent model turns, tool execution, persistence, user interaction, and final responses.
- A profile may select tools and append compact loop guidance. It must not introduce task graphs, schedulers, approval protocols, review gates, settlement, or a generic permission framework.
- The fast-gpt extension may toggle branch-local official OpenAI and OpenAI-Codex Responses requests between top-level `service_tier: priority` and explicit `default`. Until the first `/fast-gpt` command, and for unsupported provider/API/model correlations, requests remain unchanged. Pi and the provider remain authoritative for usage and cost; the extension owns no model alias, provider override, pricing parser, live call, or workflow.
- The session-id-footer extension may replace the TUI footer only to preserve Pi's exported built-in footer rendering while appending the current session UUID to its first line. It must remain inactive in RPC, JSON, and print modes and must not persist session metadata.
- The work-timing extension may customize the TUI working message while an interaction is active and append one context-free completion entry after `agent_settled`. Reasoning duration is client-observed time between streamed thinking start and end events; total duration spans `before_agent_start` through final settlement. Collapsed and expanded completion entries show total wall time, total reasoning, and the rounded reasoning share of wall time. It must clean up its interval on settlement and session shutdown and remain inactive in headless modes.
- The subagent extension may validate and execute one foreground, hard-bounded, in-memory task batch with optional hard predecessor edges submitted by the parent. Ordinary delegation stays flat; semantic hard-edge eligibility remains parent-owned. The extension owns physical child routing, readiness, concurrency, locks, cancellation, path capabilities, isolated worker snapshots, mechanical convergence, private retained Pi-native child sessions for diagnosis, bounded lifecycle snapshots, and opaque effective-revision provenance. After parent-project trust, it canonicalizes current-repository `scope` against the Git toplevel and may grant explorer or reviewer tasks at most eight exact Git-contained `externalReadRoots` supplied by the parent call. It does not load external project resources, grant external writes, read Pi trust storage, or treat another repository as child cwd. Those child sessions are evidence only: the extension owns no semantic lifecycle, approval, verification judgment, review adjudication, repair decision, continuation, durable orchestration, workspace recovery, or resumable mission state. Task-targeted cancellation during worker convergence returns too-late; run cancellation stops cancellable work and lets an entered critical section finish.
- The subagents-ui extension may consume bounded snapshots over `pi.events`, render keyed TUI status and a below-editor panel, open a live inspector, and emit confirmed cancellation requests. It must not call `setWorkingMessage` or `setFooter`, must stay inactive in headless modes, and must not own scheduler state or final outcomes.
- The herdr-handoff extension may validate and execute one explicit-user-only foreground handoff to a persistent full coding agent through Herdr. Recipients are not capability-sandboxed; write authority is cooperative and detective via isolated linked worktrees and Git postflight. The extension owns the request/return bridge, launch-profile loading, CLI adaptation, identity checks, one blocking wait, bounded continuations, cancellation request, and redaction. It owns no semantic eligibility, plan approval, verification judgment, review adjudication, repair decision, automatic UI answers, automatic convergence, or completion claim. There is no fallback to `csheng_subagents`, another profile, or direct harness execution. Managed Herdr hooks and the official `herdr` Skill remain outside this package.
- Pi's skill command registry remains authoritative for loaded Skill names and source paths. This package does not independently discover, execute, or enforce a Skill repository, and subagent children load no Skills.
- Child roles are code-owned and fixed. The repository ships tested role-preferred peer routes and optional semantic profile mappings; a user-owned Pi-agent-directory overlay may change persistent defaults. Project repositories cannot provide routes, and the package never changes the parent model or provider settings.
- A task may provide fixed provider-neutral execution and reasoning profiles. When the user explicitly selects a concrete model or Pi thinking level, the parent may also pass ephemeral task `model` and `thinking` overrides for any role. Those fields override default selection without mutating package or user route configuration. The parent owns semantic projection; the extension never reads a plan or Skill.
- Missing declared plan-mode tools, invalid route configuration, project distrust, unsafe graphs, path escape, writable isolation failure, child failure, and convergence drift fail visibly without widening authority.

## Working Rules

- Keep each extension small and independently reversible.
- Persist only the minimum state needed to restore host behavior. Subagent scheduling, locks, workspaces, and convergence remain foreground and memory-only; private child session JSONL may persist as bounded user-owned diagnostic evidence, never as orchestration or resume state. The provenance manifest stores only the current opaque extension and configuration pair.
- Preserve ordinary Pi behavior outside each selected profile or explicit tool call and when an extension is disabled.
- Keep child prompts, capability files, snapshots, process output, and diagnostic storage bounded. Clean temporary resources on success, failure, timeout, abort, and session shutdown while retaining launched-child diagnostic sessions under their explicit retention policy.
- Keep probe and evaluator output redacted. Never print raw user settings, route files, model selectors, prompts, task IDs, credentials, environment values, session paths, or external file content.
- Treat package and user route files as read-only persistent defaults. Never create, edit, or delete either file to satisfy one dispatch; explicit task route failure is typed and has no fallback or retry.
- Do not add dynamic roles, child shell, background missions, durable task ledgers, hidden model fallback, automatic retry, or a Skill-specific runtime contract without a separately approved design.
- Do not commit, push, publish, deploy, create a remote, install packages globally, create a user route file, or change provider/model settings without explicit authority.

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

The live subagent provider lane is separately authorized and never belongs to `npm test`:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```
