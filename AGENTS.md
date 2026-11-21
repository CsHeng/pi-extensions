# AGENTS.md

## Project

This repository authors small, independently removable Pi extensions. Pi remains the host-loop owner; the active main agent owns task meaning, method selection, verification judgment and acceptance. `package.json` owns the exported extension inventory, and [README](README.md) explains the human-facing behavior and supported commands.

## Vocabulary

Use one name for each concept across directories, commands, identifiers, protocols, tests and documents. The user fixed these names on 2026-11-11.

| Concept | Component / tool | Entity | UI / command | Code and protocol names |
| --- | --- | --- | --- | --- |
| Background Bash | `async-bash` / `bash` | job | Jobs / `/jobs-ui` | `Bash*`, `async-bash.*`, producer `async-bash` |
| Managed child agents | `agents` / `invoke_agent`, `message_agent`, `list_agents`, `wait_agents`, `stop_agent`, `release_agent`, `agent_candidate`; status `/agents` | agent | Agents / `/agents-ui` | `Agent*`, `agents.*`, producer `agents` |
| Task list | `tasklist` / `tasklist` | task | Tasks / `/tasks-ui` | `Tasklist*`, `tasklist.*`, producer `tasklist` |
| Model delivery | `notices` | notice (result, checkpoint) | none | `Notice*`, `notices.*` |

- Name components for their mechanism and entities for what people see listed. Use `agents` for managed peers in roles; the retired product term `subagent` stays in historical material.
- A notice reaches the model; a notification is a human-facing alert from `agent-bark` or `ui.notify`. Execution covers a Bash job or an Agent run/task; a checkpoint asks for attention while execution continues.
- Each UI has one command and independent visibility/folding. Renames are cutovers; retired aliases and compatibility readers require a separately approved compatibility contract.
- Keep the author name in package identity (`@csheng/pi-extensions` and its snapshot directory). Internal names use `<component>.<topic>`, `PI_EXTENSIONS_<NAME>`, and `pi-extensions-<component>-` for events, environment variables and temporary-directory prefixes respectively.

## Truth And Navigation

`extensions/` owns implementations, `config/agent-routes.json` owns packaged route defaults, `tests/` owns deterministic and host fixtures, and `scripts/` owns probes and local publication. Read the affected behavior owner before editing; these documents carry the detailed contracts instead of duplicating them here.

| Surface | Behavior and maintenance owner |
| --- | --- |
| Managed access, routes, execution, candidates and cleanup | [Agents](docs/architecture/agents.md), [Agent execution](docs/architecture/agent-execution.md), [Execution primitives](docs/architecture/agent-execution-primitives.md) |
| Agents UI and retained session inspection | [Agents UI](docs/architecture/agents-ui.md) |
| Tasklist and Tasks UI | [Tasklist](docs/architecture/tasklist.md) |
| Main-model result and checkpoint delivery | [Notices](docs/architecture/notices.md) |
| Async Bash and Jobs UI | [Async Bash](docs/architecture/async-bash.md) |
| Footer fields and rendering | [Status Footer](README.md#status-footer), [Usage metrics](docs/architecture/usage-metrics.md) |
| Working row, timing entries and interaction settlement | [Work-timing metrics](docs/architecture/work-timing.md), [Usage metrics](docs/architecture/usage-metrics.md) |
| Human notification adapter | [Agent Bark](README.md#agent-bark) |
| Skill mention expansion | [Multi-skill mentions](docs/architecture/multi-skill-mentions.md) |
| Request tier profile | [Fast GPT](docs/architecture/fast-gpt.md) |
| Idle cache refresh | [Cache Keepalive](docs/architecture/cache-keepalive.md) |
| Check selection, host prerequisites and evidence limits | [Test-suite evidence lanes](docs/test-suite-evidence-lanes.md), [Local Development](README.md#local-development) |

- Shared boundaries, all new designs/plans and retained evaluations belong to `$AGENT_ARCHITECTURE_DIR/docs/`. Product protocols and necessary standalone guidance remain here; runtime, checks and installation work independently of the architecture checkout.
- `mise.toml` resolves `AGENT_ARCHITECTURE_DIR`, `AGENT_SKILLS_DIR`, `PI_EXTENSIONS_DIR` and `TMPDIR`. Use [Project Environment](README.md#project-environment), re-establish the target context for cross-project commands and preserve caller-owned run isolation. Retained runtime and temporary artifacts belong under `$TMPDIR/extensions/`; the shared workspace contract owns bucket placement and staging.
- `.agents/skills/evaluate-agent-runs/` and `.agents/skills/evaluate-session-cost/` are maintainer-only read-only evaluation methods, excluded from the npm package. Their dated conclusions belong to the architecture owner and their raw diagnostic artifacts to `TMPDIR`.

## Source And Local Installation

Daily Pi loads the copied local package snapshot; this checkout is authored source. Publication uses `mise run publish-local-package` and needs explicit authority. [Local Development](README.md#local-development) owns the copy, first-time installation and restart procedure.

Keep user settings, provider/model settings, the user route overlay and loose extensions user-owned. The publisher copies `package.json`, `config/` and `extensions/` into the package snapshot while leaving those other surfaces unchanged. The loose-extension directory `~/.pi/agent/extensions/` is shared discovery, so it is outside any package mirror-delete target. Source edits and offline checks leave installed and already-loaded behavior unchanged.

## Architectural Boundaries

- Pi owns the active tool registry, native loops, session persistence, trust and user interaction. Extensions consume those public inputs. Preserve ordinary behavior outside an explicitly selected profile/tool and when an extension is disabled.
- Skills and harness capabilities work independently. Pi's native resource loader owns Skill discovery and context-file precedence; the active agent applies methods. Extensions interpret their own tool/configuration contracts, leaving plan and Skill interpretation to the parent.
- Tasklist is passive branch-local model-authored data. The main agent owns task meaning, decomposition, required evidence, review and completion judgment. Preserve atomic edits, actual blocker notes and cancellation distinct from success; a tracking failure preserves completed business work. List pause/resume, interruption-driven mutation, inferred completion, update schedules and turn gates remain outside Tasklist. Current snapshots are schema v6 `tasklist.state`; other versions are reported unsupported and historical entries stay untouched.
- Notices alone owns main-model result/checkpoint delivery. Tasklist publishes passive task facts, and Agents/Async Bash publish their owned execution facts; task-only notices remain disabled. Genuine results proceed independently of task status and sibling executions. Producers and UIs retain their own responsibilities rather than creating another model-wake path.
- Async Bash enhances builtin `bash` only in TUI/RPC when that name has no other extension owner. Pi owns shell launch and process-tree teardown; the wrapper owns execution identity, bounded output, yielding observation windows, renewable checkpoints and opt-in hard timeouts. Apply cwd/environment/prefix once. A checkpoint or released observation leaves the process running; unknown exit remains unknown. Print/JSON and managed children keep native draining Bash.
- Agents executes session-owned bounded assignments with explicit read/write grants and open role definitions. Roles supply purpose, routing and collaboration defaults; access and physical ownership determine file permissions. The main session hub checks peer messaging, roster, nested invocation and assignment control. Trusted shell and third-party tools retain host privileges; native file guards and private worktrees are not an OS sandbox.
- Shared writers edit their granted checkouts directly; coordinate file and resource ownership in briefs and messages, and inspect the working-tree diff for acceptance. Stop/revert uses attributable last-turn file-tool writes that still match the recorded content; shell changes remain unattributed. Isolated writable roots use pinned inputs, worktrees and indexes with one candidate bundle; explicit idle refresh changes the input. Controlled candidate operations require the latest result shown to that caller. Reconcile drift, partial or unknown integration, and unsettled writers before further mutation.
- The main agent owns assignment, overall progress, integration and final acceptance with the user; peers coordinate work-level matters, and assigners settle scope, authority and unresolved findings. Turn results return to their initiator. Keep submission, execution, report completeness, integration and resource release distinct. Assemble static guidance through Pi and use one bounded recovery hint on the next user-directed turn to lead to list and settlement checks. Persist required lifecycle/source/candidate facts before publishing them.
- Native/session/candidate history supports explicit same-agent actions by name; scheduling and control remain session-owned. Enforce current framing, ownership, lineage and per-object limits. Finalization remains independent of cumulative history size; runner lifetime and cumulative command/output budgets stay explicit. Release frees open-record slots, and discard releases exact-owned working resources while preserving registry/native evidence. A storage reset needs separate authority, all writers stopped and a decision about retained history; ordinary actions perform no automatic reclamation.
- Packaged roles and routes, user role definitions and route overlay, and trusted project role definitions supply read-only defaults. Per-invoke profiles request qualities; explicit user model/thinking choices are ephemeral and fail visibly when unavailable. Preserve parent model/provider settings; the host owns provider adaptation. Managed children inherit applicable native guidance by default; `inheritSkills: false` disables automatic Skill catalog loading while preserving context files and history. External read-root projects do not become project-resource owners merely through a grant.
- UI consumers are TUI-only and read-only. Keep Tasks, Jobs and Agents visibility/folding independent, preserve full current-version history reachability and label incomplete/unavailable evidence. UI visibility does not grant mutation or delivery authority. `status-footer` alone owns the footer, `work-timing` owns the working row, and user settings own competing third-party writers. Use the lane and cadence contracts in Usage metrics; Pi/provider accounting remains billing truth.
- `fast-gpt` changes only supported request-tier correlations after explicit selection. `agent-bark` adapts the shared interaction boundary to a user-owned hook and excludes managed children. Cache Keepalive performs its eligible context-free idle refresh only while `cacheWarming` is explicitly `"streaming"`; the user setting owns activation and architecture OQ-3 owns its reconsideration trigger. Their detailed removal and side-effect boundaries stay with their respective owners above.

## Working Rules

- Keep each extension small and independently reversible. Share algorithms under `extensions/shared/`; each extension owns its state machine and lifecycle instance. One-way read-only observations and optional state notifications may compose independently removable components, with any degradation stated.
- Lead model-facing tool descriptions and context with the useful next action and its evidence. Tie exclusions to concrete authority, safety or ambiguity boundaries. Task completion remains evidence-based main-agent judgment; tracking accepts edits without a structured completion receipt.
- Treat prompt-cache stability as a quota/cost boundary. With unchanged model, prompt and tools, preserve the previous complete provider input as an unchanged prefix across ordinary requests. Keep live timing/progress in UI or explicit receipts; append necessary context once at a real boundary. Compaction, explicit context edits and changed instructions remain legitimate boundaries.
- For prompt, tool-schema or payload changes, choose affected prefix/continuity regressions and compare consecutive complete provider inputs, including active tracking/background execution where relevant. Judge cache impact on the full prefix, not merely a small suffix diff. Backend hits and route-specific quota effects require backend evidence; prefer authorized existing usage records to new paid probes.
- Bound prompts, capability files, observer snapshots, process output, diagnostics and task-list operations against their actual resource risks. Clean owned temporary resources on success, failure, timeout, abort and shutdown while retaining native evidence under its stated policy. Preserve unrelated services and user-owned state.
- Keep evaluator and probe output redacted: raw settings, route files, model selectors, prompts, task IDs, credentials, environment values, session paths and external file content stay outside that output.
- Changes introducing dynamic roles, background missions, durable orchestration ledgers, hidden model fallback, automatic retry or a Skill-specific runtime contract require a separately approved design. Passive Tasklist history owns its existing snapshot exception; it carries no scheduler or automatic recovery.
- Commit, push, npm publication, deployment, remote creation, global installation, user-route creation and provider/model settings changes each require explicit authority. Local snapshot publication uses its owner task and keeps Pi settings unchanged.

## Verification

Choose evidence from changed behavior and actual uncertainty. Workers return relevant local checks and uncovered behavior; the main task owns integration, E2E/full-suite selection, repair disposition and final acceptance. Reuse applicable evidence and rerun what a repair invalidates. Documentation-only changes normally use semantic inspection and relevant link, prose and structural checks.

Use the existing Bun environment and the version declared in `packageManager`. Dependency preparation uses the tracked lockfile with lifecycle scripts disabled: `bun install --frozen-lockfile --ignore-scripts`. Keep installed `pi` invocation/runtime and Pi-owned package locations unchanged.

| Changed boundary | Available check |
| --- | --- |
| Local implementation | `bun test ./tests/<affected-suite>.test.ts` and `bun run typecheck` |
| Broad executable impact or explicit full-owner acceptance | `bun run check` |
| Installed Pi behavior | Applicable `bun run e2e:host-offline` or `bun run e2e:installed-offline` lane |
| Fullscreen/PTY behavior | `bun run e2e:ui-offline`; targeted observer check `bun run e2e:agents-ui` |
| Loading and extension-off behavior | Applicable temporary/installed agent or tasklist probe under `scripts/` |

[Local Development](README.md#local-development) and [Test-suite evidence lanes](docs/test-suite-evidence-lanes.md) own complete commands, suite membership and prerequisite policy. Optional host skips remain distinct from required-host acceptance; shim runner tests prove runner behavior, and offline synthetic evidence establishes only the exercised host behavior. Preserve independent fixture expectations for filesystem identity and tests for independently specified behavior; prose snapshots and copied version strings do not establish that behavior.

Multi-skill mention probes, delegation measurements and live agent E2E spend provider capacity and require separate authorization. `PI_OFFLINE=1` leaves inference enabled. Their invocation gates and evidence limits are documented in Local Development; the parent owns acceptance, and live-model effectiveness or package co-load claims need their own evidence. Broad session scans, paid probes and user-state changes each retain their own scope and authority.
