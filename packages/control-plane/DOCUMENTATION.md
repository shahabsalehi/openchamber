# Durable v2 Control Plane

## Purpose and ownership

`@openchamber/control-plane` is an independent Cloudflare Worker package.
Versioned canonical scopes are SHA-256 hashed and routed through deterministic
Durable Object names, so there is no singleton bottleneck: tenant/project scopes
use `PROJECTS.getByName()` and tenant/user scopes use `VAULTS.getByName()`.

SQLite in that `ProjectDurableObject` is authoritative for:

- immutable object scope binding;
- project metadata and optimistic revision;
- session metadata and optimistic revision;
- visible file manifests, immutable application versions, and operation state;
- exact-key blob cleanup work; and
- provider-neutral sandbox lease/lifecycle coordination.

R2 is authoritative for file bytes only. SQLite never contains a file body or
large artifact. R2 never determines which file/version is visible, and R2
listing is never used for recovery or authority. The configured `FILES` bucket
is exclusively owned by this control plane: no other Worker, lifecycle rule,
operator, or integration may write, overwrite, or delete its objects.

SQLite in each `VaultDurableObject` is authoritative for:

- immutable tenant/user/hash scope binding;
- provider credential metadata and encrypted envelope fields; and
- capability issuance, revocation, expiry, and bounded-use state.

Vault SQLite never stores a plaintext credential or raw capability token.
Project SQLite never stores a credential, encrypted envelope, or capability.

This package does not alter `packages/web/server/lib/sandbox`. The milestone-1
module remains the server-side OpenSandbox adapter and ephemeral provider
lifecycle owner. A later trusted adapter may apply provider results to the lease
RPCs here. Milestone 3 adds only one fixed OpenAI-compatible Chat Completions
HTTP operation; it does not expose provider credentials/handles/endpoints to
browsers, import provider SDKs, or add generic provider/sandbox orchestration.

## Authentication and routing boundary

The default export uses a reject-all `PrincipalAuthenticator`. Public identity,
tenant, role, or principal headers are ignored. Existing milestone-2 routes
retain the original `Principal` / `PrincipalAuthenticator` contract. A trusted
deployment composes those routes with
`createControlPlaneHandler({ authenticator })` exactly as before.

For every recognized request, the front Worker:

1. validates the tenant/project identifiers;
2. obtains and strictly validates `{ id, projectScopes }` from the injected
   authenticator;
3. checks exact tenant/project membership before touching the Durable Object namespace;
4. derives `project-v1-<sha256(canonical-scope)>`; and
5. constructs the trusted `ProjectRpcContext` passed to the typed RPC.

Every RPC validates that context again, including exact membership in the
principal's `projectScopes`. It recalculates the expected object name and rejects
a call when `ctx.id.name` does not match, then transactionally binds
`project_scope` on first use. A different tenant/project can never reuse that
object. Direct RPC bindings are therefore trusted server boundaries, not browser
APIs and not substitutes for front-door authentication. In particular,
`PROJECTS` is a trusted capability binding. It must never be exposed to
tenant-controlled or semi-trusted Workers, because possession bypasses the
front Worker's authentication boundary even though each RPC still validates its
trusted context and object scope.

All public errors come from the fixed allowlist in `errors.ts`. Unknown runtime
failures become `STORAGE_FAILURE`; raw exceptions, authorization values, request
bodies, provider payloads, handles, endpoints, and credentials are never
reflected or logged.

Milestone-3 routes use a separate, narrower `VerifiedPrincipalAuthenticator`.
Its result extends `Principal` with application-owned `tenantId` and `userId`;
all project scopes must belong to that tenant. Tenant/user authority never comes
from a URL, route body, email address, or public identity header.

### Cloudflare Access adapter

`createCloudflareAccessAuthenticator` reads only
`Cf-Access-Jwt-Assertion`; it never reads `CF_Authorization`, email, tenant, or
principal headers. Without `jose` or another dependency it:

1. parses strict bounded canonical base64url JWT segments;
2. requires `alg: RS256` and selects exactly one eligible RSA signing JWK by
   `kid`;
3. verifies the signature with Web Crypto `RSASSA-PKCS1-v1_5` / SHA-256;
4. requires exact configured issuer and exactly one configured audience;
5. requires unexpired integer `exp`, enforces optional integer `nbf`, and
   validates optional integer `iat`; and
6. passes the verified `sub` and claims, with `email` removed, to a replaceable
   application mapper.

`createSubjectIdentityMapper` is the package's deterministic mapping helper. It
keys mappings only by verified subject and returns application-owned principal,
tenant, user, and project IDs. Email can be present in the signed token but is
removed before mapping and is not an identity key. Access signing keys can be supplied by any
`AccessJwksResolver`; `createRemoteAccessJwksResolver` performs one bounded,
manual-redirect HTTPS fetch against a fixed `/cdn-cgi/access/certs` URL.

`createExplicitTokenAuthenticator` accepts only explicitly configured local/test
Bearer tokens. It is deterministic and never becomes an automatic fallback for
Access failures.

## Public HTTP surface

### Project metadata

`GET /v2/tenants/:tenantId/projects/:projectId`

Returns the project record or `NOT_FOUND` before creation.

`PUT /v2/tenants/:tenantId/projects/:projectId`

Accepts exactly:

```json
{ "name": "Project name", "expectedRevision": null }
```

`null` creates revision 1. Updates supply the current positive revision and
increment it atomically; stale revisions return `VERSION_CONFLICT`. JSON bodies
are streamed into a bounded 16 KiB parser.

### File write

`PUT /v2/tenants/:tenantId/projects/:projectId/files/:nested/path`

Required headers:

- `X-Operation-Id`: opaque 8-128 character idempotency key;
- `X-Expected-Version`: `0` only when no manifest has ever existed, otherwise
  the manifest's current positive application version;
- `X-Content-SHA256`: lowercase hexadecimal SHA-256 of the body;
- `Content-Length`: byte length; and
- `Content-Type`.

At most one of `If-Match` or `If-None-Match` may be supplied. `If-Match: *`
requires a live file; a quoted ETag must equal the live R2 HTTP ETag.
`If-None-Match: *` fails when a live file exists, and a quoted ETag fails only
when it equals the live ETag. Application version checks are always enforced,
independently of HTTP conditions.

The success JSON is a `FileVersionRecord` containing `path`, `appVersion`, raw
R2 `etag`, quoted `httpEtag`, R2 `r2Version`, byte `size`, `contentType`, body
`contentSha256`, creation time, and `storageState`.

### File read

`GET /v2/tenants/:tenantId/projects/:projectId/files/:nested/path`

The optional single `?version=N` selects a historical immutable version while
the file manifest remains live. `If-Match` and `If-None-Match` support `*` or one
quoted ETag. Conditional reads are sent to exact-key R2 `get`, so even a 304 or
412 verifies that the authoritative blob still exists and matches its stored
metadata.

Successful bodies are streamed directly from R2. Response headers expose:

- `ETag` (the quoted R2 HTTP ETag);
- `X-Application-Version`;
- `X-R2-ETag`;
- `X-R2-Version`;
- `Content-Length`; and
- `Content-Type`.

A missing or mismatched object referenced by a live manifest is
`INTEGRITY_ERROR`, never empty success.

### File delete

`DELETE /v2/tenants/:tenantId/projects/:projectId/files/:nested/path`

Requires `X-Operation-Id` and the positive current `X-Expected-Version`.
Optional `If-Match` has the same live-ETag semantics as write. Success returns
the tombstone application version and whether physical cleanup remains pending.

Unknown query parameters, duplicate `version`, malformed percent encoding,
empty segments, `.`/`..`, backslashes, controls, and oversized file paths are
rejected.

## Verified credential and capability HTTP surface

These routes require the injected `milestone3.authenticator`, encryption key
ring, and capability key ring. Recognized requests authenticate before method
handling. Scope and bounded body validation happen before a Vault stub is
obtained whenever no Vault read is required to complete validation. Unread
bodies are canceled after early rejection.

### Credential collection

`GET /v2/credentials`

Lists the verified tenant/user's credential metadata in creation order. Records
contain only `credentialId`, `name`, fixed provider `openai`, positive
`generation`, `active|revoked` status, and timestamps.

`POST /v2/credentials`

Accepts exactly one bounded 16 KiB JSON object:

```json
{ "name": "Primary key", "provider": "openai", "value": "write-only value" }
```

The write-only value must contain 1-16 KiB of printable ASCII without spaces or
control characters so it can be placed safely in the fixed provider bearer
header. The server creates the opaque credential ID and generation 1 envelope
before calling the Vault. The value is never returned. Success is `201` with
metadata. Duplicate IDs/names are version conflicts.

### Credential rotation, revocation, and deletion

`PUT /v2/credentials/:credentialId`

```json
{ "expectedGeneration": 1, "value": "replacement write-only value" }
```

The Vault metadata read supplies the immutable provider/name AAD dimensions.
The handler encrypts generation `expectedGeneration + 1`, then the Vault
atomically checks the expected generation, activates the replacement envelope,
and revokes every capability for that credential. A stale concurrent rotation
cannot publish its envelope.

`POST /v2/credentials/:credentialId/revoke`

```json
{ "expectedGeneration": 2 }
```

The Vault atomically marks the credential revoked and revokes all related
capabilities. Rotation can explicitly replace/reactivate a revoked credential
as a new generation.

`DELETE /v2/credentials/:credentialId`

Requires positive `X-Expected-Version` and no body. The Vault transaction first
revokes all related capability rows, then deletes the credential row. Capability
state remains as a durable revoked audit/use record until a later issuance
opportunistically prunes rows that have been expired for at least 24 hours; the
encrypted envelope is removed. All three mutation responses are metadata-only.

### Capability mint and revoke

`POST /v2/projects/:projectId/sessions/:sessionId/providers/openai/credentials/:credentialId/capabilities`

Accepts exactly:

```json
{ "ttlSeconds": 60, "maxUses": 1 }
```

TTL must be 1-300 seconds and `maxUses` must be 1-3. Before acquiring a Vault
stub, the front handler checks exact verified project scope and calls the
deterministic Project DO's existing `getSession` RPC. It then loads active
credential metadata, creates/signs claims, and asks the Vault to persist them.
The Vault repeats tenant/user/project authorization, deterministic object/scope
checks, authoritative Project DO session lookup, and credential
provider/name/generation checks before insertion.

Success is `201`:

```json
{
  "capability": "v1.<canonical-claims>.<signature>",
  "jti": "opaque-id",
  "expiresAt": 2000000060,
  "maxUses": 1
}
```

This is the only response containing the raw capability. The `jti` can be
revoked with `DELETE /v2/capabilities/:jti`; that route returns only `jti` and
`revokedAt`.

## Credential envelope and secret-binding contract

Crypto material enters source operations only through injected
Secrets Store-compatible values:

```ts
interface SecretValueBinding {
  get(): Promise<string>
}
```

`SecretKeyRing` associates these values with non-secret `keyId` labels and names
one active write key. Secret values are canonical unpadded base64url encodings of
exactly 32 random bytes. Every operation calls `get()` and imports a nonextractable
Web Crypto key locally; there is no module-global plaintext or key cache.

Production binding IDs, store IDs, secret names/values, and local `.dev.vars`
are deployment-owned and intentionally absent from `wrangler.jsonc` and this
repository. A production deployment must bind its Secrets Store entries through
a private Wrangler overlay or dashboard. Tests generate values in workerd.

Credentials use AES-256-GCM with a fresh random 12-byte nonce and 128-bit tag.
The explicit envelope columns/fields are version (`1`), `keyId`, canonical
base64url nonce, ciphertext, and tag. AAD is a versioned fixed-order,
length-delimited UTF-8 serialization of:

1. envelope version;
2. tenant ID;
3. user ID;
4. provider;
5. credential ID;
6. credential name;
7. credential generation; and
8. key ID.

Writes always use the active encryption key. Reads select exactly one key by the
persisted `keyId`; unknown/duplicate/wrong keys and nonce/ciphertext/tag/AAD
tampering fail closed. Rotation of the key ring does not automatically
re-encrypt existing credentials; old read keys must remain available until an
explicit credential replacement retires their envelopes.

## Canonical capability format and durable use state

A capability is `v1.<base64url(canonical JSON)>.<base64url(HMAC)>`. The signature
is HMAC-SHA-256 over the ASCII `v1.<payload>` and is verified with
`crypto.subtle.verify`. The JSON serializer emits this exact field order:

`version`, `kid`, random `jti`, fixed issuer `openchamber-control-plane`, fixed
audience `credential-broker`, `tenantId`, `userId`, `projectId`, `sessionId`,
fixed provider `openai`, `credentialId`, `credentialName`, positive credential
generation, fixed operation `chat.completions`, exact broker `path`, fixed method
`POST`, `iat`, `exp`, and `maxUses`.

Verification rejects malformed/oversized tokens, noncanonical JSON/base64url,
unknown or duplicate keys, altered claims/signatures, a future `iat`, expiry, or
a lifetime over 300 seconds. SQLite stores every claim plus use count,
revocation time, and creation time, but never the raw token. Each issuance first
prunes rows expired for at least 24 hours through an expiry index in the same
Vault transaction, bounding growth for active vaults while preserving a short
audit window.

The broker verifies the signature and exact authenticated
tenant/user/project/session/provider/path/method before any Project/Vault stub.
It checks authoritative session state through the Project DO, then calls
`reserveCapabilityUse`. In one Vault transaction that method compares every
signed claim with the issuance row, rejects expiry/revocation/exhaustion,
requires the current active credential to match provider/name/generation, and
increments `use_count` before returning the internal encrypted envelope. That
reservation is the replay boundary. A provider error still consumes the use;
there is no unsafe rollback after external I/O.

Credential rotation, revocation, and deletion set `revoked_at` on all related
capabilities in the same transaction as the credential transition. Explicit
capability revocation does the same for one `jti`. A request already reserved
and executing upstream can complete if revocation commits after reservation;
cross-service revocation cannot cancel that in-flight provider request. New or
unreserved uses fail immediately.

## Fixed OpenAI-compatible broker

`POST /v2/projects/:projectId/sessions/:sessionId/providers/openai/chat/completions`

The client supplies its verified identity normally and sends the minted token in
`X-OpenChamber-Capability`. No provider credential is sent to or returned from
the browser/sandbox.

The request is `application/json`, capped by both declared and actual bytes at 1
MiB, and accepts only this strict subset:

```json
{
  "model": "gpt-4.1-mini",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false,
  "temperature": 0.5,
  "max_tokens": 1024
}
```

`model` is a bounded identifier. There must be 1-256 exact `{ role, content }`
messages; roles are `system|user|assistant|tool`. `stream` defaults to false,
temperature is optional 0-2, and `max_tokens` is an optional positive bounded
integer. Unknown fields (including URL, path, query, provider, or header fields)
are rejected.

### Direct mode

`directOpenAiRouting` always returns exactly
`https://api.openai.com/v1/chat/completions`. Only after atomic reservation does
the broker decrypt the bound per-user vault envelope and create a new outbound
header set containing `Content-Type`, expected `Accept`, and that value as
`Authorization: Bearer ...`.

### Optional AI Gateway mode

`createAiGatewayRouting` validates and freezes one URL on the exact
`https://gateway.ai.cloudflare.com` origin, with no credentials, port, query, or
fragment and the path shape
`/v1/:account/:gateway/openai/chat/completions`. It is optional and has no
provider/Cloudflare SDK dependency.

Gateway mode deliberately never decrypts or injects the per-user vault value.
The vault credential/generation remains the capability's tenant/user policy
anchor only. Optional gateway authentication is read from its own binding and
sent as `cf-aig-authorization`; optional service-managed provider authorization
is read from a separate binding and sent as `Authorization`. Both bound values
must be 1-16 KiB of printable non-space ASCII. When the configured
AI Gateway owns BYOK, the service-provider binding is omitted. Direct user-key
and gateway service-key/BYOK modes are never silently substituted.

### Outbound and response policy

- Routing is server-owned. The broker enforces HTTPS and exact fixed origin/path
  and creates no query string.
- Only `POST` is supported. Outbound headers are reconstructed; inbound cookies,
  authorization, forwarding, provider, URL, and diagnostic headers are ignored.
- Fetch always uses `redirect: manual`; every 3xx is rejected and its body is
  canceled. Non-200 responses are also canceled and mapped to one fixed error.
- One combined client/deadline signal covers route resolution, secret reads,
  fetch, and response streaming. Default timeout is 30 seconds (configuration is
  bounded to 1-120 seconds); abort failures map to fixed errors.
- Non-stream responses must be `application/json`, have declared and actual
  bytes at most 4 MiB, decode as UTF-8, and parse as a JSON object.
- Stream responses must be `text/event-stream`; declared and aggregate actual
  bytes are capped at 8 MiB. Events are reconstructed from strict OpenAI `data:`
  JSON/`[DONE]` records; error events/envelopes terminate the stream without
  forwarding their payload. Overflow cancels the upstream reader and errors the
  returned stream.
- Success responses reconstruct only safe `Content-Type`. `Location`,
  `Set-Cookie`, `WWW-Authenticate`, request IDs, diagnostic headers, upstream
  URLs, and arbitrary headers never pass through.
- Redirect/error bodies, HTTP-200 JSON `error` envelopes, and unsanitized
  messages are never returned. All public
  failures come from the fixed error allowlist; tokens, credentials, ciphertext,
  stack traces, raw bodies, and upstream diagnostics are excluded.

## Typed trusted RPC surface

`ProjectDurableObject` exposes typed context-bearing methods for:

- `getProject`, `putProject`;
- `createSession`, `updateSession`, `getSession`, `listSessions`,
  `deleteSession`;
- `writeFile`, streaming `readFile`, `listFileVersions`, `deleteFile`;
- `createSandboxLease`, `updateSandboxLease`, `getSandboxLease`,
  `listSandboxLeases`, `deleteSandboxLease`; and
- `recoverProjectStorage`.

The alarm invokes the same internal storage recovery without inventing a
principal. All non-RPC implementation methods use ECMAScript `#private` names,
so SQL and cleanup helpers do not exist as string-named RPC properties.
The production Durable Object class has no string- or symbol-keyed fault
injection method. Package tests hold fault state in a module-local `WeakMap` and
set it only against a local instance obtained through `runInDurableObject`.

## SQLite schema and transaction rules

- `project_scope`: immutable tenant/project/hash binding for this object.
- `projects`: the optional singleton project record and revision.
- `sessions`: project-local session title, revision, and timestamps.
- `file_manifests`: current application version, active version, or tombstone.
- `file_versions`: immutable exact R2 metadata/checksum and cleanup state.
- `file_write_operations`: idempotency fingerprint, reserved exact key, expected
  and target versions, immutable reservation/upload start anchors, and
  `reserved|uploading|uploaded|published|aborted` state.
- `file_delete_operations`: deterministic delete replay result.
- `cleanup_jobs`: exact R2 key plus optional file-version reference and attempts.
- `sandbox_leases`: optional session association, provider id/opaque handle,
  provider-neutral status, lifecycle revision, expiry, and cleanup state.

Schema initialization is the only work inside `blockConcurrencyWhile`.
Mutation/query cursors are synchronously consumed. Related multi-row changes
use `transactionSync`; no `await`, external I/O, manual `BEGIN`, or savepoint is
placed inside a transaction.

Deleting an associated session detaches each lease and increments its lifecycle
revision rather than deleting provider coordination. SQLite contains no file
bodies, credentials, endpoint URLs/headers, raw provider errors, or production
orchestration payloads.

## Scope, path, and object keys

Canonical scope strings are versioned and length-delimited before hashing. File
paths are NFC-normalized metadata. Blob keys are:

`ocp-v2/files/v1/<scope-sha256>/<path-sha256>/<random-opaque-blob-id>`

No raw tenant, project, path, principal, operation id, provider id, or provider
handle appears in a key. R2 custom metadata contains only an opaque correlation
id. Every cleanup/read/recovery action addresses one exact persisted key.

## Write publication and recovery

There is deliberately no claimed SQLite/R2 transaction. A write proceeds as:

1. arm the object's recovery alarm without postponing any earlier alarm;
2. transactionally validate the expected manifest/HTTP condition and reserve an
   invisible operation with a unique immutable key; operation identifiers are
   unique across both write and delete mutation kinds;
3. reconfirm recovery after the asynchronous reservation work, so an alarm
   consumed while keys were being derived cannot strand the committed row; if
   reconfirmation fails, a still-unuploaded `reserved` row is removed;
4. register one in-memory Promise flight for the operation identifier; an
   identical concurrent request cancels its second body and awaits that Promise;
5. transactionally move `reserved` to `uploading` and set `upload_started_at`
   immediately before external upload, then pipe the RPC stream through
   `FixedLengthStream(Content-Length)` into a create-only R2 put with the expected
   SHA-256 and opaque correlation;
6. verify the exact object's key, correlation, size, content type, checksum,
   ETags, and R2 version;
7. record uploaded metadata; and
8. synchronously publish the immutable version, manifest, and operation state in
   one SQLite transaction, then acknowledge.

The request body is never fully buffered. The fixed-length stream preserves the
known length required by workerd/R2 after the stream crosses RPC. Its producer is
abortable: when a conditional put returns `null` or rejects before consuming the
body, the producer is aborted before its settlement is awaited, and both the put
and pipe promises are always consumed.

| Failure point | Visible state | Deterministic result |
| --- | --- | --- |
| Validation/version/condition | Prior manifest only | No reservation or blob. |
| Alarm reconfirmation after reservation | Prior manifest only | A still-unuploaded reservation is removed; no blob. |
| Uploading, put fails before creation | Prior manifest only | Same operation/fingerprint can retry with a new stream; exact-key head proves absence. |
| Put outcome is ambiguous | Prior manifest only | Exact-key head and expected metadata decide whether upload occurred. |
| Blob exists, SQL upload/publish fails | Prior manifest only | Exact key and full intent remain recoverable; retry/alarm publishes after verification. |
| Publication loses its expected version | Prior manifest only | Operation aborts and its exact unacknowledged key is queued for cleanup. |
| Publication commits | New manifest/version visible | Acknowledgement is returned only now; replay returns the same version. |

Recovery orders batches by mutable `updated_at`. A failed/blocked attempt updates
only that ordering timestamp so it rotates behind other work. `created_at` is
the immutable reserved-staleness anchor and `upload_started_at` is the immutable
uploading-staleness anchor; retries never refresh either anchor. Recovery skips
a current in-memory Promise flight before HEAD, after HEAD, and again immediately
before any abort. After eviction/restart there is no flight, so stale reserved or
uploading state can be recovered or aborted. Every abort transaction predicates
the rechecked current durable state, preventing a stale recovery snapshot from
aborting an operation that advanced.

Uploaded operations with missing blobs are aborted as integrity failures.
Mismatched or state-lost unacknowledged objects are never published and are
queued for cleanup by exact key. Publication follows exact-object verification,
so no successful acknowledgement may leave a manifest pointing at a known
missing blob. Operation fingerprints bind the idempotency key to the validated
principal as well as the request intent.

## Tombstone and cleanup recovery

Delete first arms recovery, then transactionally writes the manifest tombstone,
marks every live version `cleanupPending`, creates exact-key cleanup jobs, and
records the delete operation. If the alarm cannot be armed, no tombstone is
committed. The tombstone hides that file generation immediately, and physical R2
cleanup cannot re-expose it. The logical path may be recreated, but the write
must supply the tombstone's application version, not the last live generation's
version.

Before any unconditional `R2.delete(key)`, cleanup first HEADs that exact key. A
manifest job must load the exact file version, require the same key and
`cleanupPending`, and verify the complete persisted key/correlation/size/content
type/checksum/ETag/R2-version identity. An orphan job must load the exact write
operation by key, require `aborted`, and verify its complete pending-object
identity. A missing object is already absent. Any identity or durable-state
mismatch retains and rotates the job without deleting.

R2 currently has no conditional delete. HEAD plus DELETE is not atomic, so the
ownership check cannot prevent an out-of-band overwrite between those calls;
the exclusive-bucket/no-lifecycle-writer invariant above is therefore required.
If delete throws, a second exact HEAD distinguishes authoritative absence from a
retained object. SQL finalization rechecks durable ownership and predicates the
file-version update on exact path, application version, key, and
`cleanupPending`; otherwise the job remains. Failed jobs update `updated_at`, so
a stuck batch cannot indefinitely starve later cleanup.

## Sandbox lease state

Lease records are coordination metadata only. They contain a server-only
provider id and opaque provider handle, optional session id, expiry, cleanup
state (`none`, `requested`, `complete`), and optimistic lifecycle revision.
Statuses are provider-neutral: `pending`, `running`, `pausing`, `paused`,
`resuming`, `stopping`, `terminated`, `failed`, or `unknown`.

Updates enforce the transition graph and revision. Active states cannot be
written with an already-expired timestamp or `cleanupState: complete`.
`stopping/requested` and terminal/complete are valid progressions. Deletion is
allowed only from `terminated`/`failed` after cleanup is confirmed `complete`.
No provider call, credential, endpoint, browser token, or authority over actual
sandbox processes exists here.

## Browser and future sandbox flows

A browser flow is deliberately narrow:

1. authenticate through the deployment's verified boundary;
2. write/list credential metadata through the explicit credential routes;
3. request a short-lived, project/session/credential-scoped capability;
4. keep the one-time raw token in memory; and
5. call only the fixed broker route with that token.

The browser never calls a DO/R2 binding, sees ciphertext/plaintext after the
write request, receives provider headers/URLs, or selects an upstream route.

The future sandbox flow uses the same pattern: a trusted orchestration service
must verify tenant/user/project/session authority and request a narrowly scoped
capability, while the sandbox receives at most that short-lived capability for
the one fixed operation. It must not receive vault credentials, encryption or
HMAC keys, provider endpoints, `PROJECTS`, or `VAULTS`. The existing
provider-neutral sandbox lease records remain unchanged; the milestone-1
OpenSandbox adapter continues to own ephemeral lifecycle calls.

Non-goals remain billing, OAuth, generic provider proxying/selection, arbitrary
URL/header forwarding, endpoint delivery, automatic key re-encryption, full
production orchestration, cross-service atomicity, bucket-list orphan
discovery, deployment/resource creation, and UI wiring.

## Wrangler bindings and migration

`wrangler.jsonc` preserves migration `v1` for `ProjectDurableObject` and adds
migration `v2` with SQLite `VaultDurableObject`. `PROJECTS`, `VAULTS`, and `FILES`
are reflected in generated `worker-configuration.d.ts`. Secrets Store IDs are
not committed; production secret bindings are deployment-owned as described
above.
