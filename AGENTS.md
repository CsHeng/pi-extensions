# AGENTS.md

## Project

This repository is the authored source for small local Pi extensions. Extensions may change the host loop's active tools, prompt context, or editor completion behavior, but must not replace the coding agent with a second workflow engine.

The package exposes `plan-mode` as a reversible loop profile and `multi-skill-mentions` as an explicit prompt expansion mechanism. Keep each extension's behavior, state, tests, and removal semantics independent.

## Layout

- `extensions/plan-mode/`: reversible read-only tool profile
- `extensions/multi-skill-mentions/`: TUI completion and input expansion for loaded skills
- `tests/`: deterministic and fake-Pi tests
- `scripts/`: redacted temporary-load and installed-package probes
- `docs/architecture/`: stable product and maintenance truth
- `docs/plans/`: stage artifacts and migration history, not runtime input

## Boundaries

- Pi's public extension API, active tool set, session entries, and startup flags are the runtime inputs.
- The host Pi loop remains authoritative for model turns, tool execution, persistence, and user interaction.
- A profile may select tools and append compact loop guidance. It must not introduce task graphs, schedulers, approval protocols, review gates, settlement, or a generic permission framework.
- Pi's skill command registry remains authoritative for loaded skill names and source paths. This package does not independently discover, execute, or enforce a Skill repository.
- Missing declared read-only tools fail closed to the available subset and produce a visible diagnostic.

## Working Rules

- Keep each extension small and reversible.
- Persist only the minimum state needed to restore host behavior.
- Preserve ordinary Pi behavior outside the selected profile and when the extension is disabled.
- Keep probe output redacted. Never print raw user settings, prompts, credentials, or external file content.
- Do not commit, push, publish, deploy, create a remote, or change provider/model settings without explicit authority.

## Validation

Run:

```bash
npm ci --ignore-scripts
npm run check
bash scripts/run-temporary-plan-mode-probe.sh
bash scripts/run-installed-plan-mode-probe.sh
```
