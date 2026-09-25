# Station RPC contract

Migration: `20260925000100_rooted_access_and_stations.sql` (pending, not deployed).

Authenticated leader JWT:
- `rooted_set_checkin_pin(p_pin text)` → `{ok:true}`. Exactly six ASCII digits (keep leading zeros). Sets only the caller's PIN; duplicate PIN rejected with SQLSTATE 23505. Never send this through the generic mutation bus. No PIN or hash in audit/requests/reads.
- `rooted_admin_profiles(p_limit=100,p_offset=0)` now permits every active leader to READ DOB and parent contacts. Mutations remain admin-only.

Authenticated ADMIN JWT only:
- `rooted_station_manage(p_action:'station.enroll',p_payload:{event_id,label,ttl_days?})` → `{ok:true,station:{id,token,event_id,label,expires_at}}`. Default 30 days, range 1–90. Token is random 256-bit lowercase hex, returned ONCE; only SHA-256 digest stored. Save on the intended iPad, then sign out the leader Auth session. Lost response requires re-enrollment (list/revoke orphan).
- `rooted_station_manage(p_action:'station.list',p_payload:{})` → `{ok:true,stations:[{id,event_id,label,expires_at,revoked_at,created_at}]}`; no token/hash.
- `rooted_station_manage(p_action:'station.revoke',p_payload:{station_id})` → `{ok:true,station:{id,revoked:true}}`; invalidates all child sessions immediately.
- Existing generic `rates.update`, `theme.update`, `kiosk.issue`, `kiosk.revoke`, `profile.update` are admin-only, including receipt replay.

SERVICE ROLE ONLY, through the server proxy (never expose service key):
- `rooted_station_unlock(p_station_token text,p_pin text)` → `{ok:true,device_token,expires_at,event_id}` or `{ok:false,error:'invalid_station'|'invalid_pin'|'locked'|'event_closed',retry_after_seconds?:integer}`. Token required. PIN alone grants nothing. Five failures cause persistent 15-minute device lockout. Failures are returned normally so the counter commits: proxy MUST NOT throw within a surrounding DB transaction or automatically retry. No leader identity returned. Session is capped at four hours and station expiry; every kiosk call requires event still open, issuer still active, and parent station still active/unexpired.
- `rooted_station_lock(p_token text)` → `{ok:true}`. Revokes that device session only; enrollment remains so another PIN unlock can occur. Device audit attribution is used, not a forged leader action. `revoked_by` retains session issuer as provenance for the legacy constraint, not the identity of the caller.
- Existing `rooted_kiosk(p_token,p_action,p_payload?,p_request_id?)` uses the newly unlocked `device_token`, unchanged check-in-only API.

Transport: HTTPS POST bodies only, no URL/query credentials, no body/token/PIN logging; `Cache-Control: no-store`, same-origin/origin validation, bounded body and proxy rate limit. Store station credential in an HttpOnly Secure SameSite cookie where possible; do not keep a Supabase leader session on a shared station. Never expose PIN to mutation receipts, analytics, error diagnostics, or service-worker cache. Database attempt throttling remains authoritative across proxy restarts. Unknown station credentials cannot enumerate users/PINs. Closing an event, deactivating its season or unlocking leader, expiry, session lock, or parent revocation fails closed. Station authorization is fixed to its enrolled event; admin must enroll for another event.
