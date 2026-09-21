# Subagents

`extensions/subagents/index.ts` registers the managed `csheng_subagent_sessions` tool. The managed transport, trusted host tools, retained working state, candidates, native observations, and observer publisher are owned by [Managed Subagent Execution](subagent-execution.md). One parent tool call runs a flat create batch by default and may include mechanically validated hard predecessor edges. The extension owns execution mechanics only; it is not a second coding-agent lifecycle.

Historical one-shot `csheng_subagents`, `/subagents-debug`, automatic snapshot convergence, and snapshot UI v1 are not registered runtime surfaces. Their remaining meaning is architecture and evaluator reading below, not a current parent instruction.

## Ownership boundary

| Truth owner | Owns | Does not own |
| --- | --- | --- |
| Skills | Provider-neutral semantic guidance, decomposition quality, delegation eligibility, and bounded review semantics | Child processes, concrete models, tool capabilities, scheduling, cancellation, or workspace isolation |
| Pi | The authoritative parent agent loop, model catalogue and authentication, tool execution, standard session JSONL format and writes, project trust, extension loading, and user interaction | This extension's diagnostic path policy, role policy, graph validation, child path manifest, or candidate-export algorithm |
| `pi-extensions` | The managed tool schema, fixed roles, route resolution, graph scheduling, subprocess lifecycle, child capability guard, managed native/source/candidate mechanics, bounded live activity, observer-event publication, bounded results, and removal semantics | Plan approval, semantic synthesis, verification judgment, review adjudication, repair or continuation decisions, session-format migration, or the final response |

The user remains the approval and cost authority. The parent Pi selects tasks and evaluates evidence. Each child executes one bounded task; its output is a claim rather than completion proof.

## Activation and parent authority

Loading the extension registers `csheng_subagent_sessions`, `/subagents` status command, the ephemeral current-owner index, observation hooks, configured delegation guidance, and TUI observer-event publication. It starts no child and changes no workspace until the parent calls the tool. Dispatch requires `ctx.isProjectTrusted()`. The package index does not register `csheng_subagents` or `/subagents-debug`.

Runtime telemetry schema four retains schema-three wall start time, opaque extension and configuration epochs when provenance is available, and effective concurrency caps, and adds explicit monotonic timing evidence. `$evaluate-subagent-runs` accepts one explicit session and can, with an explicit sessions root and provenance manifest, select current-epoch schema-three and schema-four historical one-shot runs. Managed v2 invocation evidence is evaluated separately under metric-v4 `managedDispatch`; it does not change historical one-shot totals or replace owned native observations. Plan eligibility remains unavailable without separately approved plan evidence.

The default guidance is `aggressive`: prefer one flat `csheng_subagent_sessions` create batch when at least two independent bounded repository slices can run concurrently. A singleton remains valid for a required isolated worker or one independent reviewer, not ordinary parent-work offload. A single episode may complete the task; continuation is explicit. Parent owns synthesis, verification, acceptance, apply, and close. File-dependent successors require explicit parent apply between dispatches; dependency edges pass reports, not candidate files. Guidance does not delegate trivial work or parent-owned synthesis, verification, authority, adjudication, repair decisions, continuation, or the final response. A batch must stop before any such parent decision point; later work uses another parent tool call.

## Managed create task contract

`csheng_subagent_sessions` `create` accepts `requestId` and one `tasks` array. A task contains:

- `id`: unique invocation-local identifier
- `role`: `explorer`, `reviewer`, or `worker`
- `objective`: bounded outcome
- `scope`: preferred repository-relative read roots; `.` means the repository root. After parent-project trust, physically contained absolute or parent-traversing spellings are canonicalized to repository-relative form against the Git toplevel. Managed workers require `scope: ["."]`
- `inputs`: optional bounded parent-supplied text
- `dependsOn`: optional hard predecessor IDs
- `writePaths`: optional advisory repository-relative write regions for v3 workers; absolute paths and parent traversal remain rejected. Git discovers actual additions, deletions, renames and mode changes.
- `externalReadRoots`: optional explorer/reviewer-only exact absolute Git-contained read roots outside the current repository, at most eight entries
- `verification`: expected parent evidence, never a child command
- `resourceLocks`: names that prevent simultaneous execution
- `executionProfile`: optional `fast`, `balanced`, or `deep` route intent
- `reasoningProfile`: optional `light`, `standard`, or `deep` reasoning intent
- `model`: optional exact ephemeral model selector for an explicit user choice
- `thinking`: optional exact Pi level from `off` through `max` for an explicit user choice

Ordinary tasks omit `dependsOn` and run as a flat batch. Hard edges represent only approved implementation order with no intervening parent decision; the extension validates mechanics but never detects an active Skill. Edges pass predecessor reports, not candidate files. The tool does not accept arbitrary working directories, tool lists, commands, extensions, Skills, retries, background flags, or nested graphs. Model-facing role, execution-profile, reasoning-profile, and thinking choices serialize as direct string enums where bounded through Pi's provider-compatible `StringEnum` helper. Worker write files are never inferred. Empty `externalReadRoots: []` on a worker and `writePaths: []` on a read-only task are authority-neutral. Nonempty worker external roots and nonempty read-only writes are rejected.

The task batch has a hard ceiling of ten tasks, plus a 15-minute task timeout, a ten-second settled-exit grace, and a five-second TERM-to-KILL grace period. Global and per-role concurrency are positive safe integers owned by the effective package and user route configuration rather than code ceilings. The scheduler enforces both limits: when the sum of ready role capacity exceeds global capacity, the global value limits launches without rejecting the configuration. A batch still cannot launch more children than its admitted task count. Prompt, predecessor, output, stderr, diagnostic storage, discovery, timeline, line, and rendered-byte limits are exported from `contracts.ts` and tested.

Admission is split by authority. Schema and structural graph validation check task count, IDs, roles, bounds, write-path shape, worker external-root bans, dependencies, cycles, locks, and concurrent write overlap without filesystem probing. Current-project trust is checked next. Trusted repository admission then discovers the canonical Git toplevel, canonicalizes internal `scope`, resolves external read roots, and returns typed pre-launch failures without raw path text. Relational graph validation then applies canonical `writePaths`-within-`scope` checks. One invalid task rejects the complete batch. Missing internal scope remains admissible when its nearest existing ancestor is physically contained, which preserves create-file workers. Unsafe control characters, overlong paths, physical escape, non-Git parent workspaces, and undeclared external access fail before route resolution, diagnostics, workspace creation, or child launch. The parent call is the external-read grant; the extension does not read Pi trust storage or load external `.pi` settings, extensions, Skills, templates, or AGENTS files.

## Fixed roles

| Role | Tools | Authority |
| --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls` | Collect bounded factual evidence; no mutation or design synthesis |
| `reviewer` | `read`, `grep`, `find`, `ls` | Return bounded candidate findings; no repair or adjudication |
| `worker` (managed) | The same native tools plus `bash` | Trusted host local implementation/test/repair; explicit Git candidate integration and parent acceptance remain separate |

The managed worker is the same fixed worker role with its explicit transport's tool set, not a dynamic role. Bash is not capability-sandboxed; file guards and candidate checks do not create OS authority boundaries. Roles and prompts are code-owned. The fixed role map owns only exact tools and prompts; write authority remains enforced by the task role, graph admission, child path guard, worker workspace, and candidate checks rather than a duplicate metadata boolean. The package does not discover role files. No child loads this tool, so recursive delegation is unavailable.

## Model routing

The repository-owned `config/csheng-subagents.json` is the packaged route baseline. Its role preferences are explorer Luna medium, worker Terra high, and reviewer Sol high, followed by the other two peer families in explicit role-owned order. The order is configuration preference and availability fallback, not a code-owned capability ranking. It also declares global concurrency 10, role concurrency `4/4/2`, `aggressive` guidance, and reasoning mappings `light=low`, `standard=medium`, and `deep=high`.

The optional user-owned override is `csheng-subagents.json` under Pi's public agent directory returned by `getAgentDir()`; the default location is `~/.pi/agent/csheng-subagents.json`. The loader keeps that path local rather than adding it to effective configuration. Project repositories cannot provide routes. The extension never creates or changes the user file. Missing user configuration applies the package baseline. A valid strict overlay may replace ordered `{ model, thinking }` candidates, add role execution-profile candidate lists, replace reasoning-profile mappings, replace global or per-role concurrency with positive safe integers, and select `off`, `balanced`, or `aggressive` guidance. Unmentioned package fields remain active. `$parent` remains available only when explicitly configured.

The parent may copy optional provider-neutral task intensity into `executionProfile` and `reasoningProfile`; the extension never discovers or parses a plan or Skill. A configured execution profile selects another role candidate list, then a configured reasoning profile overrides thinking. Missing task profiles use the role default. A known profile without a configured mapping visibly falls back to that default. `/subagents` reports effective default routes and caps without printing raw configuration.

When the user explicitly names a model or exact thinking level, the parent may pass task `model` and `thinking` for explorer, reviewer, or worker. Explicit `model` supersedes role candidates, execution-profile model mapping, and session cycling scope; role still owns tools, paths, concurrency, isolation, and candidate export. Explicit `thinking` supersedes `reasoningProfile`; with a default route it may select the first ordered candidate supporting that exact level, while an explicit model never falls back to another model or level. An explicit model without a task reasoning override inherits the parent turn's exact thinking level.

This has the model-routing purpose of `~/.codex/agents/*.toml`, but it is not a compatibility layer for those files. Codex agent files combine role instructions, sandbox policy, and optional routing; this extension keeps role instructions and capability ceilings in `roles.ts` and accepts only optional model routing from Pi's agent directory. Provider and model identifiers remain Pi-owned.

Default resolution checks the parent model, current thinking level, scoped models, authentication, and thinking support. Explicit model resolution takes one public `getAll()` and `getAvailable()` registry snapshot. It tries case-insensitive exact `provider/model`, normalized exact bare ID, then normalized exact display name; normalization applies Unicode NFKC, lowercase, punctuation-run collapse, and trim. It never uses partial or catalogue-order matching. Missing, unavailable, ambiguous, and unsupported-thinking choices return typed `model_not_found`, `model_unavailable`, `ambiguous_model`, or `thinking_unavailable` failures before child launch. Ambiguous and unavailable diagnostics retain at most eight sorted canonical candidates.

The registry model object remains resolver-local; callers receive only the effective provider, model identifier, thinking level, persistent configuration source, selection source, candidate index, and semantic-profile decision needed for child execution and evidence. `selectionSource` is `role-default` or `explicit-task`; it does not independently prove user intent. The child receives explicit `--model` and `--thinking` arguments. Runtime errors do not trigger hidden fallback or retry. Routing never writes the packaged or user route file and never changes the parent model or provider settings.

## Child process and path capability

Each episode starts a Pi JSON-mode subprocess with explicit role tools, model, thinking level, prompts, one-run project approval after the parent trust check, and one private `--session` path. Extension, Skill, and prompt-template discovery are disabled. Read-only children load `child-capability-guard.ts`; managed workers load `worker-tools.ts`. `--no-session` is not used.

Managed native history is the private JSONL under `<getAgentDir()>/subagent-managed-sessions/...`. That root is separate from ordinary Pi `sessions/` discovery and from the historical one-shot diagnostic sibling described below. A separate private mode-0600 capability manifest is produced as version two: child root, role, internal read roots, legacy exact write files, and `externalReadRoots`, plus optional `writeRoot: true` for managed v3 workers. Root-write mode permits native source writes only within the task root and excludes `.git` and `node_modules`; old manifests retain exact-file semantics. Relative child reads resolve only under the internal root. Absolute reads must lexically match a declared internal or external file or subtree and then pass physical `realpath` containment. Recursive `grep` and `find` over an admitted directory fail when a descendant symlink escapes that same canonical root. External roots are never considered for writes. Ordinary safely blocked calls return nonfatal tool errors so the child can correct its arguments. Missing or invalid capability state and canonical-root integrity loss terminate and latch the guard.

Prompt, capability, and workspace directories are private temporary or managed resources. Canonical external roots may appear in the private child prompt and retained private child session. Extension-authored progress, summary metadata, telemetry, evaluator reports, probes, and observer snapshots do not add or copy those roots. Bounded child output and stderr remain untrusted evidence and are not rewritten if they echo a path. Raw prompts, route files, credentials, environment values, and external file content are not rendered or emitted by probes.

## Scheduling and failure behavior

Only one mutating managed batch may be active per extension session, so separate parent tool calls cannot bypass global concurrency, lock, or write-conflict controls. Ready tasks have every dependency succeeded and no active global, role, lock, or write conflict. Stable input order breaks ties. A failed task blocks its transitive dependents, while unrelated branches continue. There is no automatic retry, rollback, or auto-apply. Successful independent episodes may remain recorded when another branch fails, and the parent receives `partial` for fix-forward handling.

A successful child requires newline-complete bounded JSON framing, a nonempty final assistant report with `stopReason: stop`, observed settlement, and no unfinished assistant or tool activity. The parser joins all final text blocks and clears stale output on later activity; native delta updates do not require a full message envelope. Empty exit-zero streams, malformed or truncated framing, and incomplete reports fail closed with `incomplete_report` or the owning protocol/process error. Usage and earlier recoverable error evidence remain observable without overriding a valid final report.

Model-visible result text is independently capped at Pi's default 50 KiB and 2,000 complete lines. Structured details remain the authoritative per-task evidence.

`SubagentRunResult.status` owns domain outcome for scheduled work. `succeeded` maps to a non-error Pi tool result; `partial`, `failed`, and `aborted` map to `isError = true` through Pi's official `tool_result` event. Tool execution returns only typed content and details, so failures preserve structured evidence rather than relying on an ignored return member or throwing it away.

Every accepted child JSON event updates bounded activity immediately; one run-scoped five-second heartbeat advances elapsed and inactivity evidence while work is running. Progress includes each task's effective `provider/model:thinking` route and distinguishes startup, running, settling, `settled-awaiting-exit`, and process close without copying event payloads. Tool-result and assistant-turn errors increment a cumulative `errs` counter but do not change a running child's lifecycle phase or determine its final task status. `agent_end` is informative only because Pi may retry or compact. `agent_settled` starts the ten-second process-exit grace; failure to close triggers the existing TERM-to-KILL escalation and returns `child_exit_stalled`. Inactivity alone is evidence, not a failure trigger.

Live TUI tool progress uses the run clock rather than the longest child. In TUI mode the core also publishes bounded `csheng.subagents.observer.v2` snapshots (payload version 3) with launched/running/finished counts, aggregate assistant turns, elapsed time, a truncated assignment headline, current tool names, and per-task model/thinking/turns/elapsed facts. Default-loaded `subagents-ui` consumes those snapshots as a read-only overlay; see [Subagents UI](subagents-ui.md). `status-footer` and `work-timing` remain independent.

Abort stops new scheduling, terminates live children, escalates to KILL after the grace period, and removes temporary private resources while preserving started-child managed evidence. A first-cause latch prevents user abort, timeout, storage limit, and exit stall from overwriting one another. `session_shutdown` stops admission, cancels every known session-owned run, and awaits scheduler/process settlement and temporary-resource cleanup before resolving. Managed worktrees and evidence remain retained until explicit close/discard; shutdown never resumes or applies them.

## Historical one-shot reading

The following describes the retired one-shot `csheng_subagents` contract. It is not a current parent tool, command, or auto-apply instruction. Evaluator legacy counters remain explicitly `csheng_subagents-only`; see `$evaluate-subagent-runs`.

Historical `csheng_subagents` accepted one `tasks` array with the same task shape. Loading registered that tool, `/subagents-debug`, and delegation guidance that named `csheng_subagents`. Historical one-shot workers used `read`, `grep`, `find`, `ls`, `edit`, and `write` without shell. Eligible declared regular-file create-or-modify diffs were auto-applied after exact parent-baseline checks; parent drift, undeclared changes, symlink writes, deletion, rename, mode changes, or a true zero-diff worker failed closed. That auto-convergence is not the managed apply action.

Every launched one-shot child wrote a private standard Pi session JSONL beneath `<agent-dir>/subagent-sessions/<parent-session>/<run>/<task>.jsonl`. `/subagents-debug` showed a bounded read-only metadata timeline. Diagnostic evidence was retained for 30 days subject to a 512 MiB total-root admission ceiling, a reserved 256 MiB allowance per active or stale-active run, and 32 MiB per child. Explicit `pi --session` opening of that path created an ordinary continuable Pi session, not a resumed subagent mission.

Schema-four `runDurationMs` for those one-shot runs spanned tool entry through result readiness, including admission and awaited cleanup; a separate scheduler interval and parent-observed child start/end offsets share one monotonic origin. Bounded task waits retain overlapping dependency, global-capacity, role-capacity, resource-lock, and eligible-ready reasons. Missing or invalid clocks/endpoints make timing unavailable, not zero. Runtime telemetry versions one through three retain their historical meanings. Version-two redacted telemetry added an invocation-local run ID, requested/admitted/launched counts, requested/admitted hard-edge counts, explicit model/thinking task counts, run duration, peak global and role concurrency, route selection source, structured run errors, and task queue/workspace/child/convergence durations.

The current producer emits only capability-manifest version two. The guard still reads an exact version-one manifest as the previous in-memory shape and normalizes it to version two with `externalReadRoots: []`; a version-one object that carries external fields, or an unknown version, fails closed. That compatibility exists for in-place source skew between an old producer and a newer on-disk guard.

## Explicit exclusions

The extension has no background execution, durable orchestration graph, semantic resume, mission workflow, approval protocol, review gate, automatic repair loop, generic permission framework, automatic model retry, dynamic role, Skill-loading bridge, or registered one-shot `csheng_subagents` tool. Historical one-shot diagnostic history does not provide replay or retained workspaces. Managed request replay, retained native/source state, and trusted host commands are explicit bounded mechanics, not parent decision authority or an OS sandbox. Explorer and reviewer external reads do not imply multi-repository workers, another repository as child cwd, persistent repository aliases, or per-task permission prompts. Diagnostic process settlement and retained standard Pi sessions do not grant continuation or apply authority. It does not install another package or mutate Pi settings.

## Verification and removal

```bash
npm run check
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
```

Multi-skill mention probes cross provider preflight and require separate provider-call authority; they are not in this deterministic lane. Managed execution and observation tests are described in [Managed Subagent Execution](subagent-execution.md).

Unit and component tests own provider-compatible schema shape, routing, graph, private diagnostic allocation and retention, JSON event projection, process settlement, heartbeat progress, guard, snapshot, candidate export, telemetry, evaluator redaction, managed envelope bounds, elapsed output, official host result interception, awaited shutdown cleanup, package peer ownership, extension behavior, cancellation, and regression behavior. Pi core packages imported by extension source are peer dependencies and exact development dependencies; clean `npm ci --ignore-scripts` plus typecheck proves local resolution without bundling another host copy. The subagent probes are offline and report fixed counts only; they do not start a model child.

The project-local `.agents/skills/evaluate-subagent-runs/` Skill reads one explicitly selected Pi session JSONL or an explicitly authorized current-epoch scan and emits metric schema version four. It aggregates requested/admitted/launched tasks, singletons, hard edges, explicit-route attribution, and historical zero-change workers for the retired one-shot tool. Runtime telemetry versions one through three remain readable with their original meanings and authoritative only for fields they declare; unavailable old-session evidence stays nullable and is never reconstructed from assistant arguments. The evaluator never reads Pi SQLite, settings, credentials, logs, or unrelated sessions; never copies raw selectors, prompts, task IDs, child output, stderr, paths, environment values, or external content. Reports are written only to an explicit new output path. The first redacted production baseline is retained under `$AGENT_ARCHITECTURE_DIR/docs/evaluations/pi-integration/subagents/`.

The manual release/runtime lane is separately authorized and never part of `npm test`:

```bash
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents
CSHENG_SUBAGENTS_LIVE_E2E=1 npm run e2e:subagents -- --installed
```

Parent owns acceptance of that lane. This document does not treat it as verified package co-load or as a current one-shot runtime proof. It is never part of `npm test` because it consumes provider capacity and ambient authentication.

Removing only `./extensions/subagents/index.ts` from the package extension list and reloading Pi removes the managed tool, `/subagents`, guidance, managed context/observation hooks, observer publication, and new managed dispatch. It does not delete existing user-owned files beneath `<agent-dir>/subagent-sessions/` or `<agent-dir>/subagent-managed-sessions/`; the user may explicitly remove those roots. Shutdown first drains this instance's known work. The other extensions, parent sessions, repository files, and any user-owned route file remain unchanged. Removing only `subagents-ui` leaves the core tool unchanged.
