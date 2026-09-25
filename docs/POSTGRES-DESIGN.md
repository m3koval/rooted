# Rooted PostgreSQL foundation

## Status and deployment boundary

The canonical chain (`20260924000100_rooted_foundation.sql` plus `20260925000100_rooted_access_and_stations.sql`) is **rollback-tested**, not a hosted deployment. The full canonical migration and fictional behavioral suite have run on the authorized empty Rooted target `sfrkowqljeaztupywtzy` inside one transaction ending in ROLLBACK. See `DB-VERIFICATION.md` and `tests/sql/rollback-output.json`. It does not change the SQLite pilot, import participants, call Breeze, or install an iPad client/proxy. Parent owns actual migration-ledger apply and private import.

Target: PostgreSQL 15+ with Supabase `auth.users`, `auth.uid()`, `anon`, `authenticated`, and `service_role`. Migration owner must own the new schema/tables/functions. `pgcrypto` is expected in `extensions` (the usual Supabase layout); migration installs it there if absent. If already installed elsewhere, resolve that prerequisite deliberately before applying; do not move a shared extension blindly. Apply transactionally once, via the normal migration ledger.

## Authority and privacy

- `rooted` is private, not a PostgREST-exposed schema. Every table enables RLS, has no client policies, and denies all direct privileges to `PUBLIC`, `anon`, `authenticated`, and `service_role`.
- Public, `SECURITY DEFINER`, locked-`search_path` RPCs are the only application entry points. Every private helper is ungranted. Function ownership bypasses table RLS intentionally; do not enable FORCE RLS without redesigning this boundary.
- An authenticated identity must match an **active** `rooted.leaders` row. Roles are `admin` and `leader`; both have program-operation rights, but **active leaders can READ DOB and parent/guardian profiles; only admin can mutate them, rates, theme, or station/device authorizations**. Role/account provisioning is management-plane only: **no RPC can grant, change, or reactivate assignments**. PINs are check-in gates ONLY when accompanied by an admin-enrolled 256-bit station capability; never leader/admin authentication. Admin mutation authorization runs before idempotent replay, so demotion denies privileged replay too.
- Invite the eventual six individual leaders through Supabase Auth outside this migration. A trusted administrator then inserts each approved Auth UUID into `rooted.leaders`. Do not insert invented Auth identities or expose that bootstrap operation in the iPad UI. Disable public signups/anonymous sign-in as deployment configuration, not as an assumption of this migration.
- Participants have **no Auth requirement or Auth linkage**. Their names, activity, scores, receipts, referrals, audit, and integration mapping are private. No public leaderboard, Realtime feed, anonymous theme endpoint, or public read projection is installed.
- All successful commands record an immutable request receipt and audit row, including actor/device attribution. Read/search operations are not persisted as participant-search history. Never log token-bearing RPC bodies at an API proxy.
- `ledger`, `draws`, `audit`, `requests`, `checkins`, and `first_visits` reject UPDATE/DELETE and TRUNCATE through triggers, including owner-issued ordinary DML. An actual database owner can alter/disable triggers: this is application immutability, not protection against a malicious DBA.

## Tables and preserved rules

| Table | Purpose / invariant |
|---|---|
| `leaders` | Auth UUID FK; admin/leader; active state; no browser assignment mutation |
| `seasons` | Explicit date interval and active state; no theme dependency |
| `participants` | Name, prior-attendance flag, nullable unique Breeze person ID; no teen account |
| `participant_profiles` | Leader-readable/admin-writable participant FK, nullable DOB and parent/guardian name/email/phone, bounded JSON-array review flags, update time |
| `events` | Season FK, date, explicit Monday `reading_week`, open/closed switch |
| `rates` | Singleton: attendance 5, Bible 2, friend 10 initially; each 0–1000 |
| `theme` | Independent singleton: REAL / James / Real Faith. Real Life. Real Fruit. / James 1:22 / tree / enabled |
| `devices` | Hashed 256-bit random capability, event binding, issuer, expiry, revocation |
| `checkins` | One immutable participant/event record; attended, Bible, cumulative chapters, optional inviter |
| `reading_totals` | Participant/Monday global high-water mark, 0–100000 chapters |
| `first_visits` | Lifetime first actual attendance, optional original inviter, immutable source check-in |
| `friend_claims` | One lifetime immutable claim per guest; separate inviter, original event/check-in, actor, awarded-rate snapshot |
| `ledger` | Immutable earned components and signed, reasoned manual adjustments |
| `draws` | Immutable eligible weights/name snapshot, total, zero-based ticket, winner, options and actor |
| `requests` | UUID retry key, actor/device subject, exact JSONB payload, durable response |
| `audit` | Immutable accepted command payload/result, excluding device secret |

Preserved from `app.py`, `kiosk.py`, `theme.py` and their tests:

1. Bible credit requires attendance. Reading-only entries are allowed for leaders.
2. Reading earns **exactly one point per incremental chapter**, not a configurable rate. Reports are cumulative per participant and explicitly selected Monday; the report week need not be the event week. Lower/equal later reports award nothing. Weekly high-water marks are global across seasons to prevent double credit at a season boundary.
3. Attendance/Bible are once per participant/event. A repeated identical check-in is safe even with a new request UUID; changed values conflict. Correct point errors by an appended adjustment, never by editing history. Adjustments do not rewrite attendance, referral status, or reading high-water marks.
4. First visit means first recorded **attendance**, not reading-only. A friend award goes to the inviter once, only when the guest was not previously attended. No self-referral; inviter must exist. The inviter need not attend the same event. A first visit without an inviter **can be claimed later using `friend.award`**, referencing that exact first event. The original check-in/first-visit rows remain unchanged; a separate immutable claim records the inviter. Late claims may target a closed event and use the friend rate at claim time. The existing optional check-in inviter remains compatible and creates the same claim immediately. Same inviter/new request returns `duplicate:true`; another inviter conflicts.
5. Rate edits affect only new awards. Check-in receipts derive from ledger entries tied to that check-in and exclude referral/adjustment entries, so later referrals or settings changes do not alter a kiosk receipt.
6. Draws use positive net balances only, support present-only and one-win-per-event options, snapshot the full eligible pool, and **never spend points**. Present means a recorded attended check-in, not physical checkout tracking. One-win excludes every previous winner for that event when enabled; disabling it deliberately permits repeat wins as in the pilot.
7. Draw weights total the **entire lifetime accumulated ledger**, across all seasons, matching the participant directory's `points`. Seasons organize events; they never reset raffle balances. Negative net balances are legal after a correction but are excluded from draws. Draws never spend points.
8. Theme edits affect only appearance. Allowed artwork is tree/badge/wide, not a URL/upload; name/study/tagline must be nonblank, scripture may be blank. Theme changes never create/reset a season or mutate scores/history.

The pilot's fictional-only guards are intentionally not copied into the production authority layer. This migration seeds only rates/theme, never fictional or real participation data. Local pilot code remains unchanged.

## Concurrency, idempotency, and errors

All RPCs acquire the same transaction-scoped advisory lock before reading/mutating program state. This deliberately simple serialization is appropriate for six leaders and small event kiosks: check-in credit, weekly high-water marks, first visits, rate snapshots, and simultaneous draws cannot race. Transactions remain short; there are no external calls inside them. Revisit lock granularity only with measured throughput needs. Direct management-plane assignment maintenance should take the same lock; leader/device authority rows also use row locks to coordinate revocation.

Every generic command-bus mutation requires a fresh client-generated UUID `p_request_id`, retained unchanged for retries. Keys are globally unique across leaders/devices/actions. Same UUID + same actor/device + same action + equal JSONB payload returns the stored response; changed reuse raises `23505`. JSON object key order does not matter; omitted vs explicit null fields **do** differ for request-level retry matching. A failed transaction does not reserve its key. Auth/device checks occur before replay so revoked identities cannot retrieve historical private receipts. Leader replay precedes event-open validation; a completed command can be safely retried after event closure. Kiosk calls always require a currently usable capability and open event, including replay.

Normal successful command shape:

```json
{"request_id":"uuid","action":"checkin","result":{"duplicate":false,"receipt":{"checkin_id":"uuid","earned_points":10,"components":[{"label":"Attendance","points":5},{"label":"Brought Bible","points":2},{"label":"Bible reading","points":3}]}}}
```

A same-key replay returns the **exact stored response** (including its original `duplicate` value). A new request UUID for an already identical participant/event check-in returns `duplicate: true` and the same receipt. Never infer server persistence merely from a local queue entry.

SQLSTATEs: `42501` unauthorized/leader-required; `22023` invalid operation/input or no eligible draw; `23505` retry/check-in/unique mapping conflict; native `22xxx` for malformed UUID/date; native `23503` invalid FK; `23514` constraints; `55000` immutable-history attempt. The later API adapter should map these to safe UI errors without echoing sensitive database details. Retry `40001`/deadlocks with the same key if an external caller uses stronger transaction isolation. Numeric JSON must be integral and bounded; strings/booleans are not accepted as numbers.

The RNG uses `pgcrypto.gen_random_bytes(8)` and integer/numeric rejection sampling over the 64-bit domain, rejecting the incomplete modulo interval. No float rounding or modulo bias. UUID-sorted cumulative positive weights map ticket `[0,total_weight)` to exactly one winner. Weights, names, options and selected ticket are frozen in the receipt, not recomputed later.

## RPC contracts

PostgREST calls use `/rest/v1/rpc/<name>`. SQL parameter names below are exact. Payload objects reject missing and unknown keys; optional fields are explicitly identified. The app must not pass arbitrary extra UI state.

### `rooted_leader_mutate(p_request_id uuid, p_action text, p_payload jsonb) -> jsonb`

Granted only to `authenticated`; requires `auth.uid()` and an active leader assignment. Every action returns the command envelope above. `id` in creation results is the new entity UUID.

| `p_action` | Exact payload keys (all required unless marked optional) | `result` |
|---|---|---|
| `participant.create` | `name` string <=80, `previously_attended` boolean; optional `breeze_id` string <=80 or null | `{id}` |
| `profile.update` | **Admin only.** `participant_id` UUID, `date_of_birth` ISO date or null, `parent_guardian_name` string <=160 or null, `parent_guardian_email` string <=254 or null, `parent_guardian_phone` string <=80 or null, `review_flags` JSON array (serialized JSONB <=4000 bytes) | `{participant_id}`; full replacement/upsert, all listed fields required. Null clears nullable fields. Structured objects inside review flags are preserved. DOB must be 1900-01-01 through database current date; uncertain DOB stays null with suggestions in flags. |
| `friend.award` | `participant_id` guest UUID, `event_id` original first-attendance event UUID, `inviter_id` UUID | `{participant_id,event_id,inviter_id,points,duplicate}`; one lifetime award, original visit preserved |
| `season.create` | `name` <=100, `starts_on`, `ends_on` ISO dates | `{id}`; starts active |
| `season.active` | `season_id` UUID, `active` boolean | `{id,active}` |
| `event.create` | `season_id` UUID, `name` <=100, `date`, `reading_week` ISO dates | `{id}`; starts open; date must fit active season, reading week must be Monday |
| `event.open` | `event_id` UUID, `open` boolean | `{id,open}` |
| `rates.update` | **Admin only.** `attendance`, `bible`, `friend`, each integer 0–1000 | `{attendance,bible,friend}` |
| `theme.update` | **Admin only.** `name` <=60, `study` <=80, `tagline` <=160, `scripture` <=80, `artwork` enum, `enabled` boolean | Six theme fields |
| `checkin` | `participant_id`, `event_id` UUIDs; `attended`, `bible` booleans; `chapters` integer 0–100000; optional `inviter_id` UUID or null | `{duplicate,receipt:{checkin_id,earned_points,components:[{label,points}]}}` |
| `adjustment` | `participant_id`, `event_id` UUIDs; nonzero signed integer `points` between -100000 and 100000; nonblank `reason` <=500 | `{id,points}` (ledger ID); allowed on closed events for historical corrections |
| `draw` | `event_id` UUID, `prize` <=120, `present_only`, `one_win` booleans | Full immutable draw row, including ID/request/event/actor/time, winner ID/name, weights, total_weight, ticket, options |
| `kiosk.issue` | **Admin only.** `event_id` UUID, `label` <=80, `ttl_minutes` integer 1–720 | `{id,event_id,expires_at}` plus **top-level** `device_token` on the original response only |
| `kiosk.revoke` | **Admin only.** `device_id` UUID, nonblank `reason` <=500 | `{id,revoked:true}` |

**Kiosk issuance retry exception:** the device secret is intentionally never persisted in plaintext or in the request/audit receipt. A replay returns the durable issuance metadata **without** `device_token`. If the initial response is lost, revoke that device ID and issue a new capability with a new request UUID. Never generate a fresh secret on replay or silently create another live device. This is the only deliberate non-identical first-response/replay field.

### `rooted_leader_state(p_collection text, p_limit integer = 100, p_offset integer = 0) -> jsonb`

Granted only to `authenticated`; same active leader check. Returns `{actor_id,collection,rows,limit,offset}`. Limit is 1–500; offset 0–1000000. Valid collections:

`participants`, `seasons`, `events`, `checkins`, `ledger`, `draws`, `reading_totals`, `first_visits`, `friend_claims`, `rates`, `theme`, `audit`, `devices`.

Rows follow table fields, except: participants add lifetime `points`; rates/theme omit singleton ID; devices **omit token_hash**; `audit` replaces `profile.update` details with `{result:{participant_id}}` for every caller (including admins). Private contact values and review flags never appear in ordinary state or kiosk. No assignments, Auth identities, raw request table, or secrets collection exists. Rows are bounded and ordered by UUID (or the documented natural composite/time key in SQL). Offset pages are not a durable export snapshot and concurrent inserts can shift page boundaries. Refresh after writes; a future bulk export needs a server transaction/snapshot. `rows.length < limit` identifies the end for a stable collection; no fabricated `total`/`has_more` is returned.

### `rooted_identity() -> jsonb`

Authenticated active-assignment discovery returns exactly `{actor_id,role,display_name}`. Roles are `admin` or `leader`. Anonymous execution, null identity, inactive and unassigned identities fail closed (`42501`). No client role field can change assignment.

### `rooted_admin_profiles(p_limit integer = 100, p_offset integer = 0) -> jsonb`

Authenticated **active leader (including admin)**. Returns `{rows:[{participant_id,date_of_birth,parent_guardian_name,parent_guardian_email,parent_guardian_phone,review_flags}],limit,offset}`. Uses the same bounds as leader state. Left-joins all participants, so an unset profile has null DOB/contact fields and `review_flags:[]`. Join to the separately authorized participant directory on `participant_id` for the name. No DOB/contact profile is embedded in the general participant collection. Raw historical profile payloads remain in private request/audit tables solely for immutable attribution; there is no direct browser access to either table.

### `rooted_kiosk(p_token text, p_action text, p_payload jsonb = {}, p_request_id uuid = null) -> jsonb`

**Granted ONLY to `service_role`, never `anon` or `authenticated`.** Call through a future trusted server/Edge Function proxy using a server-stored service-role credential. The proxy accepts the opaque device token, never a browser-submitted role or authoritative event. The device's event is resolved from its private hash record, not from the payload. Capability is exactly 64 lowercase hex characters representing 32 random bytes, stored only as SHA-256; legacy admin-issued maximum TTL is 12 hours; PIN-unlocked station sessions are capped at four hours and parent expiry. Every call for a station-bound device also checks its parent enrollment remains active/unexpired. Issuer deactivation, explicit revocation, expiry, event closure, or season deactivation denies all calls. Revocation is not bypassed by a retry key.

| Action | Exact payload | Response |
|---|---|---|
| `context` | `{}` | `{event:{id,name,date,reading_week},rates:{attendance,bible,friend}}` |
| `search` | `{query:string <=80}` | `{matches:[{id,name}],truncated:boolean}`; fewer than 2 trimmed chars returns empty; literal substring, max 8 results |
| `person` | `{participant_id:uuid}` | `{person:{id,name},already_checked_in,needs_leader,prior_chapters,receipt}`; receipt null if none |
| `checkin` | `{participant_id:uuid,bible:boolean,chapters:integer 0–100000}` plus nonnull request UUID | Standard command envelope with action `kiosk.checkin`, result same as leader check-in |

Kiosk check-in forces attendance true and prohibits event/points/referral/actor fields. Unverified first-time visitors require a leader; the kiosk cannot create people or assign an inviter. An existing reading-only entry requires leader correction rather than promotion to attended. Search/person disclose only minimal identity, this event's receipt, and the reporting week's prior chapters; no lifetime score, Breeze ID, referral, audit, or full directory is returned.

The server proxy is **not implemented** here. Before launch it must add request/body limits, rate limiting per device/IP, no-store responses, CSRF/origin/session controls appropriate to its transport, secure token storage/rotation, non-enumerating errors, and token-safe logging. Do not expose a service-role key, Supabase management key, or Breeze key in the iPad app, web bundle, localStorage, service worker, or repository. A service-role credential is project-wide privileged even though this schema revokes its direct grants; treat it as a server secret. Bounded search reduces disclosure, but the future proxy still needs anti-scraping controls.

## Enrolled stations and PIN gates

See [STATION-CONTRACT.md](STATION-CONTRACT.md) for exact RPC arguments/results and proxy obligations. Private `stations` stores hashed random enrollment credentials, event binding, expiry/revocation, and persistent failure counters. Private `checkin_pins` stores only bcrypt hashes. All six leaders set their own six-digit PIN via a dedicated authenticated RPC; serialized duplicate detection covers inactive leaders too. No plaintext PIN enters generic receipts or audit. PIN setting records only `{ok:true}` with empty payload. Enrollment returns its bearer only once, separately from audited metadata.

Five failed PIN attempts lock that station for 15 minutes. Unlock failures are normal JSON responses, not exceptions that undo counter updates. Correct PIN cannot bypass a running lockout. PIN success creates a check-in-only device session, never an Auth session; device issuance retains the matched active leader as provenance. Event open/season active, issuer active, device expiry/revocation and parent station expiry/revocation are rechecked for every kiosk call, including replays. Station enrollment is fixed to one event. Legacy admin-only capability issuance remains supported.

Dedicated station operations do not accept generic request UUIDs. Lost enrollment/unlock responses require another operation; station listing and revocation recover orphan enrollments. Device self-lock is idempotent and remains possible after expiry/closure. It records `device_id` (not `actor_id`) in audit; legacy `devices.revoked_by` retains issued-by provenance with explicit audit semantics, not a claim that the leader performed the lock.

Real target rollback proof: complete migration chain plus `behavior.sql` and `stations.sql` passed **141 assertions**. A separate read-only probe returned `rooted_installed=false`, zero Rooted public functions, zero synthetic users and no migration ledger. No hosted schema, user, or migration was committed. Evidence: `tests/sql/rollback-output.json`; rerun with `python3 tests/sql/run_rollback.py`. This is database-role/transaction proof, not a deployed browser or concurrent-load rehearsal.

## Breeze integration reservation

`participants.breeze_id` is nullable, bounded to 80 characters, and unique. `participant.create` may attach a leader-verified mapping; its actor, exact submitted Breeze ID, request UUID, and timestamp are captured in immutable audit/request records. The bounded private `participants` read exposes this mapping to leaders, and the bounded `audit` read exposes its provenance. Kiosk responses never include it. Leader-readable/admin-writable contact profiles are supported separately; no integration credential, raw vendor payload, connection, scheduled job, or external API call is installed.

Future integration should perform read-only Breeze lookup/import preview in a trusted server process, retain source ID/observation provenance, reconcile against this unique mapping, and require review before creating/updating authoritative participants. Do not infer previous attendance from mere directory membership. Do not call Breeze from a draw/check-in transaction or ship its credentials in the iPad app. Actual synchronization, mapping correction, and a dedicated integration-provenance table are deferred until the import contract is known; never repurpose an existing immutable audit row.

## Verification / release gate

Local SQL parsing is syntax-only. Real PostgreSQL rollback execution now verifies the core matrix below (exact evidence and remaining device/concurrency gates in `DB-VERIFICATION.md`). Parent owns actual migration installation/import and deployed browser rehearsal. Minimum release matrix:

- Install from empty supported database; all private tables RLS-enabled, no client policies/grants; helper and kiosk ACLs verified under actual `SET ROLE` contexts.
- Signed-out, unassigned, inactive, and revoked users denied; assigned leader success; no browser path to assignment changes; authenticated denied kiosk execution.
- Check-in, same-key retry, new-key identical retry, payload mismatch, concurrent retries; same-week high-water updates from different events; rate changes nonretroactive.
- Bible without attendance, self-referral, missing inviter, first attendance after reading-only, previous attendee, and first-visit-without-inviter cases.
- Signed reasoned corrections, zero/negative balances excluded from draw, lifetime weights, both draw options, exact durable replay, concurrent one-win draws, no point spending.
- Direct UPDATE/DELETE/TRUNCATE attempts on append-only tables, including leader and ordinary owner DML; no secret/hash disclosure through leader state/audit.
- Issue/replay/lost-token handling, literal bounded search, first-time guest gate, forced attendance, forbidden kiosk fields, scope/expiry/revocation/issuer deactivation, service-only ACL.
- Theme validation and independent state invariants; Breeze mapping uniqueness and kiosk exclusion.
- Host/project identity and migration lineage readback before any eventual hosted apply; real authenticated iPad and proxy flow before launch.
