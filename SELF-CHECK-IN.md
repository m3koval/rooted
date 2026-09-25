# Rooted — teen self-check-in pilot

## Start here

This is a working **local, fictional-data pilot**, not a deployed church service. Python 3.10+; no runtime dependencies, accounts, or npm install.

From the extracted project folder:

```sh
python3 demo_kiosk.py
```

On Windows, `py -3 demo_kiosk.py` is equivalent. Open the **Check-in** URL printed by the launcher on that same computer. Default: `http://127.0.0.1:8771/check-in/?event=1`.

The launcher creates a NEW practice database and refuses to modify an existing one. To run another fresh practice, stop the prior server with Ctrl+C, then choose a different database filename:

```sh
python3 demo_kiosk.py --db data/second-practice.sqlite3
```

To resume a prior practice without reseeding:

```sh
python3 app.py --db data/self-checkin-demo.sqlite3 --port 8771
```

Open the original check-in link, or `/leader/` → select the practice gathering → **Open self-check-in**. The bare `/` does not guess a gathering: a leader must open an event-specific link.

## Try it

1. Type **Avery** or **Riley**. Tap the full name, then confirm **That's me**.
2. Answer **Yes** or **No** to bringing a Bible. Neither answer is recorded until final submission.
3. Enter the chapter total for the displayed reporting week. Zero is explicitly allowed. Reading remains one point per chapter; prior weekly credit is not awarded again.
4. Review the answers and tap **Check me in**.
5. The saved receipt comes from the database, not a pretend success animation. Tap **Done** or wait for the automatic reset.

Try the same person again: the app shows **Already checked in**, without new points. **Taylor Quinn** demonstrates the first-visit leader handoff. First-visit/referral verification remains leader-assisted so a self-check-in does not accidentally consume a friend's bonus eligibility.

## What's different

- Shared entrance-tablet assumption, responsive phone layout.
- One question at a time; no leader dashboard, leaderboard or drawing controls in the arrival flow.
- Explicit identity confirmation, visible reporting week, editable review, saved-state receipt.
- Same-name cases go to a leader. Broad searches must be narrowed before any result can be selected.
- Confirmed check-ins reset after 15 seconds. Abandoned drafts show a warning before resetting after 90 seconds; the user can extend the session.
- An ambiguous save stays pinned to its original person/answers. Retry is idempotent; reloading reconciles against the database. A pending save is never silently discarded to start another person.
- Leader tools remain at `/leader/`; this separation is NOT authentication.

## Boundaries

**No login or access control exists in this pilot. Do not use real youth records, expose it through a tunnel, bind it to the LAN, or publish it.** Name selection is not proof of identity. Real use needs a reviewed identity/access model, protected leader permissions, privacy/retention policy and device testing.

The server binds only to `127.0.0.1`. Another phone or iPad cannot connect; phone/tablet screenshots use browser viewport emulation, not physical Safari/iPad testing. No QR-phone rollout is included.

The kiosk API only accepts records explicitly marked fictional. This launcher marks its NEW fixture database. New records created in the older leader console are not automatically kiosk-enabled; the pilot does not grant a client-controlled bypass for that flag.

Breeze remains disconnected. No credentials were used. Attendance/Bible/friend demo amounts are not approved ministry policy. The forest photograph remains an exploratory asset and needs usage review before publication.

## Verification

`python3 -m unittest discover -v`: **40 tests passed**, including actual CLI HTTP 400/403/409 handling.

Browser acceptance: **16 result groups passed**, zero uncaught JavaScript errors. Tests include real SQLite saves/readback, lost-response retry/reload, duplicate detection, active-save locking, same-name/truncated lookup, blocked storage, reset/idle behavior, preserved leader launcher and responsive/touch-target checks across five viewport sizes.

This is automated and visual verification, not proof that real teens find it intuitive. The next validation is a short observed usability test using fictional names.

## Files

- `app.py`, `kiosk.py`: local backend and kiosk adapter.
- `static/kiosk.html`, `kiosk.css`, `kiosk.js`: real check-in UI.
- `demo_kiosk.py`: new-database-only practice launcher.
- `tests/`: backend/HTTP/CLI regression tests.
- `review/`: screenshots, browser acceptance script/results and review-resolution note in the delivery ZIP.
- `licenses/`: font license in the delivery ZIP.

Assets: Manrope from Google Fonts (SIL OFL, unmodified fonts); exploratory forest photo reused from https://unsplash.com/photos/aerial-photo-of-green-trees-ugnrXk1129g . No reference-brand artwork copied.
