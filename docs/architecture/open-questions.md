# Open architecture questions

This file records unresolved cross-cutting architecture questions that are intentionally deferred. An entry does not authorize implementation; the current component architecture documents remain authoritative until a question is resolved.

## Multi-skill mention rendering

**Status:** Deferred for a broader Pi TUI and user-experience pass.

### Current behavior

`multi-skill-mentions` expands every uniquely selected loaded skill into the same user message before the unchanged original prompt. Pi persists and sends that one message to the model, so all selected skill bodies and their order are present in model context. A manual abort followed by another submission creates a separate branch attempt; the extension does not submit an additional skill message.

The currently verified Pi TUI parser recognizes one leading `<skill>` block. When the message contains several consecutive top-level blocks, it renders the first as a skill invocation card and treats the remaining blocks plus the original prompt as the card's trailing user message. This can look like an additional user submission even though the session contains only one user message for that attempt. Pi's HTML export contains the same single-block parsing assumption.

### Constraints

- Preserve the current model-facing content, skill order, per-skill source provenance, and all-or-nothing read failure behavior.
- Do not silently truncate skill bodies or impose an arbitrary skill-count or byte limit; selected skill content is semantic input, while Pi owns context-window handling and visible context failures.
- Keep interactive, RPC, JSON, print, steering, follow-up, reload, and resume behavior coherent.
- Do not depend on monkey-patching private `InteractiveMode` methods or replacing immutable ESM imports from an extension.
- Keep an already expanded message idempotent if a Pi editing or queue workflow returns it to input processing.

### Candidate directions

1. **Extend Pi's renderer:** replace the single-block parser with a multiple-block parser and update the TUI and HTML exporter to render every leading skill block before the original prompt. This preserves the current model representation and is the preferred direction if the broader Pi UI/UX work can change the host.
2. **Bypass the single-block parser through public extension APIs:** add an extension-owned envelope or marker and use a Markdown transformer to render a compact selection summary plus the original prompt. This keeps the existing model payload but gives up native per-skill invocation cards and must account for non-TUI and HTML rendering.
3. **Emit one composite skill envelope:** retain every selected skill as a clearly delimited section inside one top-level Pi-compatible skill block. This works with the current native card but changes the model-facing representation from several top-level skill blocks to one synthetic composite.
4. **Persist raw user text and expand only copied context:** this produces the cleanest transcript but is not currently preferred because context-hook failures fail open, historical skill files can drift across reload or resume, and queued steering or follow-up messages complicate transactional snapshot ownership.

### Reconsideration triggers

Revisit this question when the broader Pi TUI/UX work begins, Pi adds a public user-message or skill-rendering hook, Pi gains native multiple-skill rendering, or evidence shows that the current display ambiguity affects model context, session correctness, or routine operation rather than presentation alone.
