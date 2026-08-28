# Pi Extensions

This repository contains small, locally maintained Pi extensions. It currently exports one extension, `plan-mode`, which changes the active tool profile without replacing Pi's native agent loop.

## Plan Mode

`/plan` switches the current session to Pi's read-only `read`, `grep`, `find`, and `ls` tools and appends a compact planning instruction before model turns. `/default` restores the exact tool set that was active before plan mode. The `--plan` startup flag selects the same profile.

The extension stores only the selected profile and the tool set to restore. It does not own workflow phases, task graphs, review policy, approval gates, tool authorization, or settlement. Those decisions remain with the active coding agent, the user, and Pi's host loop.

## Package

The private package exposes exactly:

```text
extensions/plan-mode/index.ts
```

The repository may gain another extension only when the new capability has independent installation, configuration, state, tests, and removal behavior.

## Local Development

```bash
npm ci --ignore-scripts
npm run check
```

Temporary-load and installed-package probes live under `scripts/`. Global installation and settings changes remain explicit gates and are never performed by `npm test`.

## Safety

If a future Pi release does not expose one of the declared read-only tools, plan mode activates only the available subset and reports the mismatch. The extension never registers model-callable tools or changes provider/model configuration.
