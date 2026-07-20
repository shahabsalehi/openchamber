# Control-plane BFF module

## Purpose and ownership

This module is the only `packages/web` boundary for the server-owned OpenChamber v2 control plane. It owns fail-closed configuration, the fixed upstream client, browser/server request authentication, response reconstruction, byte limits, and the explicit `/api/openchamber/v2` route set.

It is not a generic proxy. Browser input cannot select an upstream origin, HTTP method, path template, or forwarded header. Tenant, user, and scope identity are never created in the web server; the opaque Cloudflare Access assertion is the only identity input forwarded to the control plane.

## Entrypoints

- `config.js`: `resolveHostedWebControlPlaneConfig(runtimeName, env)` ignores control-plane configuration unless `runtimeName` is exactly `web`, then delegates to `resolveControlPlaneConfig(env)`. In hosted web, an absent key returns `null`; a present value must be byte-for-byte equal to its canonical HTTPS origin. Invalid hosted-web values throw the fixed, redacted `Invalid OpenChamber control-plane configuration` error.
- `client.js`: `createControlPlaneClient(options)` exposes named project, file, session, and credential operations. It owns fixed upstream paths, schema validation, safe response reconstruction, timeout/abort behavior, redirects, and request/response limits.
- `routes.js`: `registerControlPlaneRoutes(app, dependencies)` registers nothing without a client. When enabled it installs the exact BFF routes, performs origin validation before auth resolution, requires existing UI auth plus one bounded `Cf-Access-Jwt-Assertion`, and closes the namespace with fixed 404/405 envelopes.

## Configuration invariant

The only valid forms are canonical origins such as `https://control.example` or `https://control.example:8443`. HTTP, whitespace, trailing slash, userinfo, paths, query, fragment, malformed URLs, non-canonical host spelling, and explicit default port forms are rejected. The configured origin is never returned to clients or included in an error.

Disabled configuration means:

- no v2 route registration;
- no hosted-shell capability injection;
- no startup fetch, poll, health probe, or other v2 network work.

Invalid configuration fails hosted-web startup before v2 route or static-shell registration. Desktop and other unsupported runtimes ignore inherited control-plane configuration, including invalid values, and never register the BFF.

## Public BFF routes

All routes are under `/api/openchamber/v2` and map to the same suffix under the configured origin:

- `GET|POST /projects`
- `GET /projects/:projectId/files`
- `GET|PUT|DELETE /projects/:projectId/files/:nested/path`
- `GET|POST /projects/:projectId/sessions`
- `PUT /projects/:projectId/sessions/:sessionId`
- `GET|POST /credentials`
- `PUT|DELETE /credentials/:credentialId`
- `POST /credentials/:credentialId/revoke`

Capability mint/revoke and provider broker routes are intentionally not exposed by this BFF.

## Authentication and origin policy

Every operation requires both:

1. `uiAuthController.resolveAuthContext(req, res, { allowClientAuth: true, allowUrlToken: false })` returning a session or client context; and
2. exactly one non-empty `Cf-Access-Jwt-Assertion` no larger than 16 KiB.

The assertion is opaque. It is not parsed, normalized, logged, stored, or returned. Requests with an `Origin` header must use the canonical public request origin. A missing `Origin` is accepted for non-browser server clients. Origin mismatches are rejected before UI auth state is read. Packaged Electron, Capacitor, mobile, mini-chat, and VS Code origins receive no exception.

## Transport and data limits

- Fetch always uses `redirect: 'manual'`; redirect responses are rejected and canceled. A validated conditional `304 Not Modified` file response is preserved.
- Only the Access assertion and operation-specific protocol headers are supplied upstream. Browser cookies, authorization, forwarding headers, diagnostics, and request IDs are not copied.
- JSON responses are bounded to 1 MiB and validated into exact public records before serialization. Error bodies are bounded to 16 KiB and must exactly match a known control-plane error code, status, and message.
- File read/write is a UTF-8 text-only surface capped at 1 MiB. Declared and actual lengths are checked. Uploads are streamed through a byte-counting fatal UTF-8 validator; downloads are bounded and validated before response serialization.
- ETag conditions, application version, operation ID, expected version, content SHA-256, conflict statuses, and the allowlisted file metadata headers retain their protocol meaning.
- Timeout and inbound disconnect signals abort the upstream request. Redirected, oversized, malformed, failed, and unread streams are canceled.
- The v2 namespace bypasses shared JSON/form parsers so origin and dual-auth checks run before body consumption. An absolute request deadline starts at route entry and remains active through upload, upstream headers, bounded response reads, and serialization.
- The namespace is reserved before the generic OpenCode proxy even while disabled, including root, descendant, and encoded-prefix variants. Production compression is disabled for v2 responses so validated file length and ETag semantics remain intact.

Only reconstructed JSON, bounded validated file content, and allowlisted file protocol headers reach the downstream client. Upstream URLs, arbitrary headers, `Set-Cookie`, exception text, stacks, request IDs, and raw error bodies never do.

## Hosted shell capability

Static route ownership injects the fixed descriptor `{ "controlPlaneV2": true }` only into the hosted main `index.html` response and main SPA fallback when configuration is enabled, UI password auth is active, the Access assertion is valid in shape, and UI auth resolves. The descriptor contains no origin, assertion, token, identity, project, or secret. Injected HTML is `no-store`.

Disabled and non-qualifying main HTML remains on the original `sendFile` path. `mobile.html`, `mini-chat.html`, API-only output, Electron protocol assets, Capacitor bundles, and VS Code assets are never injected.
