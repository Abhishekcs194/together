# Together

A private watch party for up to **six people**. Every phone plays the **same video file directly at full quality**, kept in sync to within a fraction of a second, with a built-in voice/video call, chat and emoji reactions. Nothing is screen-shared or re-encoded.

**Developers: start with [HANDOVER.md](HANDOVER.md)** (setup on a new machine, moving hosting, Android build, tests, decisions).

## How it works

```
                 Cinemeta (search, posters, episodes) + OpenSubtitles (subtitles)
                                   │
  your phone ── your Torrentio+debrid ──▶ your link ─┐        ┌─ her link ◀── her Torrentio+debrid ── her phone
                                                     ▼        ▼
                            same file, original quality, each from their own account/IP
                                                     │
          Together server: play / pause / seek / chat / call signalling only (tiny)
                                                     │
                          WebRTC voice/video call, directly phone to phone
```

- **Picking:** your Continue watching / library / catalogues, or search. Continuing something starts where you left off in Stremio. You get the same stream list Torrentio gives Stremio (quality, size, `[RD+]` cached), sorted so streams that play **with sound** in a browser come first. DTS/AC3/TrueHD audio is flagged "may be silent".
- **Each phone uses its own debrid:** the room shares *which file* (torrent hash). A phone with its own Torrentio link fetches that same file through its own account. Without one, it plays the picker's link and warns that the debrid service may flag account sharing.
- **Sync:** the server holds the playback state against a shared clock. Phones correct small drift by playing slightly faster or slower (0.94× to 1.06×), and seek only for big jumps. Pressing play waits until both phones have the video ready. If either stalls, both pause and resume together.
- **Subtitles:** chosen per person from Stremio's OpenSubtitles addon, with ±0.5s timing nudges. Your choice of language is remembered.
- **Series:** season/episode picker. **Next episode** keeps the same release (quality/encoder), like Stremio's binge-watching.
- **Reconnects:** if a phone backgrounds or drops signal, it rejoins and catches up.
- **Call:** low-res camera (480p / 20fps) so the movie gets the bandwidth. Anyone starts it; everyone else taps the camera button to join, and it's a real group call (every phone connects directly to every other phone). With more than 4 people on the call, video turns off automatically to keep uplink and battery usable on mobile — audio keeps working for everyone.

## First-time setup (each of you, once)

1. Install: **Android app** from https://together-i1b2.onrender.com/app (also linked on the home screen on Android phones), or open the site in Chrome → ⋮ → *Install app*.
2. Open 🔍 → **Account** → **Sign in with Stremio**. Open the short link.stremio.com code, approve it (signing in on Stremio's own page if needed), and you're done. Together then uses **all your Stremio stream addons** (Torrentio + debrid and the rest) and shows your **Continue watching**, **library** and your addons' catalogues.
   - Or use email + password. It's sent straight from the phone to Stremio's API, never through Together's server, and not stored.
   - Or, under *Advanced*, paste just a Torrentio link.
   The Stremio auth key stays on that phone. Note that a **stream link** you pick has your debrid key inside it (that's how Torrentio builds links). It passes through the room, in memory only and never logged, so the other phone can fall back to it. Only use rooms with someone you trust.

## Movie night

1. One of you taps **Start a room** and shares the invite (top-left pill). The other opens it and taps **Join the room**.
2. 🔍 → search → pick a movie (or show → season → episode) → pick a stream. It loads paused for both of you.
3. ▶. Use CC for subtitles and the camera button for the call. Earphones keep the movie out of the call mic.

A **Paste link** tab is still there for any direct video link.

## Android app

`android/` is a Trusted Web Activity: a thin wrapper that opens the site in the phone's real Chrome engine, full screen, so calls, fullscreen and share-to work exactly as in Chrome. The server publishes `/.well-known/assetlinks.json` with the signing-key fingerprint, so Chrome hides its URL bar.

```
cd android && JAVA_HOME=~/.local/jdk17 ANDROID_HOME=~/.local/android-sdk ./gradlew :app:assembleRelease \
  && cp app/build/outputs/apk/release/app-release.apk ../public/Together.apk
```

Web changes need **no** new APK, because the app always loads the live site. Rebuild only to change the icon, name or package.

⚠️ `android/together-release.jks` and `android/keystore.properties` are deliberately not in git. **Back them up.** Without them you can't ship an update that installs over the existing app.

## Deploy (Render)

Runs as a single Node web service (`npm start`; health check `/healthz`). Deployed to the **personal** Render workspace, not the GoVisually one.

Free-tier notes: the service sleeps after ~15 min idle, so the first open takes ~50 s. Rooms live in memory, so a restart means re-pasting the link.

### Optional: TURN for the call

Some mobile networks (carrier-grade NAT) block direct phone-to-phone connections. If the call won't connect on mobile data, add a TURN relay via env vars:

- Cloudflare (free tier): `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`
- or any TURN server: `TURN_URLS` (comma-separated), `TURN_USERNAME`, `TURN_CREDENTIAL`

## Local dev

```
npm install
npm start    # http://localhost:3000
```

To test as two people on one computer, open one tab on `localhost:3000` and another on `127.0.0.1:3000`; each origin gets its own identity.
