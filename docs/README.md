# Docs

This directory contains stable project truth, retained evaluation evidence, and stage artifacts kept for history.

## Stable Truth

- `architecture/multi-skill-mentions.md` defines loaded-Skill mention completion and expansion.
- `architecture/fast-gpt.md` defines the branch-local OpenAI Responses service-tier request profile.
- `architecture/subagents.md` defines managed-only delegation ownership/routing and the historical one-shot boundary.
- `architecture/subagent-execution.md` defines trusted host workers, explicit managed episodes/candidates, native continuity, observation ownership, and recovery/removal.
- `architecture/subagents-ui.md` defines the default-loaded read-only floating observer and default-off widget, separate from managed tool-card rendering.
- `architecture/herdr-handoff.md` defines the explicit-user-only full-agent Herdr bridge, request/return protocol, isolated-worktree evidence, and removal contract.
- `architecture/workflow.md` defines explicit implementation contracts, the semantic protocol, evidence/drift, prepared-input alignment, productive continuation with anti-spin suspension, optional projection, legacy recovery and verification limits.

- [Local Pi extension integration map](architecture/pi-extension-integration.md) maps behavior-level intervention points, combined sequence, shared-target hotspots and modification ownership across the pinned local stack; it separates configured features from actual runtime ownership.

## Deferred Work

[Open Questions and Follow-ups](open-questions.md) records pending work separately from implemented architecture and runtime behavior.

## Evaluation Evidence

`evaluations/` contains bounded, redacted evidence from explicitly selected runs. It supports current architecture claims but does not replace stable architecture truth.

- [Pi extension composition offline evidence](evaluations/2026-09-18-pi-extension-composition-offline.md) records controlled CC/SoL tool ownership, real host event order, RTK-adapter coverage and ObservationPack projection/recall; it does not establish full installed-stack compatibility.

## Stage Artifacts

Keep designs, implementation plans, and migration history under `plans/`. Default search tools avoid `docs/plans/` through `docs/.ignore`; use `rg --no-ignore -n "pattern" docs/plans` only when historical context is explicitly needed. Stage artifacts remain Git-tracked and never become runtime input or stable truth automatically.

- Archived v1 task-level workflow: [design](plans/changes/2026-09-17-task-workflow-design.md) and [implementation plan](plans/changes/2026-09-17-task-workflow-plan.md). The E1 source handoff (WF-01 through WF-08) is **complete**: public early-armed `waitForIdle` provides safe reconciliation, and actual model-prepared input drives alignment without guessing queued provenance or requiring a host patch. The [E1 report](evaluations/2026-09-17-task-workflow-e1-report.md) records verification, conservative source limitations and the AC map; publication was separately authorized for that v1 delivery, not the v2 redesign; user restart/load confirmation and live effectiveness (WF-09/AC-10) remain unverified. The optional task view is implemented as a read-only TUI widget (`/workflow-ui`, aboveEditor) with bounded row width and short task titles; it is not the workflow owner.
- Goal-driven workflow redesign: [target architecture and diagrams](plans/changes/2026-09-18-goal-driven-workflow-architecture.md), [design](plans/changes/2026-09-18-goal-driven-workflow-design.md), and [implementation plan](plans/changes/2026-09-18-goal-driven-workflow-plan.md). The user confirmed the goals of strict implementation completion, optional task display and goal-based drift handling. E1 source implementation is complete with 619 passing offline tests, package probes and independent review adjudication; the stable architecture above owns the semantic v2 protocol, explicit migration and optional projection. Necessary portable Skill wording changes are separately recorded in the design and checked read-only during E1. The local snapshot was published after explicit follow-up authorization; user restart/load and live effectiveness remain unverified.
- Parent/child overlap: [research request](plans/changes/2026-09-17-parent-child-overlap-research-request.md) for an external GPT Pro comparison of Codex/Claude async parent progress against blocking `csheng_subagent_sessions`. It is not architecture and does not authorize a product change.
- Pi extension and Skills boundaries: [research request](plans/changes/2026-09-18-pi-extension-and-skills-boundary-research-request.md) pins the local package baseline and asks GPT Pro for a behavior/intervention map, rule ownership analysis, and Pi-only versus multi-agent tradeoffs. It includes the `rg`/`fd` preference case; it is not a completed audit or migration authority. The [external research report](plans/changes/2026-09-18-pi-extension-and-skills-boundary-research-report.md) is that study's return artifact: external static analysis against fixed public source pins with pending recommendations. It remains stage material, not a local combination audit, and it authorizes no change by itself.