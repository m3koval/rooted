# REAL / James — implemented seasonal theme

Rooted remains the permanent application identity. REAL is the replaceable seasonal layer for this year's study of James.

## What is implemented

- Your supplied tree/roots, circular James badge, and wide REAL artwork are bundled locally. WebP copies are lossless and were pixel-compared to the supplied images. No redraw, generated replacement, stretched text or content crop.
- The tree artwork is selected by default.
- Kiosk: themed rounded side panel on tablets; compact seasonal panel on the phone welcome screen. Phone questions hide that panel so check-in stays focused.
- Leader overview, leaderboard and prize-drawing screen carry the selected theme.
- Softer rounded panels, cards, answer buttons, inputs and controls; Rooted's forest/pine/lavender/green direction remains.
- Leader → **Theme & settings** now saves theme name, study/book, message, optional Scripture reference, artwork choice and enabled/disabled state.
- Changes persist in an independent `app_theme` SQLite table. Changing or disabling the theme does not alter points, attendance, reading totals, point rules, first visits, or saved drawing results.
- Theme updates appear immediately in the saving leader page and on refresh/new load in other open pages. They do not auto-interrupt an active check-in.

## Run

From the extracted project directory, with Python 3.10+:

```sh
python3 demo_kiosk.py --db data/real-theme-practice.sqlite3
```

Use the printed check-in URL on the same computer. Open `/leader/#settings` for the theme controls. The launcher refuses an existing database rather than overwriting it.

To resume an existing database:

```sh
python3 app.py --db data/real-theme-practice.sqlite3 --port 8771
```

Restart a previously running older server after updating source so the new theme routes are loaded. Theme defaults are inserted only when missing; saved settings are not overwritten by subsequent starts.

## Verified

- 40 Python automated tests pass, including theme validation, persisted settings and core-state invariance with saved drawings.
- Existing self-check-in browser suite: 16 result groups pass.
- Theme browser suite: 7 result groups pass; zero uncaught JavaScript errors. Covers all supplied artwork choices, save/readback/reload, wording edits, disabled theme, no point/history changes, foreign-Origin rejection, external-artwork rejection, inert text rendering and five responsive viewport sizes.
- Actual local pilot restarted with its existing database: theme API returns REAL/James and every row in the eight pre-existing core tables remains unchanged.
- Tablet, phone, settings, leaderboard and raffle screenshots inspected from the real running app.

## Boundaries

This remains a loopback-only, unauthenticated fictional-data pilot. No cloud deployment, real youth data, Breeze connection, Next.js migration or protected admin login is claimed.

Artwork selection currently contains the three supplied visuals. Arbitrary uploads and external image URLs are not implemented. Future-year artwork can be added as a reviewed local asset. Theme settings are not points-season settings; there is no points reset control.

Physical iPad/Safari testing and observed teen usability testing remain outstanding. This is not a full accessibility certification.
