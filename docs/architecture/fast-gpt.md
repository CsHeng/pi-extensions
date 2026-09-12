# Fast GPT

`extensions/fast-gpt/index.ts` is a small request payload profile for official OpenAI Responses integrations. It registers `/fast-gpt` and does not replace Pi's model selection, provider integration, accounting, or agent loop.

## Request profile

The profile has three branch-local states:

- `untouched`: the initial state, before the first command
- `priority`: correlated requests receive top-level `service_tier: priority`
- `default`: correlated requests receive top-level `service_tier: default`

The first `/fast-gpt` command selects `priority`; later commands toggle between `priority` and `default`. The extension deliberately does not add a service tier while state is `untouched`. State follows the active session branch, so selecting or toggling the profile on one branch does not silently select it on another.

Only requests whose provider, API, and model correlation identifies an official OpenAI or OpenAI-Codex Responses request are changed. A supported request receives the selected `service_tier` at the request's top level. An unsupported or uncertain provider/API/model correlation is left unchanged by this profile rather than guessed or widened.

## Ownership boundary

Pi remains authoritative for the active model, provider, request execution, session persistence, and displayed usage and cost. The provider response remains authoritative for the service tier actually served and any resulting usage or cost. Selecting `priority` is a request, not a guarantee of provider acceptance, latency, availability, or price.

The extension owns only its branch-local tri-state selection and the bounded request transformation. It provides no model alias, provider override, pricing parser, synthetic usage or cost calculation, live provider call, workflow phase, approval rule, retry, or fallback. It does not reinterpret provider responses.

## Response observability

The keyed `fast-gpt` status is a warning-colored lightning mark for the selected request profile, not a confirmed provider result. The default Pi footer shows that mark; `status-footer` may place the same key after thinking without importing this extension. Standard OpenAI Responses payloads expose the actual tier as top-level `response.service_tier`, including under `response.completed.response.service_tier` in the streaming protocol, but Pi's extension hooks expose only response status and headers after dispatch. Pi's normalized assistant message does not retain that field, so this standalone extension cannot inspect or display the tier actually served.

OpenAI-Codex responses may report `default` when the request selected `priority`. Pi's Codex adapter can reconcile that value when priority was supplied through its typed stream options, but this extension changes only the finalized request payload. If the backend reports `default` in that case, Pi's displayed cost may remain default-priced even though priority was requested. Provider-side service and billing remain authoritative; perceived latency is only informal evidence and not a verification signal.

## Failure and removal

Unknown correlations fail closed by preserving the original request. Removing the extension removes `/fast-gpt` and its request transformation without changing the behavior, state, tests, or removal contract of the other package extensions. No migration or persistent provider-setting cleanup is required.

## Verification

The payload boundary is covered by deterministic unit tests; this extension intentionally adds no temporary-load, installed-package, or live provider probe.

```bash
node --experimental-strip-types --test tests/fast-gpt.test.ts
node --experimental-strip-types --test tests/package.test.ts
npm run typecheck
```
