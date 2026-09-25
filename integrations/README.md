# Breeze adapter — offline-tested, not connected

`breeze.py` is a deliberately read-only transport foundation. It is NOT a working roster sync, and the pilot UI does not call it. No church account or credentials have been accessed. Tests use synthetic responses/mocks, not live Breeze data.

Implemented: bounded people pages (names/IDs only requested), tag listing, event-instance attendance reading, validated tenant HTTPS origin, header credential, verified TLS via Python defaults, redirects refused, response-size bound, sanitized errors, and 3.5-second in-process pacing. No write endpoint is allowed.

Run tests: `python -m unittest integrations.test_breeze -v`

## Verified public documentation
- API endpoints: https://app.breezechms.com/api
- Official help: https://support.breezechms.com/hc/en-us/articles/360001324153-API-Advanced-Custom-Development
- Official wrapper shows `Api-key` request header: https://github.com/BreezeChMS/breeze-api-wrapper-php/blob/master/breeze.php

Breeze documents a 20-request/minute limit and recommends approximately 3.5 seconds between requests. Account owners obtain their key under Manage Account > API Key. Fine-grained key scopes are NOT verified. Do not copy the historical wrapper's disabled TLS certificate verification.

## Before live use
1. Obtain approved tenant URL, teen tag and recurring event identifiers, and securely provision a key outside Slack, source control and browser storage.
2. Use an account-wide limiter shared with any other integration. Current pacing only covers a single reader instance; it does not coordinate processes or apps.
3. Verify actual response schemas and pagination using a narrowly approved read-only test. Roster import must explicitly scope to approved teens tag, not bulk-import the church. The generic people-page method here is not a scoped roster import.
4. Establish stable Breeze IDs. Never auto-merge on names. Minimize stored profile fields; do not fetch giving, medical or household data for points.
5. Map each local meeting to its exact Breeze event instance. Match reading periods separately from event instances.
6. Build a durable paced outbox only after writeback approval. Local check-in and points must save atomically without waiting on Breeze. Show disconnected/pending/confirmed/error honestly.
7. Reconcile ambiguous attendance writes by reading the event before retrying. Never blindly retry an add after timeout. Mark confirmed only after readback. Provider sync must never re-award points.
8. Review new visitors before creating provider profiles, and verify first teens-group attendance independently of church profile creation.

No production writeback, background synchronization, distributed limiting, authenticated operator interface, or credential configuration UI is included in this module.
