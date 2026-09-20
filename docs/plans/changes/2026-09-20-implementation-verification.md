# Implementation verification: asynchronous subagents and Git worktrees

Status: runtime integration complete in authored source; offline verification passed. No installation, local snapshot publication, remote push, live-provider probe, or deployment is claimed.

## Provenance and delivery

The supplied successor branch `implement/approved-2026-09-20` was fetched from the extracted Git archive and fast-forwarded into this checkout, from `12db1ed489cc825b6ae91cf7224e9c80f2f9bdfd` to `16ce69cdf1f487a2e5492766378ba8531d7253bf`. The two pre-existing local plan documents were preserved separately before import. The successor's approved design and plan supersede the former foreground/private-source/exact-write design for this change.

The archive delivered tested Git/supervisor primitives, not an integrated replacement. Its retained component logs remain historical evidence. This continuation delivers the integrated source, tests and documentation in the current working tree; it does not create a new implementation commit or publish an installation. Daily Pi still uses its existing package snapshot until separately authorized publication/restart.

## Environment and baseline

Dependencies were restored with `npm ci --ignore-scripts` on Node 26.9.0 and Git 2.47.3. The imported full baseline passed 675 of 680 tests. Its five failures were the collection-specific documentation token scan, two Git input-capture cases, and two historical Pi/CC TUI footer/timing checks.

The Git failures exposed inherited index stat-cache behavior and staged-new ignored input. Capture now constructs a fresh independent index from the actual tracked/nonignored inventory. The documentation scan was fixed without introducing a runtime dependency. The TUI fixture now disables the competing CC footer in disposable settings and loads the selected footer owner after CC's startup reset; no user settings or foreign extension runtime were changed and no test was skipped.

## Implemented contract

- Public managed v3 supports create, continue, inspect, join, cancel, refresh, apply and close. TUI/RPC admission returns accepted receipts; one-shot modes remain foreground by default. Explicit foreground mode and join remain available.
- Input is captured and pinned before admission. Checkout/dependency preparation follows admission. Session-wide global/role capacity and explicit locks span independent submissions; task mutations and parent apply retain separate serialization.
- All roles use owned detached Git worktrees. Workers keep native history and private dependencies. Initial write regions are advisory; actual Git changes define immutable input-relative candidates. Continue does not recapture input, including queued cancellation; refresh is explicit and idle-only.
- Apply uses Git three-way integration, preserves parent staging and compatible edits, and never refreshes task input. Actual applied paths can differ after parent rename or be empty after a no-op integration. Unknown apply state blocks another episode.
- Task/run terminal evidence persists before publication and coalesced current-owner wake. Early task repair does not replace an original run's episode view. Shutdown cancels and drains known executions; reload/recovery does not resume them.
- V1/v2 records remain inspect/close-only. No second writable backend remains.
- Workflow binds execution evidence to the original contract, attempt and input. It handles terminal-before-receipt, duplicates, intervening input, historical queries and re-enrollment without rebinding old proof. Pending execution waits on events without polling or duplicate workflow wake; transport never implies acceptance.
- Observer snapshots cover concurrent runs. Async evaluators distinguish admission from execution and deduplicate native usage, terminal summaries, replay and query results; conflicts and unavailable timing stay explicit.

## Verification

The final code check passed **695/695 tests, zero failures and zero skips**, with strict package TypeScript checking. All eight required offline probes passed:

```bash
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
bash scripts/run-temporary-subagents-probe.sh
bash scripts/run-installed-subagents-probe.sh
bash scripts/run-temporary-herdr-handoff-probe.sh
bash scripts/run-installed-herdr-handoff-probe.sh
bash scripts/run-temporary-workflow-probe.sh
bash scripts/run-installed-workflow-probe.sh
```

`tests/subagents-async-host.test.ts` runs a real RPC-mode Pi SDK parent and real native child processes with synthetic providers. Two workers overlap while the parent performs independent work; the early candidate is explicitly applied before its sibling completes; explicit refresh and repair reuse its worktree/native history; the original run still returns the original episode. Workflow waits without acceptance, and exact-owned worktrees/refs are removed. A second actual-host case proves a completion queued behind a tool does not restart an aborted parent. These are offline protocol/host checks, not live-model effectiveness claims.

Other focused suites cover immutable candidates, parent staging, dynamic paths, modes/binary/symlinks, compatible/conflicting integration, queued cancellation, shared capacity, concurrent refresh and uncertain apply, in-process root writer serialization, legacy refusal, dispatch-bound evidence and evaluator conflict/epoch handling.

## Independent review and adjudication

Two independent read-only reviewers assessed runtime/Git/lifecycle and workflow/accounting boundaries. The parent accepted nine initial causal findings, repaired them and requested one bounded targeted re-review. Two follow-up boundary findings were also accepted and repaired: locked recovery checks after a concurrent uncertain apply, and historical query evidence crossing a new enrollment. Regression tests cover these cases. The parent additionally prevented failed admission from republishing a preceding episode and verified real-host abort/wake behavior.

Reviewers performed static review, not the parent test runs. Their reports were treated as candidates, not acceptance. The parent owns the final evidence judgment. Details and coverage limits are recorded in [the bounded integration record](../../evaluations/2026-09-20-async-worktree/integration-verification.md).

## Plan accounting

| Plan work | Current disposition |
| --- | --- |
| X01 | Public v3 receipt/result/control protocol and versioned store; legacy read-only compatibility. |
| X02 / X04 | Git input capture, owned linked worktrees, dynamic candidates, explicit refresh and parent worktree integration are the sole writable backend. |
| X03 / X05 | Native runner integrated with session capacity, task-local controls, owner fencing, terminal publication and wake; foreground compatibility retained. |
| X06 | Original dispatch association, event-driven waiting, early/late reconciliation and no automatic acceptance. |
| X07 | Explicit retain/discard with exact Git ownership; native/registry evidence retained. |
| X08 | Concurrent observer projection and receipt-versus-terminal/native accounting. |
| X09 | Full package check, eight offline probes, real-host/native-child scenario, independent review and regression repair completed. |
| X10 | Current-repository source/tests/stable truth delivered. No new commit, installation, publication, remote push or new ZIP was requested for this continuation. |

## Cleanup and remaining limits

The authored repository has one registered worktree and zero `refs/csheng/subagents` refs after verification. Disposable tests/probes close their native processes and remove owned worktrees, refs, private dependencies and temporary directories. No persistent service, port, container or builder was started. Review handles were explicitly closed; their bounded native/registry review history is retained, not silently pruned. The extracted archive, original local-document backups and local verification logs remain preserved import/evidence artifacts, not running environments.

Live-provider effectiveness, performance/economic gains, macOS coverage, and hostile-shell isolation are not established. Trusted host bash is deliberately not sandboxed. Git publication is not a whole-tree filesystem transaction; uncertain failures remain explicit recovery states. The independent final follow-up fixes were locally regression-verified rather than subjected to an unbounded third review round.
