# Pi Extensions

This repository contains small, locally maintained Pi extensions. It exports `plan-mode`, which changes the active tool profile without replacing Pi's native agent loop, and `multi-skill-mentions`, which adds explicit multi-skill selection to prompts.

## Plan Mode

`/plan` switches the current session to Pi's read-only `read`, `grep`, `find`, and `ls` tools and appends a compact planning instruction before model turns. `/default` restores the exact tool set that was active before plan mode. The `--plan` startup flag selects the same profile.

The extension stores only the selected profile and the tool set to restore. It does not own workflow phases, task graphs, review policy, approval gates, tool authorization, or settlement. Those decisions remain with the active coding agent, the user, and Pi's host loop.

## Multi-skill Mentions

Type `$` in the TUI to search loaded skills and insert one or more `$skill-name` mentions. On submission, the extension expands each uniquely mentioned loaded skill before the original prompt. Unknown names, escaped mentions such as `\$skill-name`, and ordinary shell variables remain unchanged.

`/skill-mentions` shows a short usage reminder and the number of currently loaded skills. The extension does not discover skills independently; Pi's command registry remains authoritative for available skill names and source paths.

## Package

The private package exposes exactly:

```text
extensions/plan-mode/index.ts
extensions/multi-skill-mentions/index.ts
```

Each extension keeps independent behavior, tests, and removal semantics while sharing one Pi package.

## Local Development

```bash
npm ci --ignore-scripts
npm run check
```

Temporary-load and installed-package probes live under `scripts/`. Global installation and settings changes remain explicit gates and are never performed by `npm test`.

## Safety

If a future Pi release does not expose one of the declared read-only tools, plan mode activates only the available subset and reports the mismatch. The extension never registers model-callable tools or changes provider/model configuration.
