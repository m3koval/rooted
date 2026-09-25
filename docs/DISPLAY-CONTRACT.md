# PIN-protected TV display contract

## Boundary

This is **not a public leaderboard**. The owner approved youth names, lifetime points, and current-event attendance on a PIN-unlocked station TV. No DOB, guardian/contact information, review flags, external IDs, ledger reasons, device/leader identities, or raw authoritative rows are returned.

The installed canonical helper on project `sfrkowqljeaztupywtzy` is **`rooted.require_device(text)`**, not `rooted_private.kiosk_context`. The new RPC reuses it, after the same `rooted.lock_app()` lock used by existing writes. Every request rechecks device expiry/revocation, active issuing leader, daily Eastern-calendar boundary, station expiry/revocation and event binding, open event and active season. Display additionally requires `station_id IS NOT NULL`: legacy non-PIN leader-issued kiosk capabilities are rejected. No replacement authorization helper or weaker duplicate logic is introduced.

`public.rooted_display(p_token text)` is SECURITY DEFINER with empty search_path; execution is granted only to `service_role` (plus the inherent owner authority). Anonymous and authenticated browser roles cannot call it even with a valid token. No grants, tables, public projections, or existing RPCs are changed.

## HTTP contract — unchanged from frontend agreement

```http
POST /api/display
Content-Type: application/json
Origin: <same application origin>
X-Rooted-Device-Token: <64 lowercase hex chars from station unlock>

{"action":"display","payload":{}}
```

```json
{
  "event": {"id":"UUID","name":"Event name","date":"2026-09-25"},
  "attendance_count":1,
  "participants":[{"id":"UUID","name":"Participant name","points":35,"present":true}],
  "updated_at":"2026-09-25T18:00:00.123456+00:00"
}
```

- Event authority comes exclusively from the device; caller event IDs are rejected.
- Participants include the complete participant directory, ordered by lifetime points descending, then name and ID. Lifetime points sum **all ledger events/seasons**, including inactive seasons and negative adjustments; no ledger means zero. These are not event-only or season-only points.
- `present` means an `attended=true` check-in for the device's event. Historical attendance and `attended=false` rows do not count. `attendance_count` equals the number of returned participants marked present.
- `updated_at` is the server projection generation timestamp, not a change revision.
- No silent truncation: over 2,000 participants fails closed. Request body limit is 1 KiB, upstream response limit 1 MiB, upstream timeout 10 seconds. Integer totals must fit JavaScript's safe integer range.
- Explicit allowlist projection strips unexpected fields at every response level; malformed structures fail closed.
- All success/error responses set browser/CDN/Vercel `no-store`; CORS is not enabled. Only POST JSON with strict empty payload is allowed, with no query string or compression.
- Origin uses `DISPLAY_ORIGIN`, then existing `KIOSK_ORIGIN`, otherwise the application Host's HTTPS origin (HTTP localhost only outside production). `Sec-Fetch-Site`, if supplied, must be `same-origin`.
- Server-only configuration uses existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never expose the latter in a Vite variable or client bundle.
- Rate limits are bounded **per warm server instance**, not distributed: 90/device/minute, 120/IP/minute, 600 total/minute. This supplements rather than replaces the station's database PIN lockout. Suggested TV polling interval: 10–15 seconds.

### Errors and UI behavior

Errors are `{ "error": "code" }`, with no database error text.

- `403 forbidden`: missing/malformed token or rejected origin.
- `403 leader_required_or_expired`: RPC SQLSTATE `42501` or `22023`, including expired/revoked authority, event closure or inactive season. Clear displayed personal data and return to PIN unlock; do not leave stale names visible.
- `400 invalid_request`, `405 method_not_allowed`, `413 request_too_large`, `415 unsupported_media_type`.
- `429 rate_limited` with `Retry-After: 60`.
- `502/503 unavailable`: upstream failure, invalid projection, unavailable configuration or capacity bound. Do not publicize a stale cached roster.

A daily device token remains a bearer credential: same-origin checks are browser defense-in-depth, not a replacement for the token gate. Do not put tokens in URLs, logs, or public content. Station enrollment tokens cannot call this RPC directly.

## Verification and release handoff

Run from repository root:

```sh
node --test web/tests/display-api.test.js
python tests/sql/run_display_rollback.py
```

Verified during implementation:

- **37 Node tests pass**, including strict request validation, origin/token/media boundaries, bounded streams, service-only forwarding, privacy projection, malformed response denial, no-store success/errors, rate limiting and sanitized authorization failures.
- **25 real PostgreSQL assertions pass** on `sfrkowqljeaztupywtzy`: valid minimal projection, lifetime/negative/zero totals, attended current-event count, privacy allowlists, sort order, anon/authenticated denial even with a valid token, null/malformed/unknown token, revoked/expired device, old-day prolonged device, legacy non-PIN device, revoked/expired station, closed event, inactive season and inactive leader.
- The rollback runner reads installed lineage, wraps only the new migration and fictional fixtures in one BEGIN/ROLLBACK, uses no existing participants or leaders as fixtures, and separately re-reads metadata. Before/after show zero fictional users/children, unchanged canonical gate hash and unchanged migration ledger; display RPC remains absent after the pre-release test.
- Evidence: `tests/sql/display-rollback-output.json`; generated transaction: `tests/sql/display-rollback.sql`.

**Not applied or deployed by this task.** Parent release owner must review/apply `20260925000300_rooted_secure_display.sql` and deploy the proxy/frontend. This work does not claim deployed HTTP or physical-TV verification. The wire contract has not changed; the actual helper name correction and station-only eligibility are deliberate backend details.
