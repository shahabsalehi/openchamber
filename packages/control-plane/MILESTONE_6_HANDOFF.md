# Durable Web Workspace Milestone 6 Handoff

## Status and safety boundary

Milestone 6 is a pre-deployment software acceptance gate. It does not deploy a
Worker, create Cloudflare resources, contact OpenSandbox, configure Hetzner, or
enable the hosted sandbox-runtime capability.

The following production safeguards remain in force:

- the control-plane Worker default export is reject-all unless a deployment
  composition injects verified authenticators and key rings;
- `OPENCHAMBER_CONTROL_PLANE_URL` is absent by default, so the hosted web BFF is
  not registered and no control-plane descriptor is injected;
- production passes `sandboxRuntimeEnabled: false`, so sandbox-runtime BFF
  routes and the `sandboxRuntimeV2` descriptor are absent;
- `coordinator.js` is not imported by `index.js`, `factory.js`, the web server,
  or a route; and
- the OpenSandbox adapter reports `supportsRealCreate: false`; real create is
  gated behind a provider-neutral deterministic reconciliation contract that
  never retries create after ambiguity.

Do not weaken any of these gates as part of infrastructure handoff. Production
enablement requires every deferred item below to pass independently.

## Reproducible local acceptance gate

From the repository root, run:

```bash
bun run test:web-v2:acceptance
```

The command is intentionally split across runtimes. Durable Object and R2 tests
run in workerd; server orchestration and transport tests run in Node; UI state
tests run with Bun. No Node sandbox module is imported into workerd, and no fake
Durable Object is made authoritative in the server package.

| Acceptance evidence | Production-shaped local proof |
| --- | --- |
| Verified project create, replay, isolation, files, sessions, hydration source, and failure-is-not-empty behavior | All tests in `packages/control-plane/test`, especially `verified-workspace.test.ts` |
| Credential encryption, capability expiry/revoke/use limits, broker bounds, identity, and cross-tenant rejection | `vault.test.ts`, `capability.test.ts`, `provider-broker.test.ts`, `broker-handler.test.ts`, `identity.test.ts`, and `milestone3-handler.test.ts` |
| Durable runtime reserve, claim, begin-once, exact completion, pause/resume/checkpoint/destroy/replace, stale fencing, orphan recording, and alarm recovery | `sandbox-runtime.test.ts` in workerd |
| Disabled-by-default BFF, same-origin-before-auth, Access assertion bounds, named routes only, response bounds, and redacted errors | `control-plane/{config,client,routes}.test.js` |
| OpenSandbox async 202 lifecycle polling, finite TTL, bounded metadata listing/pagination, deny-by-default egress, endpoint header preservation, and disabled real-create gate | `sandbox/{factory,runtime,providers/opensandbox}.test.js` |
| Complete fake start -> checkpoint -> pause -> resume -> destroy flow, deterministic metadata reconciliation after ambiguous create (zero/one/terminal/unresolved/multiple), canonical orphanProviders, bounded queue, deadlines, quota preflight, deterministic publication, and safe diagnostics | `sandbox/coordinator.test.js` |
| Authoritative hydration/checkpoint path rules, no partial snapshot success, in-sandbox `opencode serve` startup and authenticated health probe, reconciliation, and credential cleanup | `sandbox/bridge.test.js` |
| Scoped URL authentication for terminal and preview, authenticated realtime proxying, preview SSRF/token isolation, and terminal WebSocket protocol/runtime | `ui-auth.test.js`, `preview/proxy-runtime.test.js`, `realtime-proxy.test.js`, and `terminal/{runtime,terminal-ws-protocol}.test.js` |
| Session activity contract and actionable starting/ready/stopping/recovering/failed/retryable UI states while readiness remains disabled | `opencode/session-runtime.test.js` and `WebV2WorkspaceView.test.tsx` |

The fake provider, filesystem, endpoint, OpenCode process, clock, key material,
and Access identity are injected. The gate requires no login, API key, account,
network service, or real credential. A passing local gate demonstrates contract
composition and failure semantics; it does not demonstrate deployed latency,
provider behavior, or infrastructure availability.

## Authority, concurrency, and recovery invariants

- One catalog Durable Object exists per verified tenant/user, one project
  Durable Object per tenant/project, and one vault Durable Object per
  tenant/user. There is no global lifecycle coordinator.
- Project SQLite remains metadata and lifecycle authority. R2 owns immutable
  bytes only. Sandboxes are replaceable compute and process-local runtime state
  is never used as durable truth.
- Lifecycle delivery is at least once. Duplicate operation IDs coalesce locally;
  durable claim/begin fencing prevents repeated provider effects. Completion
  transport ambiguity retries only the identical serialized completion.
- Queue overflow returns backpressure before claim. Redelivery must use the same
  operation ID. A timed-out provider call keeps its bounded slot until it
  settles; detached unbounded work is forbidden.
- `operationDeadlineMs + completionTimeoutMs` must remain below the Project DO's
  30-second stale-effect recovery boundary until a production heartbeat/lease
  extension exists.
- Create is called once after durable begin. Ambiguous create is never retried;
  recovery requires explicit replacement. Failed, late, or stale handles become
  durable orphan-cleanup work and are never silently adopted.
- Checkpoint publication must be atomic and idempotent by operation ID with an
  expected-workspace-revision compare-and-swap. Pause and destroy do not create
  hidden checkpoints.

Current local limits are deliberately finite: 1-64 active process-local
sandboxes, 8192 files, 1 MiB per file, 64 MiB hydration, 256 MiB checkpoint,
4096-byte paths, 16384 traversal entries, provider request timeout 100-120000
ms, and coordinator queue/concurrency/deadline values supplied explicitly at
construction. Deployment values must be chosen below provider and platform
limits, then exercised by deferred load and chaos tests.

## Diagnostics and operator interpretation

Lifecycle diagnostics contain exactly these fields:

```json
{
  "type": "sandbox.lifecycle",
  "operationId": "opaque-operation-id",
  "phase": "queued|claimed|begun|effect|completion",
  "effect": "start|stop|resume|destroy|checkpoint|null",
  "outcome": "succeeded|failed|outcomeUnknown|backpressured|ignored|null",
  "code": "SAFE_ALLOWLISTED_CODE|null"
}
```

Use the project-scoped operation ID to correlate BFF reservation, durable
claim/begin/completion, sandbox effect, and recovery. Do not add tenant/user
identity, provider IDs or handles, URLs, headers, commands, file paths or
content, snapshots, capabilities, Access assertions, credentials, supervision,
raw errors, or stacks. A diagnostic sink must be optional and failure-isolated.

Operator response:

- `backpressured`: retry the same operation ID after bounded delay; do not claim
  or create a replacement operation.
- `ignored`: authority rejected a replay/no-op before effect; refresh durable
  status before taking action.
- `failed`: the effect is confirmed absent/rejected or checkpoint publication
  was rejected before commit; present the fixed recovery action from status.
- `outcomeUnknown`: do not repeat a mutating effect. Let durable recovery fence
  the operation; for create, use only an explicit replacement operation after
  reconciliation.
- stale `claimed`: the Project DO alarm can return it to reserved for retry.
- stale `effectStarted`: recovery marks it outcome-unknown and never redispatches
  the effect.

No deployment health endpoint is defined by this milestone. The future private
deployment must distinguish these checks instead of collapsing them into one
green response:

1. Worker process and binding reachability without exposing binding names or
   secret state;
2. verified Access authentication and catalog/project/vault scope isolation;
3. exact R2 write/read/checksum/delete recovery against the exclusive bucket;
4. private dispatcher heartbeat and queue saturation;
5. provider create/get/destroy and orphan-cleanup reconciliation; and
6. in-sandbox OpenCode authenticated health through the private endpoint.

Failure of checks 3-6 must never be reported as an authoritative empty project,
file list, or runtime state.

## Deployment inventory for the Cloudflare/Hetzner handoff

The Cloudflare deployment overlay must provide, without committing values:

- SQLite Durable Object bindings `CATALOGS`, `PROJECTS`, and `VAULTS`, preserving
  migration tags `v1` through `v3`;
- an exclusively owned R2 `FILES` bucket with no external writers or lifecycle
  deletion rules;
- verified Cloudflare Access issuer, audience, JWKS resolution, and an
  application-owned subject-to-tenant/user mapper;
- active and retained AES-256-GCM credential-encryption key-ring entries and
  HMAC capability-signing key-ring entries through secret bindings;
- optional AI Gateway/service-provider secrets only when that fixed broker mode
  is selected; and
- structured log retention/access policy compatible with the allowlisted event
  contract above.

The Hetzner/private runtime overlay must provide, without exposing values to the
browser:

- one canonical HTTPS `OPENCHAMBER_CONTROL_PLANE_URL` only after the control
  plane and Access boundary pass live acceptance;
- OpenSandbox provider selection, API key, private control-plane URL, bounded
  request timeout, and active-sandbox quota;
- a private project-scoped authority transport, durable dispatcher,
  heartbeat/lease extension, and durable orphan executor;
- a provider-neutral create idempotency or deterministic reconciliation
  contract before real create can be enabled; and
- private endpoint routing for OpenCode, preview, terminal, and session traffic
  through existing scoped authentication and allowlists, never a generic proxy.

## Rollback

Rollback is gate-first and non-destructive:

1. keep or restore production `sandboxRuntimeEnabled: false` so no new lifecycle
   route or descriptor is exposed;
2. remove `OPENCHAMBER_CONTROL_PLANE_URL` from hosted web to unregister the BFF
   and stop new v2 traffic without affecting legacy, desktop, VS Code, mobile,
   Capacitor, or API-only behavior;
3. stop the private dispatcher and drain/inspect durable claimed/effect-started
   operations through fenced recovery; never replay provider mutations by hand;
4. retain Durable Object SQLite, R2 bytes, key rings, and catalog membership;
   do not roll back by deleting authoritative data or removing old decryption
   keys; and
5. verify legacy/non-v2 health, then investigate using only redacted operation
   diagnostics.

The existing additive `v1`-`v3` Durable Object migrations require no destructive
downgrade for this software gate. Any future schema migration needs its own
forward/rollback and stored-data compatibility test before rollout.

## Deferred infrastructure acceptance (required before enablement)

These checks are intentionally not performed by milestone 6 and remain blocking:

- [ ] Cloudflare account, Worker, Durable Object migrations, R2 bucket, service
      routing, Access policy/JWKS, DNS, and TLS are provisioned and verified.
- [ ] Production secret bindings and key rotation/recovery are exercised without
      logging plaintext, raw capabilities, Access assertions, or provider keys.
- [ ] R2 exclusive ownership, checksum integrity, ambiguous-write cleanup, alarm
      recovery, retention, and backup/restore policy are verified live.
- [ ] Hetzner/private networking, firewalling, process supervision, canonical
      origins, and failure-domain isolation are verified.
- [ ] OpenSandbox live create/get/pause/resume/destroy semantics, endpoint
      authentication, provider TTL, 404 cleanup, quota behavior, and API limits
      are verified with non-production credentials.
- [ ] Provider create idempotency/deterministic lookup is proven, or a design
      that never requires blind create retry is implemented and reviewed.
- [ ] Private authority transport, durable dispatcher, heartbeat/lease renewal,
      orphan executor, crash restart, and cross-process reconciliation pass
      failure-injection tests.
- [ ] Concurrent-edit snapshot consistency and atomic checkpoint publication to
      durable authority pass race, retry, and stale-revision tests.
- [ ] Authenticated in-sandbox OpenCode, session, terminal PTY WebSocket,
      preview/subresources, reconnect, endpoint renewal, and expiry are exercised
      through the real private network and browser/relay paths.
- [ ] Cross-tenant, revoked/expired capability, path traversal, SSRF/proxy,
      redirect, header, token, and log-redaction attacks are repeated against the
      deployed boundary.
- [ ] Representative load/soak/chaos tests establish queue, provider, Worker,
      Durable Object, R2, CPU, memory, latency, and cost budgets without a
      singleton bottleneck.
- [ ] Health alerts, dashboards, operator access, incident recovery, orphan
      cleanup, rollback, and restore drills are completed.
- [ ] A staged canary proves v2-only rollback while legacy web, desktop, VS Code,
      hosted mobile, and Capacitor remain unaffected.

Only after every item passes should a separate reviewed change wire the
coordinator, enable real create, expose sandbox-runtime routes, or change public
readiness from `disabled`.
