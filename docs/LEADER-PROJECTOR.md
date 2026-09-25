# Leader projector view

The Projector tab in `/leaders` uses the approved leader's existing authenticated session. It does not require station enrollment or a second PIN. The separate `/display` route retains its paired-device and daily-PIN boundary for dedicated displays.

## One-phone presentation

1. Sign in to `/leaders` using your personal leader account.
2. Choose the actual season and gathering.
3. Select **Projector** from the workspace navigation.
4. Enter presentation mode before starting screen mirroring.
5. Use the phone's Screen Mirroring controls to select the compatible TV/projector receiver. Full-screen browser APIs may be unavailable on iPhone; presentation layout must still work without them.
6. End screen mirroring before returning to check-in, profiles, or other administrative views.

Do not hand this signed-in phone to participants. Presentation mode limits what is displayed; it does not turn an authenticated leader browser into a restricted kiosk. Device notification previews may also appear during mirroring; use a suitable Focus mode.

## Data

The board shows names, lifetime net points, ranks and attendance for the selected gathering. Tied point totals share rank. It does not display birthdays, guardian contacts, private profile fields or leader account details in presentation mode. Refreshes use authenticated reads and current server authorization; no station credential is minted for this tab.

Physical AirPlay compatibility and real-device mirroring require operator testing; browser layout tests do not prove hardware interoperability.
