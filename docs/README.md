# Product Documentation

These documents own self-contained extension behavior, maintenance and removal contracts:

- [Multi-skill mentions](architecture/multi-skill-mentions.md)
- [Fast GPT](architecture/fast-gpt.md)
- [Managed subagents](architecture/subagents.md) and [execution](architecture/subagent-execution.md)
- [Execution primitives](architecture/subagent-execution-primitives.md)
- [Subagents UI](architecture/subagents-ui.md)
- [Herdr handoff](architecture/herdr-handoff.md)
- [Workflow](architecture/workflow.md)

Shared integration and responsibility explanations live at `$AGENT_ARCHITECTURE_DIR/docs/architecture/`, including `pi-extension-integration.md`. New designs/plans (even changes limited to this product), deferred questions and retained evaluation results belong to that owner's `docs/plans/pi-integration/` and `docs/evaluations/pi-integration/`. Use this repository's mise root variables; do not infer checkout layout.

Stage and evaluation records are not runtime input or another protocol owner. Use explicit paths and `rg --no-ignore` for historical searches in architecture. This package's source checks, installation and runtime do not depend on that checkout.
