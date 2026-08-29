# AGENTS.md

## Project

This repository is the authored source for small local Pi extensions. Extensions may change the host loop's active tools, prompt context, editor completion behavior, or execute one bounded foreground delegation call, but must not replace the coding agent with a second lifecycle engine.

The package exposes `plan-mode` as a reversible loop profile, `multi-skill-mentions` as an explicit prompt expansion mechanism, and `subagents` as a bounded in-memory delegation DAG executor. Keep each extension's behavior, state, tests, and removal semantics independent.

## Layout

- `extensions/plan-mode/`: reversible read-only tool profile
- `extensions/multi-skill-mentions/`: TUI completion and input expansion for loaded skills
- `extensions/subagents/`: fixed child roles, routing, scheduling, subprocess, path guard, writable snapshots, and convergence
- `tests/`: deterministic, fake-Pi, subprocess, filesystem, and disposable-Git tests
- `scripts/`: redacted temporary-load, installed-package, and explicitly gated live E2E probes
- `docs/architecture/`: stable product and maintenance truth
- `docs/plans/`: stage artifacts and migration history, not runtime input

## Boundaries

- Pi's public extension API, active tool set, model context and registry, project trust, session events, and startup flags are runtime inputs.
- The host Pi loop remains authoritative for parent model turns, tool execution, persistence, user interaction, and final responses.
- A profile may select tools and append compact loop guidance. It must not introduce task graphs, schedulers, approval protocols, review gates, settlement, or a generic permission framework.
- The subagent extension may validate and execute one foreground, hard-bounded, in-memory DAG submitted by the parent. It owns physical child routing, readiness, concurrency, locks, cancellation, path capabilities, isolated worker snapshots, and mechanical convergence; it owns no semantic lifecycle, approval, verification judgment, review adjudication, repair decision, continuation, or durable run state.
- Pi's skill command registry remains authoritative for loaded Skill names and source paths. This package does not independently discover, execute, or enforce a Skill repository, and subagent children load no Skills.
- Child roles are code-owned and fixed. Concrete child routes are optional user-owned input under Pi's agent directory; project repositories cannot provide routes, and the package never changes the parent model or provider settings.
- Missing declared plan-mode tools, invalid route configuration, project distrust, unsafe graphs, path escape, writable isolation failure, child failure, and convergence drift fail visibly without widening authority.

## Working Rules

- Keep each extension small and independently reversible.
- Persist only the minimum state needed to restore host behavior; subagent runs remain foreground and memory-only.
- Preserve ordinary Pi behavior outside each selected profile or explicit tool call and when an extension is disabled.
- Keep child prompts, capability files, snapshots, and process output bounded; clean private resources on success, failure, timeout, abort, and session shutdown.
- Keep probe output redacted. Never print raw user settings, route files, prompts, credentials, environment values, or external file content.
- Do not add dynamic roles, child shell, background missions, durable task ledgers, hidden model fallback, automatic retry, or a Skill-specific runtime contract without a separately approved design.
- Do not commit, push, publish, deploy, create a remote, install packages globally, create a user route file, or change provider/model settings without explicit authority.

## Validation

Run:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-multi-skill-mentions-probe.sh
bash scripts/run-installed-multi-skill-mentions-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
```

The live provider lane is separately authorized and never belongs to `npm test`:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```
