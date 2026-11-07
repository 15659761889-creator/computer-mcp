# Wanji license / subscription v1

Decisions (2026-11-06, user-approved): self-hosted first. Free = host computer + 1 joined computer (2 total), local, full features. Pro = $19/month: multi-computer, relay remote, phone approval, sync. No local code encryption: the paid value lives on the license server and the relay. The v1 relay runs on the owner's own computer (separate process/port/data dir), no VPS yet. Keep it minimal.

## Store

- Server side: `<home>/licenses/<sha256(key)>.json`, one file per key (same one-file-per-secret pattern as relay signups, so the CLI and the service never write the same file). The raw key is never stored. Record: `{email, plan: 'pro', status: 'active' | 'revoked', expiresAt, createdAt, machines: [machineId...]}`. At most 5 machines per key.
- Client side: `<home>/license.json` (private file permissions): `{key, machineId, server, plan, expiresAt, verifiedAt}`. `machineId` is a random 16-hex id made on the first `wanji license`; it binds a key to machines loosely (cap 5) to stop casual key sharing, not a dongle. The license record itself never stores the raw key; a pending-delivery file keeps the key only until it is sent or manually delivered.
- Key format: `WANJI-XXXX-XXXX-XXXX-XXXX`, 16 chars from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (the same alphabet as pairing codes; 80 bits of entropy). Keys are normalized (dashes/spaces stripped, uppercased) before hashing.

## Endpoints

Served by both the hub process and the relay process (same handler, same store dir under `<home>/licenses/`).

- `POST /license/verify` `{key, machineId}` → `{valid, plan, expiresAt, reason}`. `reason` is one of `invalid | revoked | expired | too-many-machines`. Public by design (a license check needs no login). A successful verify binds the machineId (first 5). If this machine holds the license store, verification reads the local files instead of HTTP.
- `POST /license/webhook` — Paddle notifications. Secret from env `WANJI_PADDLE_WEBHOOK_SECRET`; without it the route answers 503 `not configured`. With it, verifies `Paddle-Signature: ts=...;h1=...` (HMAC-SHA256 over `ts:rawBody`, constant-time compare, 300 s tolerance), then: `subscription.created` / `subscription.activated` → create a license for the buyer email; `transaction.completed` → extend expiry; `subscription.canceled` / `adjustment.*` (refund/chargeback) → revoke. A successful creation sends the key only when SMTP is configured; otherwise it stays in the manual queue shown by `wanji relay license pending`.

## Optional SMTP delivery

Email delivery is off unless every required setting is present. Configure the relay process with environment variables (do not put credentials in the repository or command-line arguments):

- `WANJI_SMTP_HOST` — SMTP server hostname.
- `WANJI_SMTP_USER` and `WANJI_SMTP_PASSWORD` — SMTP credentials.
- `WANJI_SMTP_PORT` — optional; defaults to `465`.
- `WANJI_SMTP_SECURE` — optional; defaults to implicit TLS on port `465`. Set `false` for a STARTTLS connection (typically port `587`).
- `WANJI_SMTP_FROM` — optional sender address; defaults to `WANJI_SMTP_USER`.

When any required setting is missing, automatic delivery remains disabled and pending keys remain available to the operator. A send failure also leaves the key pending; the webhook still acknowledges the verified Paddle event. Use `wanji relay license pending` to inspect the queue and `wanji relay license sent <key-or-prefix>` after manual delivery.

## Local credential protection

Credential-bearing files (including `config.json`, `hub.json`, `license.json`, `join.json`, `quick-link.json`, relay account and pending-delivery files, ACME certificate/account private keys, Cloudflare login/tunnel credentials, and per-job command/spec/output files) are protected. POSIX files use mode `0600` and private directories use `0700`; Windows files and directories have old/inherited ACL grants removed and grant full control only to the current user, SYSTEM, and local administrators. Existing credential files are tightened when read; job directories are secured before command/spec/output data is written. If Windows cannot apply the ACL, the write fails rather than leaving credential contents broadly accessible. Audit logging applies a final recursive credential scrub, while typed desktop text and file contents are represented only by lengths or metadata.

## Gates

- Host (self-hosted hub): `Hub.join()` refuses a new computer when the hub already has one joined computer and the hub is not Pro (403). Computers that already joined keep working. The hub's license verdict lives in `hub.state.license = {keyHash, plan, expiresAt, verifiedAt}`; it is refreshed when the service starts (non-blocking; a network failure keeps the cached verdict) and on demand via `POST /hub/api/license/refresh` (admin only).
- Relay: accounts the operator creates (`wanji relay invite` / `wanji relay app`) are exempt. Accounts created with a license key store `state.license = {keyHash, expiresAt}`; every `/hub/*` and `/mcp` request for such an account re-reads the license record from the store, and a revoked/expired license answers 402. `/relay/signup` accepts `{licenseKey, machineId}`: a valid key creates the account linked to that key, or returns the existing one (so a buyer can reconnect a new phone).
- `wanji update` is NOT gated in v1 (updates come from the owner's own git repo; gating it would block the owner's own workflow). Phone approval and vault sync are NOT separately gated; they follow the mode (relay account = Pro, self-hosted = as today).

## Public endpoint throttling

The P1 reusable public limiter uses fixed windows, consumes IP and account buckets atomically, and returns `429` with `Retry-After` when a bucket is exhausted. The P0 change on the main branch independently applies `60/IP/minute` and `10/license/minute` to `/license/verify`; P1 adds `10 failed pairing attempts/IP/10 minutes` plus a per-hub account bucket to `/hub/join`, and `60/IP/minute` plus `10/license-or-invite-hash/minute` to `/relay/signup`. Failed relay-wide pairing attempts that match no account are counted by IP, not in a process-global counter. Keep the verifier aligned with P0 when branches are integrated; P1 deliberately does not add a second `/license/verify` limiter.

## CLI

- `wanji license <key> [--server <url>]` — verifies (local store first when this machine holds it, else HTTPS to the server), stores the key and the verdict, prints plan and expiry. Server from `--server`, env `WANJI_LICENSE_SERVER`, or the stored value; the default is the vendor's v1 license server (`https://pc-test-mcp.3618.app`, the owner's hub — it should move to a stable relay hostname later). `wanji license` with no key prints the current status; `wanji license --remove` clears it. A technical user can point `--server` at their own license server; that is accepted, the same as running their own relay — the license system stops casual key sharing, not a determined operator.
- `wanji relay license create --email <email> [--days 30]` — the operator issues a key (printed once). `wanji relay license list` — keys by email/status/expiry/machine count (never prints full keys). `wanji relay license revoke <key|prefix>` — revokes a key.

## Deferred

- Manager UI input box (CLI only in v1).
- Relay autostart as a scheduled task (v1 relay runs with `wanji relay run`).
