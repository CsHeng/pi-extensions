# Integrated v3 verification and review disposition

Date: 2026-09-20. Target: uncommitted runtime integration on successor `16ce69cdf1f487a2e5492766378ba8531d7253bf`, after importing its complete Git ancestry. This is bounded evidence, not a second architecture owner. Current behavior belongs to [managed execution](../../architecture/subagent-execution.md) and [workflow](../../architecture/workflow.md).

## Observed checks

| Check | Result |
| --- | --- |
| Locked dependency installation | `npm ci --ignore-scripts` passed. |
| Final package check | TypeScript passed; 695 tests passed, zero failed/skipped. |
| Temporary/installed plan-mode probes | Both passed. |
| Temporary/installed subagents probes | Both passed. |
| Temporary/installed Herdr-handoff probes | Both passed; no actual handoff/provider execution. |
| Temporary/installed workflow probes | Both passed. |
| Actual RPC-mode Pi SDK/native-child scenario | Passed: async receipt, two live children, independent parent work, early apply, explicit refresh/repair, original sibling-run ownership and exact cleanup. |
| Actual-host abort after completion enqueue | Passed: queued terminal wake did not restart an aborted parent. |
| Whitespace/resource checks | `git diff --check` passed; one authored worktree, zero owned task refs. |

No inference/provider probe, user installation, local package publication, remote push or deployment was performed. The installed-host lanes load the checkout with disposable settings; they do not update daily Pi. The native scenario uses local synthetic providers, not network inference.

## Independent review: parent adjudication

Two independent read-only reviewers assessed separate runtime and consumer scopes in one flat batch. Each received one targeted repair re-review. Static findings were not treated as test evidence or automatic acceptance.

| Candidate | Parent disposition and regression |
| --- | --- |
| Cancelled queued continuation recaptured input / collided with its pin | Accepted; reuse and validate the original pin. `subagents-async-runtime` resumes the cancelled queued task after parent input changes. |
| Same-process completions competed on a fail-fast root disk lock | Accepted; await known root writers, retain fail-closed foreign locks. Deterministic overlapping completion regression. |
| Continuation saved a stale pre-refresh record | Accepted; reserve and bind the freshly locked record. Explicit refresh interleaving regression. |
| Apply reported candidate paths instead of parent mutation paths | Accepted; preserve both footprints, including renamed destination and no-op apply. Candidate/store regression. |
| Wake coalescing expired before host consumption | Accepted; public-context wake-token consumption and bounded pending evidence. Adapter and actual-host abort regressions. |
| New input left completed execution pending forever | Accepted; reconcile transport independently of evidence generation. Workflow input/terminal regression. |
| Inspect/join rebound historical execution to a newer attempt | Accepted; original episode capture or unavailable proof. Workflow query regression. |
| Timing enrichment overwrote conflicting terminal facts | Accepted; compare facts before enrichment and fence metrics. Evaluator regression. |
| Epoch selection omitted tasks but retained their run timing | Accepted; shared provenance/activation predicate. Evaluator regression. |
| Repaired continuation still checked stale recovery/native state | Accepted on re-review; validate both under the session lock. Uncertain-apply interleaving regression. Failed admission also cannot republish a preceding episode. |
| Query bindings crossed close/re-enrollment with reused attempt numbers | Accepted on re-review; retain and check contract identity. Re-enrollment regression. |

The parent ran the focused repairs and final complete suite. The last two follow-up repairs were locally verified, not sent into another broad review cycle. Review handles were explicitly closed with history retained. No reviewer candidate was auto-applied and no review transport outcome substituted for parent judgment.

## Scope and evidence limitations

Component suites and actual-host fixtures establish offline mechanics, not live-model task quality, provider economics, macOS behavior or protection against hostile trusted bash. The controlled native scenario deliberately leaves semantic acceptance to the parent and cancels its fixture workflow contract rather than pretending child completion is acceptance.

Baseline oracle repairs did not remove tests: fresh independent Git capture fixed two real primitive failures; a documentation token was made owner-neutral; disposable historical Pi/CC TUI settings/load order select the intended footer writer. No live user/foreign-extension settings changed.

Disposable checks release their owned processes, Git worktrees/refs and temporary directories. No lasting service or port was started. Imported source, preserved original documents and local raw verification logs remain provenance/evidence artifacts; no global pruning was performed.
