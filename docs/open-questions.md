# Open Questions and Follow-ups

This list records deferred work, not changes to current runtime behavior.

## Remove plan-mode

- Status: deferred implementation; the removal direction is settled and does not need another usefulness discussion.
- Reason: the user does not use `plan-mode` and does not want it to remain a focus of maintenance.
- Follow-up: remove the extension and its package registration, dedicated documentation, tests, and probes in a separate change while preserving the other extensions.
- Boundary: recording this item does not remove the extension or change Pi settings. Its removal is not a prerequisite for the task/workflow extension design.
