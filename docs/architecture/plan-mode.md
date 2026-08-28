# Plan mode

`extensions/plan-mode/index.ts` is a thin Pi loop profile. It uses the public extension API to register `/plan`, `/default`, and the `--plan` startup flag.

## Ownership boundary

Pi retains ownership of the agent loop, model turns, tool execution, session persistence, and user interaction. The extension owns only profile selection, the active tool list, and a compact planning instruction.

The profile activates exactly `read`, `grep`, `find`, and `ls` when those tools are available. It snapshots the complete pre-plan tool list on first entry and restores that exact list on `/default`. Re-entering plan mode does not overwrite the snapshot.

Session state uses one custom entry type and contains only:

- the current `plan` or `default` profile
- the pre-plan tool list when restoration is needed

Invalid persisted state fails closed to plan mode. Missing declared read-only tools are excluded from the active set and reported visibly.

## Explicit exclusions

This package does not implement managed workflow state, task graphs, schedulers, approval or review gates, generic permissions, replay, repair budgets, or settlement. Skills can guide the coding agent but are not runtime dependencies of the extension.

## Verification

```bash
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
```

The temporary probe loads the extension by explicit path. The installed probe verifies Pi's current package discovery. Both use offline RPC and confirm that extension-off mode does not expose the commands.
