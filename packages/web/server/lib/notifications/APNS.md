# APNs remote push — relay mode

Native iOS background push (notifications even when the app is **suspended or killed**) is
delivered via APNs through a **central relay**, so no user configures an Apple key.

## How it works

1. The app registers its APNs device token with **its own server** (`POST /api/push/apns-token`,
   `useNativePushRegistration`). PWA/desktop never register — only the native Capacitor app.
2. On a trigger (ready/error/question/permission), the server composes **generic, content-free**
   text — model name + scenario only ("Opus 4.8 finished task" / "needs your input" / "hit an
   error"), no session content — and, when a UI client is **not focused** and tokens exist, POSTs
   `{ tokens, title, body, collapseId, env, data:{sessionId} }` to the relay
   (`apns-runtime.js` → `sendViaRelay`).
3. The **relay** (`openchamber-website/apps/api`, Cloudflare Worker, `POST /v1/push/send`) holds
   the single project APNs `.p8` key, signs an ES256 JWT with `crypto.subtle`, and sends each
   token to APNs over HTTP/2. It returns per-token results; the server drops tokens flagged
   `drop` (410 / BadDeviceToken). Generic text means nothing sensitive crosses Cloudflare.
4. Tapping a push deep-links to its session via the forwarded `sessionId`.

Cloudflare is touched **only** when: native app + notifications on + app backgrounded + a
registered token exists. Local notifications (`nativeNotifications.ts`) still cover the
foreground / brief-background window; APNs covers true background.

## Modes

- **Relay (default):** server has no Apple key; `OPENCHAMBER_PUSH_RELAY_URL` defaults to
  `https://api.openchamber.dev/v1/push/send`.
- **Direct (fallback):** set `OPENCHAMBER_PUSH_RELAY_DISABLED=true` + `OPENCHAMBER_APNS_KEY_ID/
  TEAM_ID/P8` to sign+send from the server itself (HTTP/2 + ES256 JWT).

## Config

Server (`apns-runtime.js`):
- `OPENCHAMBER_PUSH_RELAY_URL` (default the public relay), `OPENCHAMBER_PUSH_RELAY_TOKEN` (soft
  bearer; must match the relay's `PUSH_RELAY_TOKEN` if set), `OPENCHAMBER_APNS_ENVIRONMENT`
  (`sandbox` default / `production`).
- Direct fallback: `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8`
  (or `_P8_PATH`), `OPENCHAMBER_APNS_BUNDLE_ID`, `OPENCHAMBER_PUSH_RELAY_DISABLED=true`.

Relay (Cloudflare Worker secrets via `wrangler secret put` / GitHub Actions): `APNS_P8`,
`APNS_KEY_ID`, `APNS_TEAM_ID`, optional `APNS_BUNDLE_ID` / `APNS_DEFAULT_ENV` / `PUSH_RELAY_TOKEN`.

## Apple setup (one-time)

1. Apple **Keys** (not Certificates) → create an **APNs Auth Key** (`.p8`) → Key ID + Team ID;
   enable **Push Notifications** on App ID `com.openchamber.app`.
2. In the **openchamber-website** repo → Actions secrets: `APNS_P8` (PEM), `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `PUSH_RELAY_TOKEN`. Push to `main` → relay deploys + secrets sync.
3. Xcode: confirm the Push Notifications capability; Clean Build Folder; run on device.

## Security posture (v1)

The real capability is *possessing a device token* (secret, per-install, bundle-scoped) — an
attacker can't obtain others' tokens. `PUSH_RELAY_TOKEN` + Cloudflare rate limiting are soft
defense-in-depth. Per-server signed identity is deferred to the future full encrypted relay,
which this design feeds into.

## Android (FCM) note

The Android equivalent is **FCM** (not implemented): the same relay would forward to FCM with a
server key, and the client would register an FCM token (same store/routes). Local notifications
already cover Android.
