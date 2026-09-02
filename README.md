# Pi Extensions

This repository contains small, independently removable Pi extensions. It exports `plan-mode`, `multi-skill-mentions`, `fast-gpt`, `subagents`, and `herdr-handoff` while preserving Pi's authoritative host agent loop.

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

Loading the extension registers the tool, `/subagents` status command, and delegation guidance. It starts no child and changes no workspace until the parent calls the tool. Dispatch requires a trusted project. `plan-mode` continues to expose only its original four tools, so subagent dispatch is unavailable while that profile is active.

The repository ships its route baseline at [`config/csheng-subagents.json`](config/csheng-subagents.json). It prefers explorer Luna medium, worker Terra high, and reviewer Sol high, with explicit peer fallback order, global concurrency 10, role ceilings `4/4/2`, reasoning-profile mappings, and `aggressive` guidance. Model names remain opaque configuration; extension code does not rank the peer families.

The optional user override is `csheng-subagents.json` under Pi's agent directory, normally `~/.pi/agent/csheng-subagents.json`. An absent override applies the package baseline. A strict overlay may replace role candidates, add execution-profile candidate lists, override reasoning-profile entries, or lower concurrency. Package and user files are read-only persistent defaults: the extension never creates, edits, or deletes them.

Tasks may provide optional provider-neutral `executionProfile` and `reasoningProfile` values; missing or unmapped values visibly use the role default. When the user explicitly selects a concrete model or Pi thinking level, any role may also receive ephemeral `model` and `thinking` task fields. Exact explicit selection resolves against Pi's model registry, overrides role/profile defaults, and either launches that route or returns a typed pre-launch failure with no fallback. The extension never reads a plan or Skill. This serves the model-routing purpose of per-role Codex agent files, but the extension does not read `~/.codex/agents/*.toml`: Pi role prompts and tool ceilings remain code-owned, while JSON contains persistent routing defaults only. The package never changes the parent session model or provider settings.

Workers operate in private snapshots of tracked and non-ignored repository files. The extension accepts only declared create-or-modify results and applies them after exact parent-baseline checks. Parent drift, undeclared changes, symlink writes, deletion, rename, mode changes, or a true zero-diff worker fail closed. Writable delegation requires Git; read-only delegation does not.

See [`docs/architecture/subagents.md`](docs/architecture/subagents.md) for the three-owner boundary, complete tool contract, routing, scheduling, isolation, telemetry, evaluation, failure behavior, and removal semantics.

## Herdr Handoff

`herdr_handoff` is an explicit-user-only bridge to one persistent vendor-native coding agent managed by Herdr. Pi remains the plan, verification, review-adjudication, repair, truth-sync, and closure owner. The extension waits without polling, parses an untrusted return envelope, and records Git postflight in a distinct linked worktree. It does not sandbox the full agent, auto-converge isolated output, or treat recipient settlement as completion.

`delegate-return` is the default: Pi freezes the plan, waits for settlement, then resumes with evidence. `transfer` waits only until Herdr confirms prompt delivery and an observed `working` transition, then relinquishes outcome ownership. Targets are exact: message one already-running named agent, or `start-and-ask` with one user-owned launch profile from `herdr-handoff.json` under Pi's agent directory. There is no package profile, no project overlay, and no fallback to `csheng_subagents` or another harness.

Recipient write authority is cooperative. First-release recipients must occupy a distinct linked worktree of the same Git repository. Postflight accepts only declared regular-file create or modify operations. Timeout, blocked UI, malformed return, and unconfirmed cancellation return typed handles rather than widening authority.

`/herdr-handoff` reports redacted environment and handle status. `plan-mode` continues to expose only its original four tools, so the handoff tool is inactive while that profile is selected. The official `herdr` Skill remains optional manual guidance and is not a runtime dependency.

See [`docs/architecture/herdr-handoff.md`](docs/architecture/herdr-handoff.md) for the request/return protocol, launch profiles, workspace evidence, cancellation, failure, redaction, and removal contracts.

## Package

The private package exposes exactly:

```text
extensions/plan-mode/index.ts
extensions/multi-skill-mentions/index.ts
extensions/fast-gpt/index.ts
extensions/subagents/index.ts
extensions/herdr-handoff/index.ts
```

Each extension keeps independent behavior, state, tests, and removal semantics while sharing one Pi package.

## Documentation

`docs/architecture/` owns stable extension truth, `docs/evaluations/` retains bounded redacted evidence, and `docs/plans/` retains stage history outside default documentation search. See [`docs/README.md`](docs/README.md) for the search boundary.

## Local Development

```bash
npm ci --ignore-scripts
npm run check
```

Temporary-load and installed-package probes live under `scripts/`. Plan-mode, subagent, and herdr-handoff probes use RPC fixtures without model calls. The small fast-gpt payload boundary is owned by deterministic unit tests and adds no probe command. The multi-skill mention probes use Pi print mode, cross model/provider preflight, and may make a model call when authentication is available; `PI_OFFLINE=1` disables update traffic but does not disable inference. Run those probes only with explicit provider-call authority.

The opt-in live subagent E2E uses Pi's ambient authentication, creates and removes a disposable Git repository under `~/tmp`, loads the complete package, and requires the three package-default role routes plus successful `explorer`, `reviewer`, and converged `worker` results:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

The first command temporary-loads the complete package with ordinary global extensions disabled. The second verifies the globally installed package. Both make real model calls and emit only a bounded summary. Global installation, user route creation, provider calls, and settings changes remain explicit gates and are never performed by `npm test`.

Maintainers can evaluate an explicitly selected persisted run with `.agents/skills/evaluate-subagent-runs/`. Metric schema version two adds requested/admitted tasks, singleton calls, hard dependency edges, explicit-route attribution, and zero-change workers while reading older telemetry with explicit unavailable evidence. The extractor remains redacted and does not retain raw model selectors, prompts, task IDs, child output, paths, credentials, or external content.

## Safety

If a future Pi release does not expose one of the declared plan-mode read-only tools, plan mode activates only the available subset and reports the mismatch. Fast-gpt leaves unsupported request correlations unchanged and defers usage and cost truth to Pi and the provider response. Subagent graph, route, path, process, and convergence failures return typed bounded evidence and do not widen authority or trigger hidden retries. Herdr handoff failures return typed bridge, recipient, and workspace evidence without treating settlement as verification or falling back to another agent. Probe output contains fixed redacted fields rather than prompts, user settings, credentials, or external file content.
