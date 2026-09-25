# Daily station sessions and duplicate check-in

## Policy and scope

Assumption: this North Carolina ministry's calendar day is **America/New_York** (Eastern Time), not the browser timezone, database timezone, UTC date, or a rolling 24-hour period. DST days can be 23 or 25 hours.

`20260925000200_rooted_daily_station_sessions.sql` replaces only `public.rooted_station_unlock(text,text)` and `rooted.require_device(text)`. It contains no table/data changes or grants. CREATE OR REPLACE preserves ownership and ACLs: station unlock remains service-role-only behind the existing proxy; the internal device helper remains private. No leader/admin authentication authority is added.

A successful PIN unlock records actual issuance time and expires at the earlier of next Eastern midnight and the enrolled station's expiry. Every station-linked kiosk request additionally checks that device creation and server time fall on the same Eastern date. Thus a legacy/manually prolonged capability cannot bypass the daily PIN gate. Existing stored expirations are untouched: already-issued four-hour sessions keep their earlier expiry and may require one transitional re-unlock. Non-station legacy devices retain their existing policy.

Parent station expiry/revocation, device expiry/revocation, inactive issuing leader, closed event, and inactive season continue to invalidate authority through existing checks. The migration does not re-enroll a station or reopen an event. One PIN per day means a *maximum session lifetime*, not a guarantee after explicit lock, cleared sessionStorage, station revocation, or other invalidation.

## Minimal browser contract

- Keep only the returned check-in device capability + expiry in the existing tab's sessionStorage; restore on reload and validate with kiosk `context`. Do not persist the PIN, invent a new Auth session, use localStorage for the daily device capability, or extend `expires_at` client-side.
- Midnight timer/expiry handling is UX only. Server validation is authoritative even if the tab slept across midnight or browser time is wrong. On capability denial, clear child state and the daily device session and show the PIN unlock screen. Retain only the separately enrolled station capability under the existing enrollment policy.
- A 15-minute inactivity rule must reset child-specific forms/receipts, **not revoke the still-valid daily device session**. Explicit leader Lock remains a real revocation and requires a PIN again.
- Kiosk `person` already returns `already_checked_in` plus the original receipt. When true, show **Already checked in** and do not show a fresh submit form.
- A concurrent same-payload/new-request check-in returns `result.duplicate=true` with the original receipt. Show **Already checked in**, never a new-points celebration. An exact request replay retains the original response (which can have `duplicate=false`); do not equate receipt replay with a new attendance award.
- A changed duplicate payload fails SQLSTATE `23505` (check-in locked). Refresh the selected person's server state and render the existing receipt, rather than claiming a second successful check-in. Do not indiscriminately map every `23505` to attendance: confirm with the person read.
- Uniqueness remains **participant + event**, not participant + calendar day. This migration does not change attendance semantics or mint additional points. Distinct events remain distinct even on the same date.

## Focused hosted proof (no deployment)

Run from repository root:

```sh
python tests/sql/run_daily_rollback.py
```

The old `run_rollback.py` replays the complete creation chain and assumes an empty schema; **do not run it against the installed live schema**. The focused runner requires the installed foundation/access migration ledger, wraps only the new daily migration plus fictional fixtures in one `BEGIN ... ROLLBACK`, uses a five-second lock timeout, and never writes migration history or commits. All fixture changes are scoped to newly generated UUIDs. It validates behavior through service-role RPCs, with owner-level reads only for assertions/fixture setup.

Evidence: `tests/sql/daily-rollback-output.json`; generated transaction: `tests/sql/daily-rollback.sql`. The initial real hosted run on project `sfrkowqljeaztupywtzy` passed **28 assertions**, including current issuance expiry, DST spring/fall arithmetic, midnight boundary arithmetic, previous-day prolonged-device denial, expired-device denial, fresh PIN replacement, duplicate/no-extra-points behavior, unchanged function ACL/owner/search_path/security-definer flags, all pre-existing stored device expiries unchanged, and issuer/event/station invalidation. Date rollover is simulated using fixture creation/expiry timestamps; the wall clock is not changed and the test does not wait until midnight. DST examples exercise the same SQL calendar expression independently; actual unlock expiry is also asserted against the stored creation timestamp.

Separate post-rollback readback confirmed unchanged function hashes and migration ledger, zero fictional Auth users, and zero fictional children. Nothing from this migration has been committed by this runner. Browser sessionStorage reload behavior and the visible Already checked in screen require the parent's UI integration/QA; SQL tests prove only the server contract.

Parent release owner must apply the reviewed forward migration through the normal migration path after review, then read back the installed ledger and function definitions. Existing installed migration files must remain immutable.
