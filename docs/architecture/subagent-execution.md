# Managed Subagent Execution

`csheng_subagent_sessions`, registered by `extensions/subagents/index.ts`, adds explicit same-task episodes beside the unchanged one-shot `csheng_subagents` contract. Pi owns each native agent loop and session append. The parent owns decomposition, permissions, review adjudication, repair instructions, candidate application, and acceptance. The extension does not infer or advance that semantic workflow.

## Requests and authority

| Action | Contract |
| --- | --- |
| `create` | A `requestId` and one to ten existing task shapes. Creates handles and runs first episodes; returns reports and candidates without automatic apply. |
| `continue` | One to ten `episodes`, each with `handle`, `requestId`, `expectedEpisode`, and bounded `message`. Keeps the role and exact write set; launches a new process on the same native history and working directory. |
| `inspect` | Optional handle; reads current bounded state without running a model. The default list contains open objects; explicit inspection can read closed objects. |
| `apply` | Handle, expected episode, and candidate ID. Checks and exports an eligible frozen candidate. It does not approve the implementation. |
| `close` | Handle, expected episode, and optional `disposition: retain|discard` (default retain). Discard requires parent authority to abandon that work. |

Input is action-specific and closed: arbitrary paths cannot replace handles, and duplicate handles, unknown fields, invalid versions, or oversized input are rejected. Repository trust and owner/branch checks precede access. Fresh episodes recheck repository admission, routes, capacities, and capabilities. No task can change its persistent route defaults or grant itself another role, write set, or external write root.

Managed workers require explicit repository-wide input `scope: ["."]`. Explorer and reviewer remain read-only, with the same bounded Git-contained external read grants as one-shot tasks. The parent may explicitly grant a reviewer a candidate's private Git-contained source or exact files when it needs pre-apply review; the extension does not automatically project one child's state into another or treat a review report as an apply decision.

Only one mutating managed batch or legacy batch runs per extension instance. Inspect is read-only; it does not acquire execution authority. Hard predecessor edges are for approved execution order only, never an intervening parent decision. Configured global/role limits, locks, and exact-write conflict checks still apply.

## Trusted host tools, not an OS sandbox

A managed worker has Pi-compatible `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`, including native schemas and image reads. Its tools share one private source directory and a worker-local FIFO. Bash, source edits, local tests, and repair can therefore observe the same bytes. Existing tools and dependencies are used; the extension does not provision containers, packages, binaries, credentials, or network services.

This is trusted host execution. File-tool guards, private directories, filtered Git defaults, inventories, and candidate checks are not OS restrictions on bash. They do not isolate host credentials, network, filesystem access, or hostile process escape. Exact `writePaths` constrain declared work and candidate export, not bash's host permissions. Parent instructions and applicable external controls remain necessary for host-side authority.

Bash uses an ordinary POSIX process group, waits for operation cleanup, and terminates its known descendants on cancellation, timeout, or exit. Managed native search processes are also drained on shutdown. Unconfirmed writer cleanup latches failure; a candidate cannot be frozen merely because an assistant said it finished. This is normal process cleanup, not an adversarial containment guarantee. The mandatory native `csheng-worker-lifecycle` ready/stopped pair is separate from optional performance markers.

## Source and dependency state

The initial source snapshot contains current tracked and non-ignored repository files, including dirty content. It does not copy parent Git history, configuration, remotes, hooks, or credentials. A private Git index is initialized for local status/diff and index reads; the extension creates no commit. Managed Git invocations ignore inherited `GIT_*`, global/system configuration, and template hooks. Those functional defaults do not sandbox arbitrary shell commands.

Ignored top-level `node_modules` is an independently copied runtime input, including a reserved absent state. An existing ordinary-source `node_modules` is not silently reclassified. There are no shared writable dependency mounts or hardlinks. Dependency changes are staged and switched only when the parent's dependency digest changes; unchanged parent inputs preserve worker-local dependency edits. Internal source links can be dangling, but dependency links must resolve within the staged logical source/dependency namespace. External/absolute links, special entries, unsafe ancestors, and Git redirects are rejected.

Subsequent episodes refresh non-owned parent inputs while preserving owned unexported edits. File/directory/link transitions are checked rather than overlaid blindly. Integrity scans include directory modes and unknown ignored source files; only validated private Git metadata and declared runtime roots are excluded. Command outputs and auxiliary temporary files belong in scratch. Failure preserves prior data for fix-forward diagnosis, not automatic rollback or reinstallation.

## Registry, native continuity, and replay

Private data lives under `<agent-dir>/subagent-managed-sessions`, separate from both ordinary Pi sessions and one-shot diagnostic retention. Each `session_<uuid>` holds a registry, native JSONL, source, scratch, frozen candidate artifacts, and optional episode observations. Batch request records are separate. Directories/files use private permissions; writes use exclusive locks and staged fsync/rename. Unknown lock ownership is not reclaimed automatically.

There are at most ten open logical records per repository/parent session, including records on sibling branches, and at most 256 episodes per record. Closed records release logical slots but retained bytes still count. Code-owned admission bounds include 512 MiB for the managed root, 100,000 entries, 32 MiB per native session, 2 MiB per registry, and 64 MiB per candidate. These are checked logical storage limits, not OS disk quotas. There is no idle TTL or automatic deletion of unfinished work. Genuine required-data overflow remains a visible failure.

Each episode starts a new foreground Pi print/JSON process with the same native file and source. There is no persistent RPC child, steering, background mission, automatic resume, or reconstructed prompt history. Pi performs compaction, tree/fork behavior, and native appends. The parent side reads the physical native append range without opening or repairing the session. A changed leaf, copied/forked owner, other repository, unknown request outcome, or interrupted writer does not gain continuation authority.

A terminal request replays committed episode evidence without another launch, usage charge, or current route lookup. Authorization still applies. The cached view is historical, not a fresh filesystem validation; use inspect for current state. Request errors are separate from the prior committed result. An unknown outcome is not automatically replayed. Quiet successful non-retrying compaction can retain a valid report, but fresh settlement and closed activity remain required; failed, aborted, or retrying compaction cannot resurrect stale output.

Before a model request, a bounded ephemeral current-owner index exposes handles, episodes, state, and candidate metadata, not reports or private paths. It respects project trust and active tools, survives normal same-process reload/context rebuilding, and neither enables disabled tools nor resumes a task. Native history remains authoritative rather than a copied summary.

## Candidates and recovery

Unapplied C1 and C2 are both compared against B0. A fully applied C1 advances the owned baseline; a later episode then compares against that applied state. Non-owned refresh never overwrites pending owned edits. A complete successful report with no changes produces no managed candidate; the legacy `worker_no_changes` failure remains unchanged.

Freeze validates the complete source inventory and binds candidate bytes, source identity, and runtime environment identity. Only declared regular-file create/modify operations are exportable. Unknown source changes, deletion, rename, special entries, symlink writes, mode changes, or exceeded limits fail visibly. Apply rechecks the frozen artifact, source/environment, and parent baseline before exporting.

Export uses checked same-directory staging and per-file rename. It is not a multi-file transaction or automatic rollback. Only complete apply advances the baseline. Partial apply retains the exact applied prefix, and `applying`, `partial`, or `unknown` blocks another episode with `candidate_recovery_required`. Parent/source drift is not merged or reset automatically. Reapplying an already applied candidate returns its recorded outcome without writing again; it is not proof that the current parent tree remains unchanged.

Close/retain preserves the working state and evidence. Close/discard removes owned source, scratch, candidate, and input-staging artifacts while retaining the closed registry/native history. It never undoes an already exported prefix. Cached reports, process settlement, candidate creation, and apply status are all distinct from parent acceptance.

## Observation and consumers

Public event hooks record client-observed assistant, streamed thinking, local-tool, delegation-wait, and compaction spans. Each interaction uses an opaque process clock and origin. Missing, backward, nonfinite, duplicate, or unclosed endpoints remain incomplete. Final thinking blocks without streamed endpoints do not become complete zero reasoning. Ordinary parent turns, idle shutdown, and inactive delegation tools write no parent observation. Hooks own no timer, UI slot, dispatch, provider payload, or model configuration.

Native v1 observations contain direct assistant/compaction/branch-summary usage, owner/entry identities, configured child tools/context window/capability hash, and scalar command endpoints/status/source/environment hashes. No command text or prompt is copied into these markers. A failed summary without usage is unknown, not free. Configured tool evidence is host state, not the final provider payload after later handlers. Usage remains Pi/provider-reported; there is no pricing estimator, server-utilization inference, or provider-quota estimate.

Optional observation sidecars are bounded to 64 KiB per episode and are not part of the required registry, request, or terminal ACK. Required storage pressure may remove only exact derived observation caches and their owned atomic temporaries. Missing/corrupt/evicted caches hydrate as unavailable; an optional write failure cannot invalidate a candidate or committed result. Native history, source integrity, required lifecycle evidence, and candidate failures are never waived as telemetry failures.

The evaluator's `observations` section consumes owned physical parent windows and child projections, deduplicating native owner/entry and logical handle/episode identities. Copied fork prefixes, nested aggregates, replay, inspect, and repeated reads do not create new usage. Prior valid episode evidence survives a missing cache on reread; conflicting stable evidence fails closed. Parent usage and child usage are separate. Cross-run worker union requires matching clocks/origins; child reasoning/tool/compaction summaries sum per-episode measurements as effort, never an unrelated-clock union. Unattributed wall gaps are not asserted user idle.

The legacy evaluator counters remain explicitly `csheng_subagents-only`. Exact-session mode supplies native/managed summaries. Current-epoch mode still requires the effective revision pair: managed dispatch envelopes without it are unavailable, not matched from mtime or current configuration. Optional explicit `--disposition` JSON declares parent acceptance and bounded entry scope; missing or null endpoints/repair counts stay unknown. Such a declaration neither changes runtime state nor applies to every candidate in a wider report automatically. See the maintainer metric schema for exact fields.

Managed tool content is bounded parseable JSON with every handle, episode, and candidate identity preserved before report truncation. TUI results distinguish request refusal, stored idle/interrupted/closed state, episode outcome, report completeness, apply, and unavailable acceptance. Running activity uses Pi's native tool-update channel and the actual run clock. The optional `subagents-ui` panel remains a one-shot snapshot consumer; `work-timing` retains its independent v1 parent-only TUI semantics.

## Verification and removal

Deterministic tests cover contracts, private files/Git/dependencies, real local command test/repair, cancellation, concurrency, request replay, candidate CAS/partial recovery, optional storage pressure, and producer/consumer ownership. Disposable synthetic-provider tests exercise both the development Pi API and installed CLI, native append/reopen, same-process reload, compaction, actual tool progress, and cross-episode accounting. They are not evidence of economic benefit or successful real-provider semantic delivery.

Temporary/installed subagent probes discover both tools and assert their absence when the extension is disabled, without inference. The separately gated live script remains a one-shot three-role probe, not managed continuation acceptance. Provider workflow, installation, and route/cap experiments require explicit authorization.

Removing `extensions/subagents/index.ts` and reloading removes both tools, commands, context projection, and observation hooks. Shutdown aborts and awaits this instance's known work before releasing resources. User-owned managed and diagnostic data is not silently deleted or converted into ordinary missions. Other extensions, parent sessions, source files, and user routing/settings remain independent.
