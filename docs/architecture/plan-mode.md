# Plan mode

`extensions/plan-mode/index.ts` is a thin Pi loop profile. It uses the public extension API to register `/plan`, `/default`, and the `--plan` startup flag.

## Ownership boundary

Pi retains ownership of the agent loop, model turns, tool execution, session tree, persistence, and user interaction. The extension owns only branch-local profile selection, the active tool list, and a compact planning instruction.

The profile activates exactly `read`, `grep`, `find`, and `ls` when those builtin tools are available. It snapshots the complete pre-plan tool list on first entry and restores that exact list on `/default`. Re-entering plan mode does not overwrite the snapshot.

## Branch-local session state

Plan-mode state belongs to Pi's active session branch. Restoration reads only `ctx.sessionManager.getBranch()` and runs on both `session_start` and `session_tree`, so a later entry on an abandoned branch cannot control the selected leaf. Switching between branches immediately reapplies each branch's plan or default tool profile without appending another entry for valid state.

New custom entries use state version 2 and contain only:

- `profile`: `plan` or `default`
- `restoreTools`: the exact default tool list associated with that branch

The same restorable list is retained in both profile states so a default branch can be recovered after navigating from a plan branch. Explicit `/plan` and `/default` transitions append version-2 state; valid restoration does not.

Current unversioned state remains readable. A legacy plan entry supplies its saved pre-plan tools. A legacy default entry derives the exact list from the nearest earlier valid plan entry on the active branch, or from the startup baseline when no such entry exists. Invalid latest branch state fails closed to plan mode, appends one repaired version-2 entry, and reports the replacement visibly.

`--plan` is a startup override. It applies after initial branch restoration and persists the resulting plan state. It is not reapplied during later tree navigation, so an explicit `/default` remains effective for the running session.

Missing declared read-only tools are excluded from the active set and reported visibly. A custom tool that shadows one of the builtin names never enters the plan profile.

## Explicit exclusions

This package does not implement managed workflow state, task graphs, schedulers, approval or review gates, generic permissions, replay, repair budgets, or settlement. Skills can guide the coding agent but are not runtime dependencies of the extension.

## Verification

```bash
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
```

The deterministic component suite covers active-branch precedence, tree navigation, version-2 state, legacy compatibility, invalid-state repair, startup-flag precedence, exact tool restoration, and missing builtin tools. The temporary probe loads the extension by explicit path. The installed probe verifies Pi's current package discovery. Both probes use offline RPC and confirm that extension-off mode does not expose the commands.
