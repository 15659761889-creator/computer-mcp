# Wanji license / subscription v1

Decisions (2026-11-06, user-approved): self-hosted first. Free = one computer, local, full features. Pro = $19/month: multi-computer, relay remote, phone approval, sync. No local code encryption: the paid value lives on the license server and the relay. The v1 relay runs on the owner's own computer (separate process/port/data dir), no VPS yet. Keep it minimal.

## Store

- Server side: `<home>/licenses/<sha256(key)>.json`, one file per key (same one-file-per-secret pattern as relay signups, so the CLI and the service never write the same file). The raw key is never stored. Record: `{email, plan: 'pro', status: 'active' | 'revoked', expiresAt, createdAt, machines: [machineId...]}`. At most 5 machines per key.
- Client side: `<home>/license.json` (mode 0600): `{key, machineId, server, plan, expiresAt, verifiedAt}`. `machineId` is a random 16-hex id made on the first `wanji license`; it binds a key to machines loosely (cap 5) to stop casual key sharing, not a dongle.
- Key format: `WANJI-XXXX-XXXX-XXXX-XXXX`, 16 chars from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (the same alphabet as pairing codes; 80 bits of entropy). Keys are normalized (dashes/spaces stripped, uppercased) before hashing.

## Endpoints

Served by both the hub process and the relay process (same handler, same store dir under `<home>/licenses/`).

- `POST /license/verify` `{key, machineId}` → `{valid, plan, expiresAt, reason}`. `reason` is one of `invalid | revoked | expired | too-many-machines`. Public by design (a license check needs no login). A successful verify binds the machineId (first 5). If this machine holds the license store, verification reads the local files instead of HTTP.
- `POST /license/webhook` — Paddle notifications. Secret from env `WANJI_PADDLE_WEBHOOK_SECRET`; without it the route answers 503 `not configured`. With it, verifies `Paddle-Signature: ts=...;h1=...` (HMAC-SHA256 over `ts:rawBody`, constant-time compare, 300 s tolerance), then: `subscription.created` / `subscription.activated` → create a license for the buyer email; `transaction.completed` → extend expiry; `subscription.canceled` / `adjustment.*` (refund/chargeback) → revoke. Email delivery of the key is TODO (no mail provider in v1); the operator sees new keys with `wanji relay license list`.

## Gates

- Host (self-hosted hub): `Hub.join()` refuses a new computer when the hub already has one joined computer and the hub is not Pro (403). Computers that already joined keep working. The hub's license verdict lives in `hub.state.license = {keyHash, plan, expiresAt, verifiedAt}`; it is refreshed when the service starts (non-blocking; a network failure keeps the cached verdict) and on demand via `POST /hub/api/license/refresh` (admin only).
- Relay: accounts the operator creates (`wanji relay invite` / `wanji relay app`) are exempt. Accounts created with a license key store `state.license = {keyHash, expiresAt}`; every `/hub/*` and `/mcp` request for such an account re-reads the license record from the store, and a revoked/expired license answers 402. `/relay/signup` accepts `{licenseKey, machineId}`: a valid key creates the account linked to that key, or returns the existing one (so a buyer can reconnect a new phone).
- `wanji update` is NOT gated in v1 (updates come from the owner's own git repo; gating it would block the owner's own workflow). Phone approval and vault sync are NOT separately gated; they follow the mode (relay account = Pro, self-hosted = as today).

## CLI

- `wanji license <key> [--server <url>]` — verifies (local store first when this machine holds it, else HTTPS to the server), stores the key and the verdict, prints plan and expiry. Server from `--server`, env `WANJI_LICENSE_SERVER`, or the stored value; the default is the vendor's v1 license server (`https://pc-test-mcp.3618.app`, the owner's hub — it should move to a stable relay hostname later). `wanji license` with no key prints the current status; `wanji license --remove` clears it. A technical user can point `--server` at their own license server; that is accepted, the same as running their own relay — the license system stops casual key sharing, not a determined operator.
- `wanji relay license create --email <email> [--days 30]` — the operator issues a key (printed once). `wanji relay license list` — keys by email/status/expiry/machine count (never prints full keys). `wanji relay license revoke <key|prefix>` — revokes a key.

## Deferred

- Paddle wiring (product, webhook secret, email delivery of keys).
- Manager UI input box (CLI only in v1).
- Relay autostart as a scheduled task (v1 relay runs with `wanji relay run`).
- Rate limiting on `/license/verify` (80-bit keys make brute force infeasible; revisit if abused).
