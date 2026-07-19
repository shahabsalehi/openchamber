# @openchamber/control-plane

Private Cloudflare Worker package for OpenChamber's durable v2 control plane.
The package has three independent authority boundaries:

- one deterministic SQLite `ProjectDurableObject` per tenant/project for project
  metadata, sessions, immutable file manifests, and provider-neutral sandbox
  lease coordination;
- one deterministic SQLite `VaultDurableObject` per tenant/user for encrypted
  provider credentials and short-lived capability issuance/use state; and
- a fixed OpenAI-compatible Chat Completions broker that reserves a capability
  use before obtaining provider authorization or making one allowlisted request.

R2 owns immutable file bytes. Project SQLite never stores provider credentials.
Vault SQLite stores credential metadata plus AES-256-GCM envelope fields only;
plaintext values and raw capability tokens are never persisted.

## Identity and default behavior

The default Worker remains reject-all. Existing deployments can continue to use
`createControlPlaneHandler({ authenticator })` and the milestone-2 `Principal` /
`PrincipalAuthenticator` contract unchanged.

Milestone-3 routes require the optional `milestone3` composition with a
`VerifiedPrincipalAuthenticator`. A verified principal contains application-owned
`tenantId`, `userId`, and exact `projectScopes`. The Cloudflare Access adapter:

- reads only `Cf-Access-Jwt-Assertion`;
- verifies RS256 with Web Crypto and exact `kid`, issuer, audience, expiry, and
  `nbf` rules; and
- maps the verified `sub` through an application-owned mapper. Email and public
  identity headers are never identity keys.

`createExplicitTokenAuthenticator` is a deterministic local/test adapter. It is
not an implicit fallback for Access authentication.

## Public HTTP routes

Existing routes remain unchanged:

- `GET|PUT /v2/tenants/:tenantId/projects/:projectId`
- `GET|PUT|DELETE /v2/tenants/:tenantId/projects/:projectId/files/:nested/path`

Verified credential/capability routes are additive:

- `GET|POST /v2/credentials`
- `PUT|DELETE /v2/credentials/:credentialId`
- `POST /v2/credentials/:credentialId/revoke`
- `POST /v2/projects/:projectId/sessions/:sessionId/providers/openai/credentials/:credentialId/capabilities`
- `DELETE /v2/capabilities/:jti`
- `POST /v2/projects/:projectId/sessions/:sessionId/providers/openai/chat/completions`

Tenant/user IDs never come from these route bodies. Credential values are
write-only and limited to printable non-space ASCII suitable for the fixed
provider bearer header. Credential responses and lists contain metadata only. A raw
capability is returned exactly once in the mint response and is supplied to the
broker as `X-OpenChamber-Capability`.

## Secret bindings

Encryption and capability keys are injected as `SecretKeyRing` values whose
members expose the Secrets Store-compatible contract:

```ts
interface SecretValueBinding {
  get(): Promise<string>
}
```

Each value is canonical base64url for exactly 32 random bytes. Writes use the
ring's active `keyId`; reads select the persisted `keyId`, allowing explicit key
rotation without automatic re-encryption. No binding IDs, key values, or local
secret files belong in this repository. Production deployment configuration
must bind Secrets Store values through a private deployment overlay/dashboard.

## Broker modes

Direct mode is exactly `https://api.openai.com/v1/chat/completions` and injects
the decrypted per-user vault credential into the server-owned outbound
`Authorization` header.

Optional AI Gateway mode uses one validated, fixed
`https://gateway.ai.cloudflare.com/v1/:account/:gateway/openai/chat/completions`
URL. It never decrypts or substitutes the user's vault
credential. Gateway authentication and optional service-managed provider
authorization use separate `SecretValueBinding` values; Gateway BYOK can omit
the service provider header. The vault credential remains only the capability's
tenant/user policy anchor in this mode.

The broker accepts a strict Chat Completions subset, follows no redirects, and
returns only a reconstructed safe `Content-Type`. Request JSON is capped at 1
MiB, buffered JSON responses at 4 MiB, SSE aggregate bytes at 8 MiB, and the
default timeout is 30 seconds. Upstream redirects, errors, bodies, URLs,
credentials, cookies, authentication challenges, and diagnostic headers are
never passed through.

See [DOCUMENTATION.md](./DOCUMENTATION.md) for schemas, canonical formats,
revocation/replay behavior, browser flow, and partial-failure guarantees.

## Local checks

```bash
bun run --cwd packages/control-plane types
bun run --cwd packages/control-plane types:check
bun run --cwd packages/control-plane type-check
bun run --cwd packages/control-plane lint
bun run --cwd packages/control-plane test
bun run --cwd packages/control-plane check:startup
bun run --cwd packages/control-plane check
bun run dead-code
```

Vitest runs inside workerd with local SQLite Durable Object and R2 bindings.
Tests inject generated keys and fake provider/JWKS fetches; they require no
Wrangler login, provider call, live Cloudflare resource, or deployment.
