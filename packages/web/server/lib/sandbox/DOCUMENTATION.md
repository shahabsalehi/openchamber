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
