# Sandbox Runtime Foundation

## Purpose and scope

This module owns OpenChamber's provider-neutral, server-only sandbox lifecycle
foundation. It can create and authoritatively inspect a bounded ephemeral
sandbox lease, resolve a private connection for a server-side consumer, and
destroy all leases owned by the runtime.

`packages/web/server/index.js` constructs the process-local runtime at the
beginning of `main()` and owns it until graceful shutdown. Disabled
configuration returns `null`; construction never probes the provider or causes
startup network activity. Shutdown attempts runtime disposal once, clears the
module reference even when disposal fails, and continues the rest of server
teardown with only a fixed warning.

This remains infrastructure below every client boundary. It has no HTTP routes,
browser `RuntimeAPIs`, UI, settings, CLI flags, package-root export, or client
bundle import. Composition does not make provider operations remotely callable.

## Files and ownership

- `index.js` and `index.d.ts`: server-only entrypoint and typed declarations.
- `types.d.ts`: provider, runtime, safe snapshot, connection, clock, logger,
  environment, and fetch contracts.
- `config.js`: provider selection and process-local capacity validation.
- `registry.js`: sealed provider registry, following the factory/registry style
  used by `packages/web/server/lib/tunnels/registry.js`.
- `factory.js`: disabled-by-default environment composition and the default
  provider factory.
- `runtime.js`: bounded in-memory lease lifecycle, authoritative inspection,
  and cleanup orchestration.
- `coordinator.js`: disabled, unwired lifecycle composition for local milestone-6
  acceptance with injected durable authority, snapshot, publication, runtime,
  and bridge contracts.
- `validation.js`: provider-neutral input and safe response validation.
- `errors.js`: stable sanitized error taxonomy.
- `providers/opensandbox.js`: all OpenSandbox-specific configuration, REST
  translation, authentication, response validation, and status mapping.

OpenSandbox protocol details must remain in its adapter/factory. Generic
registry and runtime code must not branch on OpenSandbox behavior.

## Configuration

Configuration is read only from the environment object injected into
`createSandboxRuntimeFromEnvironment`. Production callers may omit that option
to use `process.env`; tests and future composition code should inject it.

| Variable | Default | Validation and behavior |
| --- | --- | --- |
| `OPENCHAMBER_SANDBOX_PROVIDER` | Absent (disabled) | The only registered value is currently `opensandbox`. An absent variable returns `null` before registry, provider, or fetch construction. A present empty or unsupported value fails closed. |
| `OPENCHAMBER_SANDBOX_API_KEY` | None | Required when OpenSandbox is selected. It is sent only as the `OPEN-SANDBOX-API-KEY` request header. |
| `OPENCHAMBER_SANDBOX_CONTROL_PLANE_URL` | `http://localhost:8080/v1` | Optional explicit control-plane base URL. HTTPS is required except for loopback HTTP. User information, query parameters, and fragments are rejected. |
| `OPENCHAMBER_SANDBOX_REQUEST_TIMEOUT_MS` | `15000` | Integer from 100 through 120000. One deadline bounds fetch and response parsing through race settlement plus best-effort abort. |
| `OPENCHAMBER_SANDBOX_MAX_ACTIVE` | `8` | Integer from 1 through 64. Active leases, cleanup-pending leases, and in-flight creates consume capacity. |

Explicit enablement never falls back after invalid configuration. Errors use a
canonical message and code and do not include environment values, URLs, API
keys, provider response messages, or provider credentials.

## Provider contract

A registered provider is private to this server module and has a non-empty
`id` plus these operations:

```ts
create({ imageUri, entrypoint, resourceLimits, timeoutSeconds?, metadata? })
get(handle)
getEndpoint(handle, { port, useServerProxy?, expiresAt? })
destroy(handle)
```

`entrypoint` must contain at least one string. `resourceLimits` must be a
non-empty record whose values are strings. Optional `timeoutSeconds` is an
integer from 60 through 86400. `create` and `get` return allowlisted lifecycle
records only: handle, canonical status, valid ISO creation time, and a valid ISO
expiry or `null`. Status is one of `pending`, `running`, `pausing`, `paused`,
`resuming`, `stopping`, `terminated`, `failed`, or `unknown`. Provider payload
extras are discarded.
`getEndpoint` is the sole operation that returns a connection object containing
an endpoint URL and optional connection headers. The registry is sealed after
default provider construction.

The runtime exposes `create`, `get`, `getEndpoint`, `destroy`, `list`, and
`dispose`. `get` refreshes an owned lease from the provider and verifies that
the returned handle matches. A canonical provider not-found evicts the stale
local lease; malformed or mismatched responses retain it. `list` is deliberately
not an authoritative provider query: it returns the last create/get snapshot in
process memory and can be stale until `get` succeeds. Listings and operation
results never include provider configuration, create metadata, endpoint URLs,
connection headers, status reason/message fields, or API keys.

## OpenSandbox adapter

The adapter implements the verified OpenSandbox lifecycle API:

- `POST /sandboxes` sends exactly `{ image: { uri }, entrypoint,
  resourceLimits, timeout?, metadata? }`, requires HTTP 202, and allowlists
  lifecycle fields from the JSON response. It does not request persistent
  volumes.
- `GET /sandboxes/{id}` requires HTTP 200. Both create and get read the current
  structured `status.state`; known Alibaba OpenSandbox states map to the
  canonical lower-case union and any non-empty future state maps to `unknown`.
  Provider `status.reason` and `status.message` are intentionally omitted.
  Provider responses that omit `expiresAt` normalize it to `null`, which is
  valid for manually cleaned-up sandboxes.
- `GET /sandboxes/{id}/endpoints/{port}` translates `useServerProxy` to
  `use_server_proxy`, converts optional absolute ISO `expiresAt` to floored Unix
  epoch seconds in `expires`, requires the translated expiry to be in the future
  according to the injected clock, requires port 1 through 65535, and validates
  the returned endpoint and string-valued headers. `expiresAt` cannot be combined
  with `useServerProxy: true` because the provider API forbids that combination.
- `DELETE /sandboxes/{id}` requires HTTP 204. The response acknowledges
  asynchronous provider cleanup; OpenChamber does not poll or invent a second
  provider lifecycle.

If a successful create response cannot produce a safe lifecycle record but does
contain a syntactically valid sandbox handle, the adapter treats it as a known
partial allocation and makes one bounded best-effort DELETE. Cleanup failure
does not replace the original `SANDBOX_RESPONSE_INVALID`. Without a valid
handle, no safe cleanup target exists and provider-side lifecycle TTL remains
the fallback. Provider adapters are responsible for equivalent compensation
when their create protocol can expose a known partial allocation.

Every request carries the API key only in `OPEN-SANDBOX-API-KEY` and uses
`redirect: 'error'`, so the custom credential header cannot be forwarded through
an HTTP redirect. Live discovery and startup probes are not performed. Alibaba
Function Compute AgentRun is a different product and is not implemented by this
adapter.

## Trust boundary and secret handling

The module is below the browser/runtime API boundary. There are no routes or
shared UI contracts, and `packages/web/server/index.d.ts` does not re-export it.
Only trusted server-side code may receive a connection from `getEndpoint`.

Endpoint URLs and connection headers are returned for the immediate call only.
They are not copied into lease state, snapshots, listings, errors, or logs.
Sandbox create input, metadata, files, resource limits, control-plane URLs, API
keys, and provider credentials are never persisted. The runtime logs only a
stable error code when cleanup remains pending; it never logs raw provider
errors or responses.

Provider error bodies are untrusted. Their `{ code, message }` values are not
forwarded. Unknown thrown values and abort reasons are replaced by canonical
`SandboxRuntimeError` instances without a raw cause.

## Lifecycle and cleanup

1. `create` validates and normalizes input, reserves capacity before awaiting
   the provider, then stores only the returned safe lifecycle record in memory.
   Provider adapters compensate known partial allocations before returning an
   invalid-response failure; no malformed record is registered as a lease.
2. `get` requires a locally owned lease, fetches current provider state, checks
   the returned handle, and updates the local snapshot. Canonical not-found is
   authoritative absence and evicts the lease; other failures preserve it.
3. `getEndpoint` requires an active owned lease. It validates the provider
   connection and returns it without caching it. Endpoint resolution is blocked
   for cleanup-pending or destroying leases.
4. `destroy` deduplicates concurrent calls for a lease. HTTP 204 removes the
   lease. Provider not-found is also treated as completed cleanup because the
   resource is already absent.
5. Any other destroy failure retains the lease as `cleanupPending`, consumes
   capacity, emits only a sanitized warning, and can be retried by `destroy`.
6. `dispose` immediately prevents new creates, inspections, and endpoint
   resolutions, waits for creates that were already in flight, then attempts every resulting
   active and cleanup-pending lease with `Promise.allSettled`. Successful leases
   are removed. Failures remain retryable in memory and are aggregated as
   code-only summaries in `SANDBOX_DISPOSE_FAILED`. Calling `dispose` again
   retries the remaining leases.

## Timeout, TTL, and renewal semantics

Three independent time values must not be conflated:

- `OPENCHAMBER_SANDBOX_REQUEST_TIMEOUT_MS` bounds one control-plane fetch and
  body parse with one race-settled deadline, including when injected fetch or
  parser promises ignore `AbortSignal`. Its injected timer is always cleared,
  abort is best effort, and timeout maps to `SANDBOX_REQUEST_TIMEOUT`.
- Create `timeoutSeconds` is forwarded as OpenSandbox `timeout` and acts as the
  provider lifecycle TTL. The current API bounds it to 60 through 86400 seconds,
  but does not give OpenChamber a sufficiently precise lifecycle anchor to
  derive an expiry when the response omits `expiresAt`. OpenChamber therefore
  preserves provider expiry as `null` instead of guessing whether TTL began at
  request acceptance, provisioning, or running state.
- Endpoint `expiresAt` is an absolute caller-supplied ISO time translated to
  floored epoch seconds. It controls the endpoint credential/URL, not sandbox
  lifetime.

Lease or endpoint renewal is intentionally deferred. There is no hidden retry,
automatic TTL extension, or synthesized expiry. A future renew operation needs
an explicit provider-neutral contract and ownership policy.

## Durable versus ephemeral state

Runtime ownership is deliberately ephemeral and process-local. Lease state and
cleanup-pending state exist only in memory for the lifetime of the owning
runtime. No database, settings file, object storage, credential vault, Durable
Object, or other external state is used.

OpenChamber requests no persistent volumes from OpenSandbox. Files written to a
sandbox root filesystem live only according to that provider sandbox's
lifetime; this foundation does not claim stronger durability or persistence
across sandbox termination.

The provider may keep a sandbox alive after an OpenChamber crash or forced
process termination because no local durable lease record exists to reconcile
after restart. Provider-side sandbox timeout is therefore part of the safety
boundary, not a substitute for normal `destroy`/`dispose`. This foundation does
not claim durable execution, crash recovery, billing reconciliation, or orphan
discovery.

During graceful shutdown, OpenChamber attempts every locally owned lease. A
failed provider cleanup cannot block terminal, OpenCode, HTTP server, auth, or
tunnel teardown. The runtime retains failed leases only while the process still
exists, and shutdown logs no raw provider error. Forced termination and startup
failure before graceful cleanup still rely on provider TTL because this layer
has no durable recovery record.

## Failure taxonomy

| Code | Meaning |
| --- | --- |
| `SANDBOX_CONFIGURATION_INVALID` | Explicit configuration is missing, malformed, or outside a bound. |
| `SANDBOX_PROVIDER_UNSUPPORTED` | The selected provider is not registered. |
| `SANDBOX_VALIDATION_FAILED` | Local input validation failed or OpenSandbox returned HTTP 400. |
| `SANDBOX_CAPACITY_EXCEEDED` | The process-local active/in-flight lease limit was reached. |
| `SANDBOX_AUTHENTICATION_FAILED` | OpenSandbox returned HTTP 401 or 403. |
| `SANDBOX_NOT_FOUND` | OpenSandbox returned HTTP 404 or an owned handle is absent. |
| `SANDBOX_CONFLICT` | OpenSandbox returned HTTP 409 or local cleanup is already in progress/pending. |
| `SANDBOX_PROVIDER_FAILURE` | Network failure, HTTP 5xx, or another provider failure occurred. |
| `SANDBOX_REQUEST_TIMEOUT` | The bounded provider request was aborted by its timeout. |
| `SANDBOX_RESPONSE_INVALID` | JSON, expected success status, lifecycle fields, endpoint, or headers were malformed. |
| `SANDBOX_RUNTIME_DISPOSING` | A create, inspection, or endpoint request arrived after disposal began. |
| `SANDBOX_DISPOSE_FAILED` | Disposal attempted every lease but one or more sanitized failures remain. |

Unexpected non-success statuses map to `SANDBOX_PROVIDER_FAILURE`; unexpected
2xx statuses map to `SANDBOX_RESPONSE_INVALID` because the adapter requires the
documented lifecycle status for each operation.

## Roadmap boundaries

Provider additions should implement the same private operation descriptor and
register through the factory. A future durable design may use a Cloudflare
Durable Object for serialized lease ownership, R2 for durable state or artifacts,
and provider reconciliation after restart. That DO/R2/provider architecture is
a roadmap boundary, not behavior implemented or implied by this process-local
runtime.

Routes, browser exposure, UI/settings, CLI flags, durable lease persistence,
credential vaults, billing, migrations, provider deployment, Hetzner tooling,
Cloudflare Durable Objects/R2, renew operations, and crash-recovery
reconciliation are not part of this foundation. Each requires a separate trust,
lifecycle, and runtime parity design before implementation.

## Validation

The focused tests use injected fetches, clocks, loggers, environments, and mock
providers only. They cover disabled construction, configuration validation,
request translation, API-key placement, lifecycle behavior, timeout aborts,
ignored-abort deadline settlement, structured status/error mapping, timestamp
and endpoint expiry validation, malformed-create compensation, authoritative
inspection, malformed responses, bounded capacity, cleanup retry, aggregate
disposal, shutdown continuation, and secret exclusion from safe values, logs,
and errors.

## Sandbox Bridge (milestone 5)

### Ownership and purpose

The bridge module (`bridge.js`) is a provider-neutral, server-only effect
executor that operates on already-created sandbox leases. It is disabled by
default and requires a separate configuration gate independent from general
sandbox enablement. The bridge is called only after a trusted claim/begin-effect
sequence from the control plane; it never performs claim validation or durable
recovery itself. The Project Durable Object is the sole durable authority.

Every effect-bearing bridge input carries trusted claim fields:
`leaseId`, `generation`, `operationId`, `claimFence`, and `providerHandle`.
Provider methods use only `providerHandle`; `leaseId` is never passed as a
provider handle. The bridge does not track generations locally; durable
claim/begin/complete fencing is authoritative.

The bridge exposes:

- **Lifecycle dispatch**: pause, resume, and destroy against a provider handle.
- **Authoritative file hydration**: validates the complete snapshot, cleans and
  recreates the fixed workspace root, writes all directories and files, and
  writes the hydration marker last only after every write succeeds. Any failure
  means no success marker and a `SANDBOX_BRIDGE_HYDRATION_FAILED` error.
- **Checkpoint**: traverses the fixed workspace one directory level at a time,
  validates every entry, rejects symlinks and malformed traversal results,
  enforces per-file/count/aggregate UTF-8 byte bounds, and fails on any
  list/read/validation error. Never substitutes empty content. Returns a
  complete deterministic sorted snapshot and base revision.
- **OpenCode process supervision**: starts `opencode serve` as a background
  command with a random process-local password in `OPENCODE_SERVER_PASSWORD`
  env var, resolves the provider endpoint on port 13009, and polls
  `/global/health` with Basic auth for readiness. Supports stop with credential
  cleanup.

### Configuration gates

The bridge is controlled by environment variables:

| Variable | Default | Behavior |
| --- | --- | --- |
| `OPENCHAMBER_SANDBOX_BRIDGE_ENABLED` | Absent (disabled) | `"true"` enables the bridge. `"false"` disables. Any other value throws `SANDBOX_CONFIGURATION_INVALID`. |
| `OPENCHAMBER_SANDBOX_BRIDGE_REAL_CREATE` | Absent (disabled) | `"true"` enables real-create support. The current OpenSandbox adapter sets `supportsRealCreate: false` regardless. Setting this to `"true"` with OpenSandbox fails startup. |
| `OPENCHAMBER_SANDBOX_BRIDGE_OPENCODE_PORT` | `13009` | Integer 1-65535. |

The OpenCode config directory is fixed at
`/workspace/project/.opencode-runtime`; it is not configurable from the
environment or any request.

The bridge gate is independent from `OPENCHAMBER_SANDBOX_PROVIDER`. A provider
configured without the bridge gate returns `null` for the bridge and does not
expose bridge capabilities. Malformed boolean values throw a sanitized
configuration error, never silently disable.

### Real-create safety gate

The current OpenSandbox adapter (`providers/opensandbox.js`) exposes
`supportsRealCreate: false`. The bridge constructor rejects when
`bridgeConfig.realCreateSupported` is `false` and the provider's
`supportsRealCreate` is `true` (an inconsistent state). Real OpenSandbox create
has no documented idempotency key; until deterministic create lookup or
idempotency is proven by the provider adapter, real create must remain
hard-disabled. The `OPENCHAMBER_SANDBOX_BRIDGE_REAL_CREATE` env var provides a
separate safety gate that cannot become `true` for the current OpenSandbox
adapter.

### Claim field validation

Every bridge input is validated as an exact object (extra keys rejected).
Claim fields are:

- `leaseId`: URL-safe string, 8-128 characters.
- `generation`: positive safe integer.
- `operationId`: URL-safe string, 8-128 characters.
- `claimFence`: positive safe integer.
- `providerHandle`: non-empty string, max 1024 characters, no control characters.
- `kind`: exact enum (`hydrate`, `checkpoint`, `pause`, `resume`, `destroy`, `openCodeStart`, `openCodeStop`).

### Provider contract extensions

The bridge requires the following optional provider capabilities beyond the base
`SandboxProvider` contract. Each capability is checked at construction; a
missing capability causes `SANDBOX_BRIDGE_OPERATION_INVALID` when the
corresponding bridge operation is invoked.

**Lifecycle** (`provider.lifecycle`):
- `pause(handle)` → `SandboxProviderRecord`
- `resume(handle)` → `SandboxProviderRecord`

**Command** (`provider.command`):
- `runBackground(handle, { command, cwd?, envs?, timeout? })` → `BridgeSSECommandResult`
- `commandStatus(handle, commandId)` → `BridgeCommandResult`
- `commandLog(handle, commandId, cursor?)` → `BridgeCommandOutput`
- `interruptCommand(handle, commandId)` → `void`

**Files** (`provider.files`):
- `searchFiles(handle, path, pattern)` → `BridgeFileRecord[]`
- `uploadFile(handle, path, content: Buffer)` → `void`
- `downloadFile(handle, path)` → `Buffer`
- `deleteFile(handle, path)` → `void`

**Directories** (`provider.directories`):
- `listDirectory(handle, path, depth)` → `{ path, type }[]`
- `createDirectory(handle, path)` → `void`
- `deleteDirectory(handle, path)` → `void`

**Execd** (`provider.execd`):
- `getExecdEndpoint(handle)` → `SandboxEndpointConnection`

### OpenSandbox bridge adapter

The OpenSandbox adapter (`providers/opensandbox.js`) implements all bridge
capabilities:

- **Lifecycle**: `POST /sandboxes/{id}/pause` and `/resume` with standard API
  key auth and redirect rejection.
- **Execd**: resolves endpoint on port 44772 and uses transient
  `X-EXECD-ACCESS-TOKEN` header for all subsequent execd requests. Execd
  requests never carry the `OPEN-SANDBOX-API-KEY` header.
- **Command**: `POST /command` with `{ command, cwd?, background?, timeout?, uid?, gid?, envs? }`
  and `Accept: text/event-stream`. Bounded SSE parsing extracts the command ID
  and terminal event. Status via `GET /command/status/{id}` (JSON). Logs via
  `GET /command/{id}/logs?cursor=...` (text/plain) with bounded
  `EXECD-COMMANDS-TAIL-CURSOR` response header. Interrupt via
  `DELETE /command?id=...`.
- **Files**: `GET /files/search?path=...&pattern=...`, `POST /files/upload`
  (multipart with metadata JSON + binary file), `GET /files/download?path=...`,
  `DELETE /files?path=...`. All paths normalized to
  `/workspace/project/{relativePath}`.
- **Directories**: `GET /directories/list?path=...&depth=...`,
  `POST /directories`, `DELETE /directories?path=...` (recursive). Directory
  listing metadata rejects symlinks and non-regular entries.

### Workspace and file safety

- Fixed workspace root: `/workspace/project`.
- Relative paths are normalized (leading `./` stripped, `.` rejected).
- Absolute paths, traversal (`../`), backslashes, and control characters
  (0x00-0x1f, 0x7f) are rejected before any provider call.
- File content size limit: 1 MiB per file.
- File count limit: 8192 entries per snapshot/list.
- Workspace traversal limit: 16384 total file and directory entries.
- File path length limit: 4096 characters.
- Aggregate hydration byte limit: 64 MiB.
- Aggregate checkpoint byte limit: 256 MiB.

### Hydration and checkpoint

**Hydration** is all-or-fail. The complete snapshot is validated first (exact
objects, normalized relative paths, file-count and aggregate UTF-8 byte bounds).
Before deletion, the existing fixed workspace is enumerated one level at a time
with bounded entry and path depth. Every returned path must be a unique direct
child of the directory queried; nested symlinks, malformed entries, duplicates,
and descendants beyond the depth bound fail closed. Only after enumeration
proves completeness is the fixed workspace root cleaned and recreated using
directory APIs. All directories are created, all files are written, and the
hydration marker is written last only after every write succeeds. Any failure
means no success marker and a `SANDBOX_BRIDGE_HYDRATION_FAILED` error.

**Checkpoint** is all-or-fail. The fixed workspace is enumerated one directory
level at a time so traversal can prove completeness rather than trusting a
depth-limited aggregate response. Directories are traversed as structure;
symlinks, malformed/non-immediate entries, duplicates, entry-count overflow,
and descendants beyond the depth bound fail closed. Internal marker/config
artifacts owned by the bridge are excluded from the returned files. Per-file,
file-count, and aggregate UTF-8 byte bounds are enforced. Any list/read/
validation failure causes `SANDBOX_BRIDGE_CHECKPOINT_FAILED`. Empty content is
never substituted. Returns a complete deterministic sorted snapshot and base
revision/fingerprint only; does not publish durable data.

### OpenCode process supervision

OpenCode is started as a background command with:

```
opencode serve --hostname 127.0.0.1 --port 13009
```

The password is passed only through the `OPENCODE_SERVER_PASSWORD` environment
variable (matching the web lifecycle and VS Code conventions). The username
defaults to `opencode` via `OPENCODE_SERVER_USERNAME`. The config directory is
set via `OPENCODE_CONFIG_DIR`. The working directory is `/workspace/project`
set via the execd `cwd` field. No `--password`, `--username`, `--cwd`, or
`--config-dir` CLI flags are used.

The password is generated with `crypto.randomBytes(32).toString('base64url')`
and stored only in bridge memory keyed by `leaseId::generation`. It is never
persisted, returned to public callers, or included in operation results.

Readiness is probed via `GET /global/health` through the provider endpoint
resolved with `provider.getEndpoint(providerHandle, { port: 13009, useServerProxy: true })`,
using the endpoint-supplied transient headers plus Basic auth
(`opencode:<password>`). Each readiness fetch has its own composed abort
deadline (caller signal + remaining polling deadline); a hung fetch cannot
hang forever. The probe polls at 500ms intervals with a 30-second overall
timeout. Health response must be bounded JSON (max 4096 bytes) with
`healthy === true` and a non-empty `version` string. Redirects and
malformed/oversized responses are rejected.

**Supervision record**: `openCodeStart` returns an internal supervision record
containing `commandId`, `providerHandle`, `generation`, `port`, and `username`.
This record carries no password, access token, or transient endpoint headers.
It is the trusted durable identity for the launched OpenCode process and is
required by `openCodeStop` and `openCodeReconcile`.

**Stop**: `openCodeStop` accepts the supervision record, validates that
`providerHandle` and `generation` match the claim input, interrupts the exact
command, and clears credentials. Provider not-found is treated as already
absent.

**Reconcile**: `openCodeReconcile` accepts the supervision record and queries
the provider command status. If bridge credentials are missing (process
restart), it returns `status: 'unavailable'` — never guesses auth or
duplicates a start. If the provider reports the command not found, it also
returns `'unavailable'`. Otherwise it returns the provider's canonical status
and exit code.

**Startup failure cleanup**: Any failure after command acceptance (endpoint
resolution failure, readiness timeout, caller abort) clears credentials and
best-effort interrupts the exact command without masking the primary error.
The primary error (timeout, provider failure, etc.) is always preserved.

### Credential management

Runtime credentials (OpenCode username/password/port) are stored in bridge
memory keyed by `leaseId::generation`. They are cleared on:
- `openCodeStop`
- `destroy`
- `openCodeStart` failure or timeout
- `dispose`

Credentials are never persisted, logged, serialized into operation results, or
returned to public callers. The supervision record carries no secrets.

### Failure taxonomy additions

| Code | Meaning |
| --- | --- |
| `SANDBOX_BRIDGE_DISABLED` | Bridge is not enabled in configuration. |
| `SANDBOX_BRIDGE_REAL_CREATE_UNSUPPORTED` | Provider does not support real create. |
| `SANDBOX_BRIDGE_OPERATION_INVALID` | Bridge operation input is invalid or capability is missing. |
| `SANDBOX_BRIDGE_FILE_INVALID` | File path is invalid or rejected (absolute, traversal, backslash, control chars). |
| `SANDBOX_BRIDGE_HYDRATION_FAILED` | File hydration failed (any write, directory, or validation error). |
| `SANDBOX_BRIDGE_CHECKPOINT_FAILED` | File checkpoint failed (any list, read, or validation error). |
| `SANDBOX_BRIDGE_COMMAND_FAILED` | Command execution in sandbox failed. |
| `SANDBOX_BRIDGE_OPENCODE_FAILED` | OpenCode failed to start or become ready within the timeout. |

### Factory and exports

`createSandboxBridgeFromEnvironment(options)` composes the bridge using the
private provider registry/factory pattern. It reads bridge config from the
environment, resolves the sandbox provider, and returns a `SandboxBridge` or
`null` when disabled. It does not perform startup I/O or register server routes.

The bridge factory, `createSandboxBridge`, and error codes are exported from
`packages/web/server/lib/sandbox/index.js`.

### Limitations and roadmap

- The bridge is a trusted effect executor only. It does not perform claim
  validation, durable recovery, or crash-recovery reconciliation.
- Provider idempotency for real create must be proven before
  `OPENCHAMBER_SANDBOX_BRIDGE_REAL_CREATE` can be enabled for any provider.
- Lease renewal, automatic TTL extension, and endpoint expiration management are
  not implemented.
- The bridge does not expose provider handles, endpoint headers, passwords, or
  bridge credentials. The final BFF must respect these boundaries.

## Lifecycle coordinator (milestone 6, disabled acceptance only)

### Scope and non-wiring

`coordinator.js` composes the production-shaped lifecycle sequence for focused
Node acceptance tests. It is deliberately not imported by `index.js`,
`factory.js`, the server entrypoint, or any BFF route. The production
`sandboxRuntimeEnabled` gate remains `false`; adding this module does not expose
a capability, start a dispatcher, contact a control plane, or enable real
OpenSandbox create. The current OpenSandbox adapter still has
`supportsRealCreate: false`.

The coordinator is constructed per project with injected dependencies. Its
authority client is already project-scoped; no project ID, authority map, or
global singleton is created here. `operationId` is only correlation within that
project-scoped coordinator and is not treated as globally unique. The Node
module does not import the workerd Durable Object implementation. A private
production authority transport remains deferred.

The injected contracts are:

- `authority.claimSandboxRuntimeOperation`,
  `authority.beginSandboxRuntimeEffect`, and
  `authority.completeSandboxRuntimeOperation`, preserving the Project DO's
  exact operation/generation/revision/claim-fence sequence;
- process-local `runtime.create`, `runtime.list`, and `runtime.destroy`;
- the real bridge operations for hydration, checkpoint capture, lifecycle, and
  exact OpenCode supervision;
- `snapshotSource.read`, which must return `{ complete: true, revision, files }`;
- `checkpointPublisher.publish`, which atomically and idempotently publishes by
  `operationId` and `expectedWorkspaceRevision` and confirms with
  `{ published: true }`; and
- a fixed sandbox create input (or an injected resolver evaluated during start
  preflight).

All dependencies are injected fakes in acceptance tests. The fake authoritative
snapshot is quiescent while read; these tests do not prove a production
concurrent-edit snapshot protocol. Before cloning or retaining entries,
coordinator preflight requires the exact complete snapshot shape, a valid
revision, at most 8192 files, at most 1 MiB of UTF-8 content per file, and at
most 64 MiB of aggregate UTF-8 content. Path normalization and traversal
rejection remain the real bridge's final authority rather than a second
coordinator implementation.

### Fencing and dispatch

Every accepted operation follows claim, optional preflight, begin, one lifecycle
effect, then completion. A provider mutation is never run before a successful
begin response for the same operation, target generation, lifecycle revision,
and claim fence. Claim and begin are not retried. A rejected replay/no-op claim
is ignored without dispatch; an unconfirmed claim or begin is left for the
Project DO's existing stale-claim recovery. The coordinator never infers that a
provider effect may be repeated.

Completion transport ambiguity is the only retried authority call. Every retry
uses a parsed copy of one pre-serialized, byte-identical completion payload until
the completion deadline. It never changes `outcome`, provider identity, or
supervision and never repeats the provider effect.

### Bounded scheduler and deadlines

Each coordinator instance owns one FIFO scheduler. Construction requires
`maxConcurrent`, `maxQueued`, `operationDeadlineMs`, and
`completionTimeoutMs`. Queued and running duplicates of one operation ID share
one Promise flight. Queue overflow returns fixed backpressure before claim, so
an at-least-once caller must redeliver the same operation ID; no new operation
ID should be invented for scheduler pressure.

`operationDeadlineMs + completionTimeoutMs` must be strictly less than the
Project DO's 30-second stale-effect recovery boundary. The operation deadline
is stage-aware: expiry before begin performs no provider mutation, while expiry
after begin is completed according to whether absence/failure is known or the
mutation may have committed. A provider call that ignores abort and settles
late keeps its concurrency slot until it settles. This intentionally trades one
bounded stuck slot for no detached, unbounded provider work.

The coordinator has no production heartbeat. Heartbeat/lease extension, a
durable dispatcher, and cross-process scheduler ownership remain deferred.
Every bridge operation receives the operation deadline signal, including remote
destroy. Existing process-local runtime methods do not accept caller signals and
are not widened by this milestone. Production therefore remains blocked: the
configured provider request timeout must fit inside the coordinator operation
deadline until runtime/provider calls have a cancellable or heartbeat-backed
production design.

### Lifecycle effects

- **Start (`ensure` or explicit `replace`)**: claim; read and validate a complete
  authoritative snapshot before begin; begin; call `runtime.create` exactly
  once; hydrate; start OpenCode with bridge-owned process-local credentials; and
  complete with the provider record plus supervision. Create is never retried.
  Any post-create failure attempts confirmed runtime destroy/not-found. Confirmed
  absence completes `failed`; otherwise the known handle is included only in an
  `outcomeUnknown` completion so the Project DO can record durable orphan work.
- **Pause**: claim and begin; stop the exact supervised OpenCode command when a
  tuple exists; call bridge pause; require the normalized matching provider
  response to be paused; and complete with provider and supervision both null.
- **Resume**: claim and begin; call bridge resume; require a normalized matching
  running response and a null or future expiry; start OpenCode with new
  process-local credentials; and complete with the adopted provider identity,
  refreshed expiry, and new supervision. Resume performs no hidden hydration.
- **Destroy**: claim and begin; attempt exact OpenCode stop but attempt sandbox
  destruction even if stop fails. A locally owned handle uses `runtime.destroy`;
  only local `SANDBOX_NOT_FOUND` falls back to bridge destroy. A non-local handle
  uses bridge destroy with the operation deadline signal. Success requires
  authoritative destroyed/not-found.
- **Checkpoint**: claim and begin; capture one bounded complete bridge snapshot;
  atomically/idempotently publish it using the operation ID and expected
  workspace revision; then complete. Capture failure and explicit CAS rejection
  are `failed`; publication timeout, transport ambiguity, or malformed success
  are `outcomeUnknown`.

Pause and destroy never checkpoint implicitly. Product policy must reserve and
await an explicit checkpoint operation before pause or destroy whenever the
workspace must be preserved. Redelivery reuses the same checkpoint operation ID
and relies on the publisher's idempotent key and expected-revision CAS.

### Failure classification and diagnostics

`failed` is used only when the target's absence or failure is known.
`outcomeUnknown` is used when a mutating provider call or checkpoint publication
may have committed, including operation deadline, abort, network/5xx,
malformed-success, or completion-transport ambiguity. A late start handle is
never adopted locally after ambiguity; it is carried only to durable orphan
recording.

Diagnostics are optional and failure-isolated. Events contain exactly:

```js
{
  type: 'sandbox.lifecycle',
  operationId,
  phase,
  effect,
  outcome,
  code,
}
```

The diagnostic contract is exact. `phase` is `queued`, `claimed`, `begun`,
`effect`, or `completion`. `effect` is `null`, `start`, `stop`, `resume`,
`destroy`, or `checkpoint`. `outcome` is `null`, `succeeded`, `failed`,
`outcomeUnknown`, `backpressured`, or `ignored`. `code` is `null` or a value
from the fixed safe coordinator, sandbox, or control-plane code allowlist. The
internal dispatch result remains `outcome: 'backpressure'`, while its diagnostic
uses `outcome: 'backpressured'`. An accepted queue/progress/success event uses
null outcome or code where no failure exists. Any event outside these enums is
discarded. Raw errors, stacks, statuses, provider IDs, handles, URLs, commands,
paths, snapshots, file content, credentials, and supervision are never included.

Bridge pause and resume now normalize provider lifecycle records and reject a
returned handle that differs from the trusted claim handle. Resume exposes only
the normalized status and expiry needed by the coordinator; provider extras are
discarded. The declarations expose exact `BridgePauseInput`/
`BridgePauseResult` and `BridgeResumeInput`/`BridgeResumeResult` contracts;
resume alone contains `expiresAt: string | null`. Compatibility lifecycle names
remain unions of those exact contracts. This correction remains inside the
disabled bridge/coordinator boundary.

Production orphan execution is not implemented here. The Project DO's durable
orphan jobs are only recorded through fenced completion; a private trusted
orphan executor, provider reconciliation, production heartbeat, private
authority transport, and production rollout remain future milestones.
