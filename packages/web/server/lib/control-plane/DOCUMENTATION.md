# Control-plane BFF module

## Purpose and ownership

This module is the only `packages/web` boundary for the server-owned OpenChamber v2 control plane. It owns fail-closed configuration, the fixed upstream client, browser/server request authentication, response reconstruction, byte limits, and the explicit `/api/openchamber/v2` route set.

It is not a generic proxy. Browser input cannot select an upstream origin, HTTP method, path template, or forwarded header. Tenant, user, and scope identity are never created in the web server; the opaque Cloudflare Access assertion is the only identity input forwarded to the control plane.

## Entrypoints

- `config.js`: `resolveHostedWebControlPlaneConfig(runtimeName, env)` ignores control-plane configuration unless `runtimeName` is exactly `web`, then delegates to `resolveControlPlaneConfig(env)`. In hosted web, an absent key returns `null`; a present value must be byte-for-byte equal to its canonical HTTPS origin. Invalid hosted-web values throw the fixed, redacted `Invalid OpenChamber control-plane configuration` error.
- `client.js`: `createControlPlaneClient(options)` exposes named project, file, session, credential, and public sandbox-runtime status/reservation operations. It owns fixed upstream paths, schema validation, safe response reconstruction, timeout/abort behavior, redirects, and request/response limits. Trusted claim/begin/complete RPCs are never part of this client.
- `routes.js`: `registerControlPlaneRoutes(app, dependencies)` registers nothing without a client. When enabled it installs the exact BFF routes, performs origin validation before auth resolution, requires existing UI auth plus one bounded `Cf-Access-Jwt-Assertion`, and closes the namespace with fixed 404/405 envelopes. Sandbox-runtime routes have the separate injected `sandboxRuntimeEnabled === true` gate.

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

The following fixed routes are registered only when the server-owned `sandboxRuntimeEnabled` option is exactly `true`:

- `GET /projects/:projectId/sandbox-runtime`
- `POST /projects/:projectId/sandbox-runtime/ensure`
- `POST /projects/:projectId/sandbox-runtime/pause`
- `POST /projects/:projectId/sandbox-runtime/resume`
- `POST /projects/:projectId/sandbox-runtime/destroy`
- `POST /projects/:projectId/sandbox-runtime/checkpoint`
- `POST /projects/:projectId/sandbox-runtime/replace`

They are fixed public Project Durable Object pass-throughs only. Mutation bodies contain session ID plus expected generation/revision; checkpoint alone also contains a positive workspace revision. Every mutation has exactly one bounded `X-Operation-Id`. Responses are reconstructed public status/reservation DTOs with readiness exactly `disabled`; provider references, supervision, endpoints, capabilities, and every trusted dispatch RPC remain server-private.

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

Static route ownership injects the fixed descriptor `{ "controlPlaneV2": true }` only into the hosted main `index.html` response and main SPA fallback when configuration is enabled, UI password auth is active, the Access assertion is valid in shape, and UI auth resolves. When and only when the independent runtime gate is true, the exact descriptor is `{ "controlPlaneV2": true, "sandboxRuntimeV2": true }`. False keys are not injected. The descriptor contains no origin, assertion, token, identity, project, or secret. Injected HTML is `no-store`.

Disabled and non-qualifying main HTML remains on the original `sendFile` path. `mobile.html`, `mini-chat.html`, API-only output, Electron protocol assets, Capacitor bundles, and VS Code assets are never injected.

## Sandbox-runtime rollout gate

Current production startup passes `sandboxRuntimeEnabled: false`. The process-local sandbox runtime is not evidence of hosted readiness: OpenSandbox real create support and a durable trusted claim/begin/complete dispatcher are both unavailable. Therefore production registers no sandbox-runtime BFF route, advertises no `sandboxRuntimeV2` capability, and performs no runtime startup I/O. Enabling the option requires all real provider reconciliation and fenced dispatch dependencies to be present; the BFF itself never substitutes for them.
