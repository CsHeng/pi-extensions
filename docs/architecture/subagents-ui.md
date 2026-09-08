# Subagents UI

`extensions/subagents-ui/index.ts` is a TUI-only consumer of bounded `csheng_subagents` lifecycle snapshots. It does not execute children, own cancellation settlement, or write the working row or footer. The default package load list omits this entry; live progress belongs on the `csheng_subagents` tool row.

## Surfaces

- keyed status `csheng.subagents.status`
- below-editor widget `csheng.subagents.panel`
- `/subagents-ui` and `Ctrl+Alt+F` overlay inspector
- custom entry `csheng-subagents-run` after a settled snapshot

The inspector can request confirmed run or task cancellation over `csheng.subagents.cancel.request.v1`. Receipts prove only that the core accepted or rejected the request. The structured tool result remains the outcome authority. These panel/inspector snapshots and cancellation receipts remain one-shot-only. Managed episodes use their own native inline tool progress and result renderer, including idle/closed state and the distinction between report, apply, and parent acceptance; the optional panel does not invent managed scheduler state.

## Independence

The extension listens through `pi.events` and validates every payload. It is inert in RPC, JSON, and print modes. Removing it leaves `csheng_subagents` unchanged. Removing the core leaves this extension idle and safe.

See [`subagents.md`](subagents.md) and [`subagent-execution.md`](subagent-execution.md) for the separate execution, provenance, and observation contracts. The independent `work-timing` extension retains its v1 parent-only reasoning/wall display and headless inactivity.
