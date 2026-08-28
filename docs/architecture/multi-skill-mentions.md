# Multi-skill mentions

`extensions/multi-skill-mentions/index.ts` adds explicit multi-skill selection without replacing Pi's native skill discovery or command expansion.

## Ownership boundary

Pi remains authoritative for skill discovery, validation, command registration, and source provenance. The extension reads only commands whose source is `skill`, derives their names from the `skill:` command prefix, and reads the corresponding source paths reported by Pi.

In TUI mode, the extension layers a `$` autocomplete provider over Pi's current provider. It delegates completion whenever the text before the cursor is not a skill mention or no loaded skill matches the query.

For interactive, RPC, JSON, or print input, the extension expands every uniquely mentioned loaded skill into a `<skill>` block before the unchanged original prompt. Mention order is preserved. Unknown names, duplicate mentions after the first, escaped mentions, shell variables, and `$` tokens embedded in identifiers do not cause additional expansion.

## Failure behavior

If a selected skill can no longer be read, the extension does not submit a partially expanded prompt. It restores the original editor text where supported, reports the read error through Pi's UI, and handles the input without starting the agent.

Input injected by another extension is never transformed, which prevents extension-to-extension recursion. The extension stores no state, registers no model-callable tools, and makes no provider or model changes.

## Verification

```bash
npm run check
bash scripts/run-temporary-multi-skill-mentions-probe.sh
bash scripts/run-installed-multi-skill-mentions-probe.sh
```

The temporary probe loads the authored extension by explicit path with two isolated skills. The installed probe verifies current package discovery and confirms that extension-off mode does not expand the same mentions. Probe output contains only counts and fixed status fields.
