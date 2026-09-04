# Subagents UI

`extensions/subagents-ui/index.ts` is a TUI-only consumer of bounded `csheng_subagents` lifecycle snapshots. It does not execute children, own cancellation settlement, or write the working row or footer.

## Surfaces

- keyed status `csheng.subagents.status`
- below-editor widget `csheng.subagents.panel`
- `/subagents-ui` and `Ctrl+Alt+F` overlay inspector
- custom entry `csheng-subagents-run` after a settled snapshot

The inspector can request confirmed run or task cancellation over `csheng.subagents.cancel.request.v1`. Receipts prove only that the core accepted or rejected the request. The structured tool result remains the outcome authority.

## Independence

The extension listens through `pi.events` and validates every payload. It is inert in RPC, JSON, and print modes. Removing it leaves `csheng_subagents` unchanged. Removing the core leaves this extension idle and safe.

See [`subagents.md`](subagents.md) for execution, provenance, and telemetry ownership.
