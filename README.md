# Pi Extensions

This repository contains small, independently removable Pi extensions. It exports `plan-mode`, `multi-skill-mentions`, and `subagents` while preserving Pi's authoritative host agent loop.

## Plan Mode

`/plan` switches the current session to Pi's read-only `read`, `grep`, `find`, and `ls` tools and appends a compact planning instruction before model turns. `/default` restores the exact tool set that was active before plan mode. The `--plan` startup flag selects the same profile.

The extension stores only the selected profile and the tool set to restore. It does not own workflow phases, task graphs, review policy, approval gates, tool authorization, or settlement. Those decisions remain with the active coding agent, the user, and Pi's host loop.

## Multi-skill Mentions

Type `$` in the TUI to search loaded skills and insert one or more `$skill-name` mentions. On submission, the extension expands each uniquely mentioned loaded skill before the original prompt. Unknown names, escaped mentions such as `\$skill-name`, and ordinary shell variables remain unchanged.

`/skill-mentions` shows a short usage reminder and the number of currently loaded skills. The extension does not discover skills independently; Pi's command registry remains authoritative for available skill names and source paths.

## Subagents

`csheng_subagents` is a model-callable foreground delegation tool for one bounded task DAG. It supports deterministic fan-out, dependency joins, resource locks, fixed per-role model routes, isolated writable workers, bounded output, and cancellation. The parent Pi supplies the tasks and retains synthesis, verification, review adjudication, repair decisions, continuation, and the final response.

Fixed roles are:

- `explorer`: read-only factual search with `read`, `grep`, `find`, and `ls`
- `reviewer`: read-only candidate findings with the same tools
- `worker`: exact-file create or modify with `read`, `grep`, `find`, `ls`, `edit`, and `write`; no shell, deletion, or recursive delegation

Loading the extension registers the tool, `/subagents` status command, and delegation guidance. It starts no child and changes no workspace until the parent calls the tool. Dispatch requires a trusted project. `plan-mode` continues to expose only its original four tools, so subagent dispatch is unavailable while that profile is active.

The optional user route file is `csheng-subagents.json` under Pi's agent directory, normally `~/.pi/agent/csheng-subagents.json`. An absent file inherits the active parent model and thinking level for every role, which is the recommended setup when all roles should use Pi's current default provider and model. Configuration may supply ordered role candidates, lower concurrency limits, and `off`, `balanced`, or `aggressive` guidance. This serves the model-routing purpose of per-role Codex agent files, but the extension does not read `~/.codex/agents/*.toml`: Pi role prompts and tool ceilings remain code-owned, while the optional JSON file contains routing only. The package never creates this file or changes the parent session model or provider settings.

Workers operate in private snapshots of tracked and non-ignored repository files. The extension accepts only declared create-or-modify results and applies them after exact parent-baseline checks. Parent drift, undeclared changes, symlink writes, deletion, rename, or mode changes fail closed. Writable delegation requires Git; read-only delegation does not.

See [`docs/architecture/subagents.md`](docs/architecture/subagents.md) for the three-owner boundary, complete tool contract, routing, scheduling, isolation, failure behavior, and removal semantics.

## Package

The private package exposes exactly:

```text
extensions/plan-mode/index.ts
extensions/multi-skill-mentions/index.ts
extensions/subagents/index.ts
```

Each extension keeps independent behavior, state, tests, and removal semantics while sharing one Pi package.

## Local Development

```bash
npm ci --ignore-scripts
npm run check
```

Temporary-load and installed-package probes live under `scripts/`. The opt-in live E2E uses Pi's ambient default provider and authentication, creates and removes a disposable Git repository under `~/tmp`, loads all three package extensions together, and requires successful `explorer`, `reviewer`, and converged `worker` results on one inherited parent route:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

The first command temporary-loads the complete package with ordinary global extensions disabled. The second verifies the globally installed package. Both make real model calls and emit only a bounded summary. Global installation, user route creation, provider calls, and settings changes remain explicit gates and are never performed by `npm test`.

## Safety

If a future Pi release does not expose one of the declared plan-mode read-only tools, plan mode activates only the available subset and reports the mismatch. Subagent graph, route, path, process, and convergence failures return typed bounded evidence and do not widen authority or trigger hidden retries. Probe output contains fixed redacted fields rather than prompts, user settings, credentials, or external file content.
