# Docs

This directory contains stable project truth, retained evaluation evidence, and stage artifacts kept for history.

## Stable Truth

- `architecture/plan-mode.md` defines the reversible read-only loop profile and branch-local state contract.
- `architecture/multi-skill-mentions.md` defines loaded-Skill mention completion and expansion.
- `architecture/subagents.md` defines delegation ownership, routing, scheduling, isolation, convergence, result, and removal contracts.
- `architecture/herdr-handoff.md` defines the explicit-user-only full-agent Herdr bridge, request/return protocol, isolated-worktree evidence, and removal contract.

## Evaluation Evidence

`evaluations/` contains bounded, redacted evidence from explicitly selected runs. It supports current architecture claims but does not replace stable architecture truth.

## Stage Artifacts

Keep designs, implementation plans, and migration history under `plans/`. Default search tools avoid `docs/plans/` through `docs/.ignore`; use `rg --no-ignore -n "pattern" docs/plans` only when historical context is explicitly needed. Stage artifacts remain Git-tracked and never become runtime input or stable truth automatically.
