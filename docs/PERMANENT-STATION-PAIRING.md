# Permanent station pairing

## Contract

`20261113000100_rooted_permanent_station_pairing.sql` supersedes the station-expiration portions of STATION-CONTRACT.md, DAILY-STATION-SESSIONS.md, DISPLAY-CONTRACT.md and KIOSK-HOSTED.md. Their historical verification claims are not new release evidence.

- Pairing does not expire. Enrollment returns `expires_at: null`; list retains that compatibility field. Cached clients may still submit the former valid `ttl_days` parameter, but it no longer limits pairing.
- Existing nonrevoked station rows receive NULL expiry. Their original hashed secret, event binding, PIN failure counters and lockout are preserved; remembered iPads need no replacement QR merely because the old enrollment deadline passed.
- Revoked station rows remain byte-for-byte unchanged. No daily device row is modified by this migration. Old expired/revoked daily tokens never become usable again.
- Daily PIN access still ends at next midnight America/New_York. The server still checks the daily issuance date, device expiry, explicit/system revocation, active issuer, station binding/revocation, current gathering and active season.
- Existing weekly valid-PIN rollover, skip/ambiguity rules and explicit admin transfer are preserved. Transfer still revokes old sessions; pending intents are not remapped.
- Display uses the same protected device validator. All existing function ownership, grants and search paths are preserved by CREATE OR REPLACE.
- Enrollment UI has no TTL, station list shows Paired / Revoked, and transfer eligibility no longer tests a legacy deadline. Invalid-station copy no longer calls pairing expired.

## Local verification (not live deployment)

Clean worktree `/home/helper/rooted-station-permanent`, branch `fix/permanent-station-pairing`, based on fetched production source `b7fefb5a2ec8475af475e309286f46366dbc7e42`. Original `/home/helper/rooted` dirty tree untouched.

- PostgreSQL 16.15: complete historical migration chain applied to a new isolated database; `tests/sql/permanent-station-pairing.sql` reproduces baseline rejection then applies the actual new migration and passes 31 assertions (30 unique labels; expired token denial repeated after transfer).
- `tests/sql/weekly-schedule-rollback.sql`: passes weekly recurrence, valid-PIN rollover, old authority denial, midnight/DST, ambiguity, skipped dates and private ACL checks.
- `cd web && npm test`: 87 pass, 0 fail.
- `npm run build`: passes (113 modules).
- `node ../tests/test_station_proxy.mjs`: 24 pass, 0 fail.
- `node ../tests/test_kiosk_proxy.mjs`: 28 pass, 0 fail.
- `node tests/qa-station-enrollment.mjs`: 25 pass, including missing TTL control/payload and permanent status; real Chromium with intercepted fictional APIs.
- `node tests/qa-kiosk-flow.mjs`: 62 pass; daily expiry, retained pairing, receipt/idle behavior and late-response guards.
- `node tests/qa-display.mjs`: 76 pass; private display expiry/revocation and late responses.
- `git diff --check`: passes. Production dependency audit: zero vulnerabilities; install reported two preexisting development-dependency high advisories, not changed in this narrowly scoped release.

SQL logs: `/home/helper/.hermes/cache/scratch/rooted-station-pg/final-regression.log`, `final-weekly.log`, `final-bootstrap.log`.
Test fixture is deliberately local-only: it creates fictional records and replaces the private clock. Never run this test SQL on production. Run on a fresh local database after all migrations before 20261113000100; the test itself includes the new migration with psql `\ir`.

## Release blocker and required sequence

User explicitly authorized production release. However both `npx --yes supabase projects list -o json` (3.1.0) and `env -u SUPABASE_ACCESS_TOKEN npx --yes supabase@2.118.0 projects list -o json` return Access token not provided. `npx --yes vercel whoami` returns login_required / saved login invalid or expired. Browser Supabase dashboard is signed out and vault has no saved login. Existing private API service credentials are not database-migration authority and must not be used to bypass it.

No migration was applied remotely and no production frontend publication is claimed. Do not merge frontend ahead of backend: it would say permanent pairing while production still rejects expiry.

Once authenticated: read the exact Rooted project `sfrkowqljeaztupywtzy` migration ledger and current definitions; compare to reviewed lineage and four replacement functions. Apply only this forward migration, independently read back station/device preservation and function ACL/bodies, then merge/deploy frontend and fetch canonical deployed assets to verify the removed TTL/error copy. Never revoke/re-enroll the user's station to hide an expired-only recovery failure. No real PIN attempts or participant mutations are needed for release readback.
