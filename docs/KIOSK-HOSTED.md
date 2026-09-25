# Hosted check-in station

## Setup and everyday use

Use a dedicated, trusted browser profile on the shared device. Never share the leader app's authenticated browser profile. An admin enrolls a station for the intended event and privately transfers its one-time-displayed 64-character code. On `/kiosk.html`, paste it once into **Remember this station**. Thereafter the device opens a simple **Open check-in / Enter your leader PIN** screen. This is a six-digit **leader** PIN, not a participant PIN.

The enrollment credential is intentionally retained only in localStorage (`rooted.kiosk.station.v1`) under the requested trusted-device model. It is not an HttpOnly cookie, is accessible to same-origin JavaScript, and must be treated as a credential: keep the origin free of untrusted scripts and protect the browser profile. The code is shown once by admin enrollment but is a reusable station capability until expiry/revocation, not a single-use redeem code. A PIN alone grants nothing.

Unlocked check-in capability stays in this tab's sessionStorage (`rooted.kiosk.device.v1`). PIN inputs clear immediately on submission; PINs are never persisted or logged. Known Supabase `sb-*-auth-token` and chunked keys in either storage cause activation to fail closed, with periodic/storage-event checks while unlocked. This is a client safety guard, not a substitute for server authorization, nor detection of arbitrary custom Auth storage adapters.

**Lock station** clears local authority immediately and calls the server revocation RPC. A failed call prominently reports that server revocation is not confirmed; an administrator should revoke it. **Forget station** additionally removes enrollment locally (other tabs notice storage changes). Forgetting does not globally revoke the enrollment: admin station revocation is needed for a lost/untrusted device.

Person screens reset after 90 seconds; answers clear between participants. The station locks after 15 minutes without pointer/keyboard activity, checked on return from a suspended/background tab and after reload. A check-in lacking its receipt retains the exact request ID and payload in sessionStorage for idempotent retry, even across lock. It is never silently converted into success or retried against a different event. A legacy pending request without an event ID requires leader verification rather than automatic replay.

## Server boundary

Server-only environment: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; optional `KIOSK_ORIGIN` pins the allowed origin. Do not prefix privileged environment variables with `VITE_`. Configure the production URL to the approved project `sfrkowqljeaztupywtzy`; this implementation made no hosted environment changes.

`POST /api/station` supports only:
- `{action:"unlock",pin:"012345"}` with `X-Rooted-Station` → `rooted_station_unlock(p_station_token,p_pin)`.
- `{action:"lock"}` with `X-Rooted-Device` → `rooted_station_lock(p_token)`.

Matches `docs/STATION-CONTRACT.md`. Unlock success projects only `ok`, `device_token`, `expires_at`, `event_id`. Normal DB failures permit only `invalid_station`, `invalid_pin`, `locked`, `event_closed`, plus bounded optional `retry_after_seconds`. No automatic retries: failure responses must commit the DB's persistent attempt counter. Five failed PINs / 15-minute DB lockout are backend-authoritative; warm-process proxy limits only supplement them.

Existing `/api/kiosk` remains unchanged and uses `X-Rooted-Device-Token` for check-in-only RPCs. Both proxies require same-origin JSON POSTs, reject query credentials and extra fields, bound request/upstream size, use fixed RPC targets, avoid forwarding database error detail, and send no-store headers. No leader DOB/contact data is exposed through kiosk projections.

## Verification and release gates

Run `node --test tests/test_kiosk_proxy.mjs tests/test_station_proxy.mjs` (52 tests passed during implementation) and `node --check web/kiosk.js`. Upstream tests are mocked, not evidence of installed SQL or hosted authorization. A local mocked Chromium iPad-sized run verified paired PIN screen, leading-zero PIN unlock, name-search screen, PIN clearing, session-only token, explicit server lock, local token clearing, and leader-session blocking. Reviewed screenshot: `/tmp/rooted-kiosk-ipad-locked.png` (1024×1366, mock enrollment; no real credentials).

Before release the parent must verify actual migration deployment, server environment, platform routes/dev plugin, real unlock/invalid-PIN counter/lockout, revocation/expiry, exact check-in retry receipts, and a two-device event rehearsal. No deployment, commit, hosted network mutation, or real PIN attempt was performed by this implementation task.
