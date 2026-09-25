# Same-day Rooted release contract

Target project ONLY sfrkowqljeaztupywtzy (Teens_Realy_Rooted). Current hosted database empty. Parent owns hosted apply/import/auth/deploy. No agent may import real records or print secrets. Existing pilot remains untouched; hosted frontend in web/.

Existing RPC contracts in POSTGRES-DESIGN.md remain baseline. Leader browser uses Supabase Auth and public rooted_leader_state / rooted_leader_mutate RPCs with authenticated JWT. No service keys in browser. Defaults attendance5/bible2/friend10, chapters exactly1. All raffle accumulated lifetime points, no spending. Friend bonus may be assigned by leader AFTER guest attendance via new friend.award action.

New required contract:
- rooted_identity() -> {actor_id, role:admin|leader, display_name}. Deny nonassigned/inactive.
- rooted_admin_profiles(p_limit integer default 100,p_offset integer default 0) -> {rows:[{participant_id,date_of_birth,parent_guardian_name,parent_guardian_email,parent_guardian_phone,review_flags}],limit,offset}. Strict admin-only, separate private table; no profile contents in general state or kiosk.
- rooted_leader_mutate action friend.award payload {participant_id:guest_uuid,event_id:uuid,inviter_id:uuid}; return normal envelope. Single lifetime first-visit referral award, no self referral, require recorded attendance, preserve original first-visit record and add separate claim table if necessary.
- No participant Auth accounts required. No roster names in public assets.

Frontend web/ uses Vite vanilla JS or small equivalent, includes login screen (email/password acceptable working fallback today; passkeys later, no shared PIN), signout, fail-closed role check. Authenticated UI: check-in, leaderboard, draw history, event selection/creation, participants, rate/theme settings, separate admin profile view. Preserve existing forest/pine/lavender REAL supplied assets. Mobile/iPad touch responsive. Show server receipts, persist UUID for retry uncertain operations, refresh shared data. Signed-out zero private data. No fictional production records.

Kiosk optional implementation path: separate server proxy using service_role-only rooted_kiosk RPC; shared iPad must not expose leader session. Parent will coordinate if time permits; do not falsely claim kiosk live if absent.

No credentials/data in git. Source only safe static assets. Parent confirms deployment and first-admin email with operator.
