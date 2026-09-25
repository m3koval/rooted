# Self-check-in verification and review resolution

Local fictional-data scope only. No publication, public tunnel, real youth data, Breeze connection or GitHub push.

## Executed

- `python -m unittest discover -v`: 40 tests passed (including the seasonal-theme update).
- `node --check static/kiosk.js`: passed.
- `python review/verify_self_checkin.py`: 16 browser result groups passed, zero uncaught JavaScript errors. Browser results are included in `review/self-check-in/browser-qa.json`.
- Fresh `demo_kiosk.py` process served `/check-in/?event=1` with HTTP 200; its event context was read back from the actual API.
- Tablet Bible-question and phone review screenshots visually inspected: no observed overlapping/clipped controls; clear question, choices, review and final save.

## Review findings closed

1. **Overlapping save / stale response:** an independent review reproduced how Help could permit concurrent requests in an earlier draft. Save-in-flight state is now independent of screen, Help is disabled during save, and both success and error handling check the original epoch/pending identity. Browser regression holds an actual request, exercises Help/Retry and verifies one submission and one persisted check-in.
2. **Ambiguous names across search cutoff:** an earlier draft only checked duplicate names inside the visible result slice. Truncated results are now not selectable; users must narrow the search. Case/whitespace-normalized duplicate names hand off to a leader. Browser regression covers duplicate names at positions eight/nine and case-equivalent names.
3. **Late lookup replacing Help:** lookup generation invalidates on Help/reset. A held lookup response cannot reopen the abandoned person's confirmation.
4. **Storage and reset:** blocked browser storage stops the workflow before any new submission. Reset also clears hidden identity/answer fields; pending submissions are not discarded on reset.

## Boundaries, not claims

Five Chromium viewport sizes were checked, including touch-target measurements. These are not physical iPad, Safari, keyboard/screen-reader, full WCAG conformance, or real teen usability tests. Name selection is not authentication. Existing leader APIs are unauthenticated. First visits/referral setup remain leader-assisted. Demo point rates are unapproved samples. Only explicitly fictional fixtures can use the kiosk API; the whole server must remain loopback-only with fictional data.

The independent report initially blocked an earlier draft. These fixes were followed by the passing regressions above; no claim is made that the reviewer re-reviewed the final build.
