# Docs

This directory contains stable project truth, retained evaluation evidence, and stage artifacts kept for history.

## Stable Truth

- `architecture/plan-mode.md` defines the reversible read-only loop profile and branch-local state contract.
- `architecture/multi-skill-mentions.md` defines loaded-Skill mention completion and expansion.
- `architecture/fast-gpt.md` defines the branch-local OpenAI Responses service-tier request profile.
- `architecture/subagents.md` defines managed-only delegation ownership/routing and the historical one-shot boundary.
- `architecture/subagent-execution.md` defines trusted host workers, explicit managed episodes/candidates, native continuity, observation ownership, and recovery/removal.
- `architecture/subagents-ui.md` defines the default-loaded read-only floating observer and default-off widget, separate from managed tool-card rendering.
- `architecture/herdr-handoff.md` defines the explicit-user-only full-agent Herdr bridge, request/return protocol, isolated-worktree evidence, and removal contract.
- `architecture/workflow.md` defines the branch-local task-level workset ledger, evidence binding/freshness, delivered-input alignment, bounded automatic review, persistence/recovery, and the supported host/verification limits.

## Deferred Work

[Open Questions and Follow-ups](open-questions.md) records pending work separately from implemented architecture and runtime behavior.

## Evaluation Evidence

`evaluations/` contains bounded, redacted evidence from explicitly selected runs. It supports current architecture claims but does not replace stable architecture truth.

## Stage Artifacts

Keep designs, implementation plans, and migration history under `plans/`. Default search tools avoid `docs/plans/` through `docs/.ignore`; use `rg --no-ignore -n "pattern" docs/plans` only when historical context is explicitly needed. Stage artifacts remain Git-tracked and never become runtime input or stable truth automatically.

- Task-level workflow: [design](plans/changes/2026-09-17-task-workflow-design.md) and [implementation plan](plans/changes/2026-09-17-task-workflow-plan.md). The E1 source handoff (WF-01 through WF-08) is **complete**: public early-armed `waitForIdle` provides safe reconciliation, and actual model-prepared input drives alignment without guessing queued provenance or requiring a host patch. The [E1 report](evaluations/2026-09-17-task-workflow-e1-report.md) records verification, conservative source limitations and the AC map; local snapshot publication is now authorized; user restart/load confirmation and live effectiveness (WF-09/AC-10) remain unverified. The `todolist` view was optional presentation and was not implemented; it is not the workflow owner.
