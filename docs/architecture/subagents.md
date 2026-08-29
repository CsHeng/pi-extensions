# Subagents

`extensions/subagents/index.ts` registers `csheng_subagents`, a bounded foreground delegation tool. One parent tool call may run a small directed acyclic graph of isolated Pi child processes. The extension owns execution mechanics only; it is not a second coding-agent lifecycle.

## Ownership boundary

| Truth owner | Owns | Does not own |
| --- | --- | --- |
| Skills | Provider-neutral semantic guidance, decomposition quality, delegation eligibility, and bounded review semantics | Child processes, concrete models, tool capabilities, scheduling, cancellation, or workspace isolation |
| Pi | The authoritative parent agent loop, model catalogue and authentication, tool execution, sessions, project trust, extension loading, and user interaction | This extension's role policy, graph validation, child path manifest, or convergence algorithm |
| `pi-extensions` | The subagent tool schema, fixed roles, route resolution, graph scheduling, subprocess lifecycle, child capability guard, writable snapshots, CAS convergence, bounded results, and removal semantics | Plan approval, semantic synthesis, verification judgment, review adjudication, repair decisions, continuation, or the final response |

The user remains the approval and cost authority. The parent Pi selects tasks and evaluates evidence. Each child executes one bounded task; its output is a claim rather than completion proof.

## Activation and parent authority

Loading the extension registers the tool, `/subagents` status command, and configured delegation guidance. It starts no child and changes no workspace until the parent calls the tool. Dispatch requires `ctx.isProjectTrusted()`.

The default guidance is `aggressive`: prefer delegation when at least two independent bounded repository slices can run concurrently. It does not delegate trivial work or parent-owned synthesis, verification, authority, adjudication, repair decisions, continuation, or the final response. A graph must stop before any such parent decision point; later work uses another parent tool call.

`plan-mode` remains independent. Its exact `read`, `grep`, `find`, and `ls` profile excludes the subagent tool while plan mode is active.

## Tool contract

The tool accepts one `tasks` array. A task contains:

- `id`: unique invocation-local identifier
- `role`: `explorer`, `reviewer`, or `worker`
- `objective`: bounded outcome
- `scope`: repository-relative read roots
- `inputs`: optional bounded parent-supplied text
- `dependsOn`: predecessor IDs
- `writePaths`: exact repository-relative files, required only for workers
- `verification`: expected parent evidence, never a child command
- `resourceLocks`: names that prevent simultaneous execution
- `executionProfile`: optional `fast`, `balanced`, or `deep` route intent
- `reasoningProfile`: optional `light`, `standard`, or `deep` reasoning intent

Dependencies express single work, serial chains, flat parallel work, fan-out, and fan-in through one schema. The tool does not accept arbitrary working directories, concrete task models, tool lists, commands, extensions, Skills, retries, background flags, or nested graphs. Model-facing role, execution-profile, and reasoning-profile choices serialize as direct string enums through Pi's provider-compatible `StringEnum` helper.

Hard ceilings are ten tasks and ten concurrent children, with role ceilings of four explorers, four reviewers, and two workers, a 15-minute task timeout, and a five-second TERM-to-KILL grace period. A mixed ready graph may therefore reach `4 + 4 + 2`; no graph may run ten workers. Prompt, predecessor, output, and stderr byte limits are exported from `contracts.ts` and tested. User configuration may lower but not raise concurrency ceilings.

Admission rejects duplicate IDs, unknown dependencies, cycles, unsafe paths, role-incompatible fields, missing worker writes, projected prompt overflow, invalid locks, and overlapping write paths between potentially concurrent tasks before any child starts.

## Fixed roles

| Role | Tools | Authority |
| --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls` | Collect bounded factual evidence; no mutation or design synthesis |
| `reviewer` | `read`, `grep`, `find`, `ls` | Return bounded candidate findings; no repair or adjudication |
| `worker` | `read`, `grep`, `find`, `ls`, `edit`, `write` | Create or modify exact declared files; no shell, deletion, rename, peer integration, or verification claim |

Roles and prompts are code-owned. The fixed role map owns only exact tools and prompts; write authority remains enforced by the task role, graph admission, child path guard, worker workspace, and convergence checks rather than a duplicate metadata boolean. The package does not discover role files. No child loads this tool, so recursive delegation is unavailable.

## Model routing

The repository-owned `config/csheng-subagents.json` is the packaged route baseline. Its role preferences are explorer Luna medium, worker Terra high, and reviewer Sol high, followed by the other two peer families in explicit role-owned order. The order is configuration preference and availability fallback, not a code-owned capability ranking. It also declares global concurrency 10, role concurrency `4/4/2`, `aggressive` guidance, and reasoning mappings `light=low`, `standard=medium`, and `deep=high`.

The optional user-owned override is `csheng-subagents.json` under Pi's public agent directory returned by `getAgentDir()`; the default location is `~/.pi/agent/csheng-subagents.json`. The loader keeps that path local rather than adding it to effective configuration. Project repositories cannot provide routes. The extension never creates or changes the user file. Missing user configuration applies the package baseline. A valid strict overlay may replace ordered `{ model, thinking }` candidates, add role execution-profile candidate lists, replace reasoning-profile mappings, lower concurrency limits, and select `off`, `balanced`, or `aggressive` guidance. Unmentioned package fields remain active. `$parent` remains available only when explicitly configured.

The parent may copy optional provider-neutral task intensity into `executionProfile` and `reasoningProfile`; the extension never discovers or parses a plan or Skill. A configured execution profile selects another role candidate list, then a configured reasoning profile overrides thinking. Missing task profiles use the role default. A known profile without a configured mapping visibly falls back to that default. `/subagents` reports effective default routes and caps without printing raw configuration.

This has the model-routing purpose of `~/.codex/agents/*.toml`, but it is not a compatibility layer for those files. Codex agent files combine role instructions, sandbox policy, and optional routing; this extension keeps role instructions and capability ceilings in `roles.ts` and accepts only optional model routing from Pi's agent directory. Provider and model identifiers remain Pi-owned.

Resolution checks the parent model, current thinking level, scoped models, authentication, and thinking support. The registry model object remains resolver-local; callers receive only the effective provider, model identifier, thinking level, source, candidate index, and semantic-profile decision needed for child execution and evidence. The child receives explicit `--model` and `--thinking` arguments. Unavailable candidates produce a typed failure unless the user listed another candidate; runtime errors do not trigger hidden fallback or retry. Child routing never changes the parent model or provider settings.

## Child process and path capability

Each task starts a non-session Pi JSON-mode subprocess with explicit role tools, model, thinking level, prompts, and one-run project approval after the parent trust check. Extension, Skill, and prompt-template discovery are disabled. Only `child-capability-guard.ts` is explicitly loaded.

A private mode-0600 capability manifest declares the child root, read roots, role, and exact write files. The guard checks every path-bearing tool call, resolves existing paths or their nearest existing ancestor, and denies traversal, absolute escape, physical symlink escape, role/tool mismatch, and undeclared writes. Changed-path reconciliation is a second enforcement layer.

Prompt, capability, and workspace directories are private temporary resources. Child output, stderr, and usage are bounded. Raw prompts, route files, credentials, environment values, and external file content are not rendered or emitted by probes.

## Writable isolation and convergence

Read-only children use the trusted parent repository directly. A worker requires a Git repository and receives a private snapshot containing current tracked files and non-ignored untracked files. The snapshot excludes `.git`, ignored material, escaping symlinks, external files, and special files.

The extension records existence, type, mode, and content digests for every write path. A successful worker is eligible for convergence only when its complete snapshot diff contains create-or-modify operations on declared regular files. Deletion, rename, mode change, symlink write, or another changed path fails the task.

Before applying bytes, the extension compares each parent path with its launch baseline. Matching paths receive a same-directory staged file and atomic rename with mode preservation. Parent drift returns `convergence_conflict`; the extension never merges or overwrites it. A non-Git writable task returns `writable_isolation_unavailable`, while read-only delegation remains available.

## Scheduling and failure behavior

Only one subagent graph may be active per extension session, so separate parent tool calls cannot bypass global concurrency, lock, or write-conflict controls. Ready tasks have every dependency succeeded and no active global, role, lock, or write conflict. Stable input order breaks ties. A failed task blocks its transitive dependents, while unrelated branches continue. There is no automatic retry or rollback. Successful independent writes may remain converged when another branch fails, and the parent receives `partial` for fix-forward handling.

The structured aggregate result records per-task status, effective route and profile decision, bounded output, usage, duration, changed paths, convergence state, stop reason, and typed error. Version-one redacted telemetry adds an invocation-local run ID, requested/admitted/launched counts, run duration, peak global and role concurrency, structured run errors, and task queue/workspace/child/convergence durations. It remains inside Pi's persisted tool result; there is no second ledger. Child prose cannot modify graph state.

Model-visible result text is independently capped at Pi's default 50 KiB and 2,000 complete lines. The renderer reserves a compact summary for every admitted task, including status, elapsed duration, effective route, convergence, changed-path count, and typed error code, then allocates the remaining byte and line budget fairly across task details with explicit truncation evidence. Structured details remain the authoritative per-task evidence.

`SubagentRunResult.status` owns domain outcome. `succeeded` maps to a non-error Pi tool result; `partial`, `failed`, and `aborted` map to `isError = true` through Pi's official `tool_result` event. Tool execution returns only typed content and details, so failures preserve structured evidence rather than relying on an ignored return member or throwing it away.

Abort stops new scheduling, terminates live children, escalates to KILL after the grace period, and removes private resources. `session_shutdown` captures the active run, aborts it idempotently, and waits for scheduler settlement, process close, workspace cleanup, listener removal, counters, and active-run reservation release before its handler resolves.

## Explicit exclusions

The extension has no background execution, durable graph, replay, resume, mission state, approval protocol, review gate, repair loop, settlement, generic permission framework, external-file write, child command runner, automatic model retry, dynamic role, or Skill-loading bridge. It does not install another package or mutate Pi settings.

## Verification and removal

```bash
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-multi-skill-mentions-probe.sh
bash scripts/run-installed-multi-skill-mentions-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
```

Unit and component tests own provider-compatible schema shape, routing, graph, process, guard, snapshot, convergence, telemetry, evaluator, aggregate renderer bounds, elapsed output, official host result interception, awaited shutdown cleanup, package peer ownership, extension behavior, cancellation, and regression behavior. Pi core packages imported by extension source are peer dependencies and exact development dependencies; clean `npm ci --ignore-scripts` plus typecheck proves local resolution without bundling another host copy. The subagent probes are offline and report fixed counts only; they do not start a model child.

The project-local `.agents/skills/evaluate-subagent-runs/` Skill reads one explicitly selected Pi session JSONL and emits a versioned redacted metric document. It never reads Pi SQLite, settings, credentials, logs, or unrelated sessions; never copies prompts, task IDs, child output, stderr, paths, environment values, or external content; and labels legacy launch/concurrency derivation as inference. Reports are written only to an explicit new output path. The first redacted production baseline is retained under `docs/evaluations/subagents/`.

The manual release/runtime lane is:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

The live E2E intentionally inherits the ambient Pi environment because current default provider selection and authentication are the boundary under test. It creates a disposable Git repository under `~/tmp`, temporary-loads the complete package or uses the installed package, and adds a test-only observer that blocks delegation unless `plan-mode`, `multi-skill-mentions`, and `subagents` are loaded together. Its single graph requires successful `explorer`, `reviewer`, and `worker` children, exact package-default role routes without task profiles, and worker convergence. It has a 20-minute process deadline, bounded capture, cleanup, no retry, and redacted fixed-shape output. It is never part of `npm test` because it consumes provider capacity and ambient authentication.

Removing only `./extensions/subagents/index.ts` from the package extension list and reloading Pi removes the tool and guidance. The other extensions, parent sessions, repository files, and any user-owned route file remain unchanged.
