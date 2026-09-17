# Task Workflow E1 Report

Status: **E1 complete — reviewed source handoff (WF-01 through WF-08).** Parent accepts AC-01 through AC-09 against the user's clarified model-preparation boundary. At source handoff, E2 publication/restart/live pilot (WF-09, AC-10) was unperformed. The subsequent user instruction “commit push publish, 我要去试试了” authorizes task-source commits/pushes in both repositories and publication to the existing local Pi snapshot. Restart and trial are user-owned; AC-10 remains unverified. No global Pi modification, settings change, separate Skill install or agent-run provider experiment is authorized.

## Candidate and authority

- Uncommitted `pi-extensions` source against `a3394c4`, package `@csheng/pi-extensions@0.1.0`; unrelated session-cost/evaluation work remains intact and outside this change.
- Verified source manifest SHA-256: `1afad5e34a8b59d05c0cd796ce602d38936dac80e8d7231af77291153b650cb3`. The manifest hashes all 156 files under `extensions/`, `config/`, `tests/`, `scripts/`, plus `package.json` and `package-lock.json`, using sorted root-relative paths and SHA-256 file digests. Documentation is excluded to avoid a self-referential digest. This is the full verified checkout inventory, including retained unrelated tests, not a claim that every inventory entry belongs in the release commit. Full manifest: `/tmp/workflow-source-manifest.sha256`.
- Runtime: `extensions/workflow/`, `extensions/shared/prepared-input.ts`, and bounded independent managed-context changes in `extensions/subagents/context.ts`; owning tests, offline probes, package/lockfile and documentation accompany them.
- Project-local Pi coding-agent, AI and TUI dependencies and tested installed CLI: 0.85.1. Installed-host tests load this checkout with disposable configuration, not the daily package snapshot.
- External portable Skills task diff: conditional task-workflow guidance in the authored implementation skill and its generated counterpart. The owning plan records exact external paths; this package does not depend on that collection. Existing planning guidance needed no change. No installed Skills were modified.
- The original C2 approval covers E1. In session `01a0acfc-af3f-74eb-abbe-1ac0341f1932`, the user subsequently clarified that valid input is a new message actually prepared for the model, not a received/edited/undelivered queue item, and explicitly instructed implementation and acceptance. The continuation request resumes that scope. The [design](../plans/changes/2026-09-17-task-workflow-design.md) and [plan](../plans/changes/2026-09-17-task-workflow-plan.md) now reflect that effective baseline rather than retaining a superseded host-patch gate.

## Public-host contract and final behavior

### Safe reconciliation

`isIdle()` becomes true before awaited settlement handlers finish; timers/microtasks are not a barrier. The documented command-context `waitForIdle()` armed while the run is active resolves after all extension settlement consumers and native notification. A nonce-guarded internal command is dispatched from `agent_start` without awaiting it from the event handler. Final policy checks and ordinary `sendUserMessage` occur only after that wait.

The adapter fences abort, newer real input, changed session/run, tree navigation and shutdown. Policy rechecks trust, active tools, host queues, uncommitted input observation, alignment, UI state, stop/compaction outcome, progress and allowance. An unbound SDK waiter cannot establish capability. No host patch, private API, timer or alternate model loop is involved. The earlier blanket settlement-impossibility claim is withdrawn.

Dependency-host TUI/RPC tests co-load workflow before timing/observer consumers and a later asynchronous consumer. The installed RPC CLI independently exercises production co-load with four synthetic provider requests in two interactions, one bounded reconciliation, explicit pause and review usage of one. These are offline host checks, not inference or evidence that an existing daily process loaded the source.

### Actual model-prepared input

Receipt and native `message_start` alone do not mutate alignment. A bounded shared tracker observes new native user-message occurrences; the public `context` hook confirms their participation in the host's cloned pre-provider context. Ledger append and occurrence consumption are transactional. Failed append retains the occurrence and blocks sensitive workflow operations until preparation succeeds. History/retries do not become new input; dropped/replaced queue entries never seen by the model do not count.

Unambiguous ordinary source is associated through public lifecycle order, not receipt text. Known ordinary extension controls are excluded. Actually prepared queued or mixed-source occurrences require alignment, but their unknown origin neither grants permission nor replenishes automatic-review credit. Main-agent confirmation, acknowledgment and amendment under existing authority remain possible. `deliveryUnavailable` is a warning, not the old irreversible task lock. Unknown enrollment starts without credit; recovery preserves spent credit and progress history.

Pi 0.85.1 still lacks queued receipt/source identity. It also does not notify earlier input observers when a later handler handles a receipt. Consequently a handled receipt followed by opposite-source ordinary input can conservatively become unknown, just like overlapping preparations. Real-host regressions cover both source orders: no receipt-only mutation, actual participation requests alignment, goal/authority/credit remain unchanged, and explicit alignment succeeds. Last-receipt-wins would be unsafe when preparations reorder and is not used.

This observes preparation at the public hook, not final network transmission after arbitrary later context/payload rewrites. Structural digests confirm native-event membership, never human authority; perfectly identical copies removed by another context transformer cannot be uniquely distinguished. These limitations are disclosed rather than represented as a need to patch Pi or disable all queued work.

## Repairs and independent review

The earlier 494-test completion claim was withdrawn after eight causal gaps were reproduced. Their maintained repairs remain part of the final candidate:

| Finding | Final disposition and oracle |
| --- | --- |
| C-F1 stale criterion acceptance / false completion | Stale bindings revoke all supporting decisions; closure independently refuses stale support. Repair-invariant tests. |
| C-F2 historical dependent attempts survived invalidation | Fence all retained affected attempts, including already-interrupted executions and predecessor rejection/refresh. Public compound-record and reducer tests. |
| C-F3 transformed control consumed human receipt | No receipt-text or queue-order inference. Model-prepared unknown participation requests non-authorizing alignment without credit refill; no hard lock. Real-host delivery/model-input and credit tests. |
| C-F4 chained symlink looked unchanged | Unsupported chains/non-regular targets are unavailable; supported links include target bytes and containment. |
| C-F5 absent counters allocated invalid IDs | Require every safe counter above retained identities; allocation/replay reject invalid state. |
| C-F6 reminder repeated after tool results | Keep the current marker in place or project once beside input; only failure/recovery rearms it. |
| C-F7 reworded failed outcome became progress | Exclude outcome prose; compare structural state/revisions/input bases and deduplicate facts. |
| C-F8 retired criteria made waiting work actionable | Ignore retired obligations while keeping unaccepted criteria actionable after task checkboxes are accepted. |

Earlier bounded independent state/evidence and lifecycle reviews led to accepted repairs and targeted confirmation. Their evidence remains applicable to unchanged core paths. Two fresh independent reviewers covered the final input tracker/alignment/subagent projection and credit/settlement changes. Credit/settlement had no material finding. The input reviewer initially raised handled-receipt source contamination; targeted public-host investigation qualified it as the conservative UX limitation described above, not an established hard-contract failure. Parent rejected the proposed correctness defect as insufficiently supported under the clarified unknown-origin contract and added real-host regressions plus explicit documentation. No accepted finding remains unresolved.

Reviewers were read-only; parent ran executable verification and owns acceptance. Review records were explicitly closed/retained. Prior timed-out worker delegations supplied no accepted/applied candidate; implementation was completed locally without silently recovering their private source.

## Final verification

| Gate | Evidence |
| --- | --- |
| Dependencies | `npm ci --ignore-scripts` passed using the project lockfile. |
| Aggregate | `npm run check`: typecheck clean, **535/535 tests passed, zero skips**, shell syntax clean. |
| Focused final input cases | Prepared-input, input-credit and real-host model-input suites: **12/12 passed**, including handled-source ambiguity and queue withdrawal/replacement. |
| Dependency host | Ordinary/transformed/image/queued input, retries/history/recovery, transactional observation, early-wait ordering, late consumers, abort/new-input fencing, no-progress and headless suppression. |
| Installed host | `tests/workflow-installed-host.test.ts`: actual Pi RPC, production co-load, synthetic provider, disposable settings, bounded continuation and pause. Included in the aggregate result. |
| Offline probes | All eight temporary/installed plan-mode, subagents, herdr-handoff and workflow probes passed. Registration probes do not replace dynamic continuation evidence. |
| External Skills | `scripts/check.sh`: generated parity, contracts/index/diagrams, lint/type checks, **111 tests passed**, 324 Markdown files without hard wraps. |
| Documentation | Prose checker: **43 Markdown files, zero hard wraps**. **25 local links** resolve across the eight touched documents; tracked and new-file whitespace checks pass. |

Final parent logs are `/tmp/workflow-resume-ci.log`, `/tmp/workflow-resume-check.log`, `/tmp/workflow-resume-focused.log` and `/tmp/workflow-resume-skills.log`. Temporary logs are evidence, not runtime truth or an operating prerequisite. An initial Skills check invoked from the wrong repository failed before running any gate; the corrected owning-repository invocation above passed. Publication preflight caught a documentation-only collection-boundary violation in this report; it was removed without weakening the test. A Git-less archive check timed out and is not passing evidence. The owning-checkout `npm run check` was rerun after the documentation repair: 535/535 passed, zero skips, with typecheck and shell syntax clean (`/tmp/workflow-publish-check.log`).

## Acceptance and closure

| AC | Parent result |
| --- | --- |
| AC-01 | Accepted: direct-intent/plan enrollment and portable optional guidance; no fixed user format or phase graph. |
| AC-02 | Accepted: coverage, current acceptance support and truthful closure, independent of UI. |
| AC-03 | Accepted: revision/basis binding and selective transitive invalidation, including historical/interrupted attempts. |
| AC-04 | Accepted against the clarified model-preparation boundary: actual new input aligns; drafts/history/retries do not; unknown origin neither supplies permission/credit nor locks alignment. |
| AC-05 | Accepted: useful bounded reconciliation through the early public waiter; no-progress/cap and unsupported-host refusals. |
| AC-06 | Accepted: tested cancellation, input/recovery, UI/compaction, shutdown, branch and headless safety; no automatic replay. |
| AC-07 | Accepted: managed observation/basis/apply remain transport facts, not acceptance; parent integration remains explicit. |
| AC-08 | Accepted: persistence, counter/limit validation, unknown/unavailable evidence and visible failure. |
| AC-09 | Accepted: dependency-host TUI/RPC and installed RPC continuation co-load plus once-per-prepared-input/recovery reference context. |
| AC-10 | Unverified: the user will restart and try the published snapshot; no agent-run real-task effectiveness experiment was performed. |

**Close-change verdict: closed for E1 source handoff.** Optional rich task UI was not required and is not implemented. The later WF-09 delivery approval covers source commit/push and the existing local Pi snapshot publication only. User restart/load confirmation and real-trial evidence remain pending; any separate Skill installation or agent-run experiment needs matching authority. Source closure is neither installation nor proof of reduced real-world premature stopping.
