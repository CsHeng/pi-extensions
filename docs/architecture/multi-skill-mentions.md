# Multi-skill mentions

`extensions/multi-skill-mentions/index.ts` adds explicit multi-skill selection without replacing Pi's native skill discovery, command expansion, or rendering.

## Ownership boundary

Pi remains authoritative for skill discovery, validation, command registration, source provenance, expansion, and message rendering. The extension reads only commands whose source is `skill`, derives their names from the `skill:` command prefix, and reads the corresponding source paths reported by Pi.

In TUI mode, the extension layers a `$` autocomplete provider over Pi's current provider. It delegates completion whenever the text before the cursor is not a skill mention or no loaded skill matches the query.

## Selection normalization

One prompt is normalized once, before Pi's native leading-command processing:

- A leading selection prefix may contain known `$name` and `/skill:name` selectors in either order, repeated in any mixture and separated by whitespace. The prefix is consumed so the remaining user tail is clean.
- Later `$name` mentions still select that skill and remain in the user's own text. Slash text after the prefix is ordinary prose.
- Repeated selections deduplicate in encounter order.
- Escaped (`\$name`), doubled (`$$name`), unknown, and identifier-embedded dollar tokens stay literal.
- A single leading `/skill:name` with no other selection keeps Pi's native path, including unknown-name pass-through and argument handling.

The extension never interprets selector-like text inside a loaded Skill body and never transforms input whose source is another extension, so extension-generated input cannot expand recursively. It stores no state, registers no model-callable tools, and makes no provider or model changes.

## Grouped presentation

Pi parses a user message that starts with one `<skill name="…" location="…">` block and renders the trailing text as the separate user message. For several selections the extension therefore emits one native-compatible envelope:

- `name` lists every selected skill in encounter order separated by `", "`, which is what Pi's collapsed and expanded skill cards show.
- `location` is the real source path of the first selection; it is a compatibility anchor, not a fabricated Skill and not a shared reference base.
- The content is one labeled section per skill with its actual name, source path, reference base, and body. A single selection keeps Pi's native single-section form.

This keeps every selected body exactly once, gives each body its own reference base, and leaves the user's tail and attachments intact instead of rendering later bodies as ordinary prose. Pi's own parser, HTML export, and collapsed skill card consume the same shape, so no renderer fork, custom editor, or extra model turn is involved.

## Failure behavior

All selected Skills are read before submission. If any selected skill can no longer be read, the extension does not submit a partially expanded prompt. It restores the original editor text where supported, reports the read error through Pi's UI, and handles the input without starting the agent.

## Verification

```bash
bun run typecheck
bun test ./tests/multi-skill-mentions.test.ts
bun test ./tests/multi-skill-mentions-installed.test.ts
bash -n scripts/run-temporary-multi-skill-mentions-probe.sh scripts/run-installed-multi-skill-mentions-probe.sh
```

The unit suite covers normalization, deduplication, literal/escaped text, the native single-selection path, and read failure against the host's own `parseSkillBlock`. The `.e2e.ts` suite is deliberate, not part of the source test glob: it runs the real installed Pi with a disposable home, agent directory, and skills, then asserts a deterministic synthetic-provider request capture for grouped and native single-slash prompts and actual fullscreen TUI evidence that both selected names and a clean user tail are rendered. It makes no live model call.

The print-mode probes are a separate paid lane because they require provider inference: `PI_OFFLINE=1` disables update traffic but not model calls. Run them only with explicit provider-call authority. Probe output contains only counts and fixed status fields.
