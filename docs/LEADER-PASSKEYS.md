# Leader passkeys

Rooted uses Supabase's experimental passkey support as an optional personal-device sign-in method. Password sign-in and password recovery remain available; passkeys do not bypass active leader authorization.

## Production configuration

- Project: `sfrkowqljeaztupywtzy`
- Display name: `Rooted`
- RP ID: `www.rooted3d.com`
- Origin: `https://www.rooted3d.com`
- Public signup and anonymous sign-in remain disabled.

Do not change the RP ID after enrollment without a credential-migration plan. The bare apex redirects to the canonical `www` host.

## Enrollment

An existing confirmed leader must first sign in legitimately. Register a passkey only on the leader's personal phone/computer, never in a shared check-in tablet's password manager. Rooted still verifies the authenticated identity against active server-side leader assignments.

The check-in station continues to use its own limited enrollment capability and leader PIN. A passkey does not replace station authorization or grant teenagers accounts.

## Recovery and verification boundaries

Enabling passkeys does not recover an account without an existing session or enrolled passkey. Email recovery can remain blocked by provider sending limits. Preserve a functioning recovery method and do not reset passwords or impersonate operators to demonstrate passkeys.

Configuration readback and successful authentication-options HTTP requests prove backend readiness, not a completed biometric ceremony. Test actual enrollment and subsequent sign-in on the operator's personal device before declaring that credential ready.
