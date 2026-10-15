# Shared definitions for the Lumen apps

Things every client must agree on. Each app's unit tests load these files, so a
change here is a change for all four apps at once.

| File | What it pins down | Used by |
|---|---|---|
| `test-vectors/url-validation.json` | which server/endpoint URLs are accepted (https only, no user-info, loopback http only in debug builds) | desktop (`apps/desktop` tests), Android (`:core` tests), iOS (`LumenTests`) |
| `test-vectors/wellknown.json` | parsing of `/.well-known/matrix/client` incl. the `io.lumen.app` block; invalid optional URLs are dropped, not followed | same |
| `test-vectors/deeplinks.json` | routing of `io.lumen.secure:` callbacks, `matrix.to` and `matrix:` links; everything else is rejected | same |

The design tokens are generated from `design/tokens.css` by
`design/tools/gen_tokens.py`. The server contract is in
`docs/apps/integration.md`.
