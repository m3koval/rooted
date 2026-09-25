# ROOTED
## Really rooted.

Working **local-only fictional-data pilot**, not a production youth check-in service. No cloud account, real youth data, Breeze credentials, or church records are used. No login or access control is implemented. Do not expose the server through port forwarding or a public tunnel.

## Implemented: REAL / James seasonal theme

Your supplied artwork now appears in check-in, leaderboards and prize drawings. **Leader → Theme & settings** saves the theme separately from points/history. See [THEME.md](THEME.md) for controls, verification and limitations.

## New: teen self-check-in

See **[SELF-CHECK-IN.md](SELF-CHECK-IN.md)** for the working tablet-first flow and safe practice launcher: `python3 demo_kiosk.py`. Leader tools now live at `/leader/`; the root is the teen kiosk and requires an explicit gathering link.

## Run
Requires Python 3.10+; tested on Python 3.11. No third-party runtime packages or npm installation.

From this folder, first launch with fictional fixtures:

```sh
python3 app.py --seed-demo
```

Open **http://127.0.0.1:8769/leader/** on that same computer. On Windows use `py -3 app.py --seed-demo` if `python3` is unavailable.

Subsequent launches preserve the SQLite database:

```sh
python3 app.py
```

Do not repeat `--seed-demo` on a populated database; it deliberately refuses to overwrite records. To test an empty database separately:

```sh
python3 app.py --db data/empty-test.sqlite3
```

Ctrl-C stops the server. The server always binds `127.0.0.1`, even if another port is supplied. A phone/iPad on another device cannot access this local-only pilot; responsive layouts can be reviewed with desktop browser device emulation until authenticated hosting is approved.

## Working features
- Create gatherings with explicit reporting weeks (Monday start; UI defaults to prior completed week).
- Register fictional participants and explicitly mark whether they have previously attended the ministry. Optional unique Breeze person ID is a local reference only.
- Check-in with attendance, brought Bible, weekly chapter total, and inviter linkage on a friend's first attended visit.
- **Reading fixed at one point per chapter.** Within the same reporting week, only an increase in the cumulative total earns additional reading points, even across different meetings.
- Configurable **DEMO rates**: attendance 5, Bible 2, first-time friend 10. These are placeholders awaiting Mike's approval, not established ministry policy.
- Immutable points ledger; changed rates do not recalculate historical awards. Duplicate identical check-ins are safe. Conflicting resubmissions are rejected.
- Leaderboard and points history. Overview/winner names use first name plus last initial; leader roster/history retain full names. This is not an access-controlled public display mode.
- Weighted prize drawing using server `secrets.randbelow`, frozen weights, saved winner/ticket, and request-id deduplication. Optional present-only and prior-winner exclusion for the gathering. Drawing uses **all pilot points**, not a season; points are not spent.
- Browser preserves an unconfirmed drawing request in session storage so it can be retried with the same ID. Do not close the tab on an ambiguous result; cross-tab/device recovery still requires operational hardening.
- Local SQLite transactions, uniqueness constraints and database triggers protect normal ledger/draw updates; this is not tamper-proof against someone with direct database/filesystem access.

## Test
```sh
python3 -m unittest discover -v
```
Optional JavaScript syntax check if Node is installed:
```sh
node --check static/app.js
```
Tests operate in temporary databases. Connector tests use mocked responses only. See `docs/VERIFICATION.md` in the release archive for actual browser and concurrency checks.

## Breeze
**Disconnected.** The UI never calls Breeze or claims to sync. `integrations/breeze.py` is a separate read-only transport foundation, not a live roster integration. See `integrations/README.md` for provider evidence, rate limits, account verification and writeback gates.

## Before real ministry use
- Adult authentication and server-enforced permissions, approved secure hosting, backup/restore and privacy/retention policy.
- Audited point/check-in corrections. Current records are locked; no correction buttons or silent edits are offered.
- Confirm actual point rates, reporting-week convention, season boundaries, drawing eligibility, and friend verification. Staff must confirm who brought a friend; software cannot verify that relationship. First visit is based on staff-marked previous attendance plus the first attendance recorded here, not inferred from Breeze profile age.
- Breeze scoped import, stable identity mapping, paced durable sync/outbox, approved test and readback confirmation.
- Reward store/redemption, student accounts, personal progress view, kiosk QR scanning, dedicated TV mode, offline check-in queue, season resets and public deployment are not included in this first slice.

Default database lives in `data/rooted.sqlite3`; excluded from source archives and Git. Keep tests and real operations separate. No secrets belong in source files, browser storage or Slack.
