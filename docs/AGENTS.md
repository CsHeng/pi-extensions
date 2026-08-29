# Docs Agent Notes

## Truth Boundary

- `docs/architecture/` contains long-lived product and maintenance truth.
- `docs/evaluations/` contains bounded retained evidence, not a second architecture owner.
- `docs/plans/` contains stage artifacts and migration history, not default current truth or runtime input.
- Historical stage files listed in `contracts/markdown-prose.toml` are immutable prose-format exceptions; preserve their exact bytes unless a separately authorized historical migration supersedes them.

## Search Policy

- Default stable search: `rg -n "pattern" docs`
- Explicit stage-history search: `rg --no-ignore -n "pattern" docs/plans`
- `docs/.ignore` affects search tools, not Git tracking. Keep valuable stage artifacts in Git.

Write stable truth from verified repository behavior. Preserve durable ownership, contracts, failure modes, and operational conditions while leaving approval choreography and one-time migration narration in stage history.
