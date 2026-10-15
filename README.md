# Together

A private, two-person watch party. Both phones play the **same video file directly at full quality**, kept in sync to within a fraction of a second, with a built-in voice/video call, chat and emoji reactions. Nothing is screen-shared or re-encoded.

## How it works

```
 Stremio (debrid link) ──paste/share──▶ Together room
                                            │  play / pause / seek / chat / call signalling (tiny)
               ┌────────────────────────────┴────────────────────────────┐
           your phone ◀──────── WebRTC call (direct, phone to phone) ────────▶ her phone
               │                                                         │
               └──────── video bytes (original file, full quality) ──────┘
                          from debrid, optionally via this server
```

- **Sync:** the server holds the room's playback state against a shared clock. Each phone corrects small drift by speeding up or slowing down slightly (0.94× to 1.06×), and makes a hard seek only for big jumps.
- **Buffering:** if either phone stalls, both pause ("Waiting for Riya to buffer…") and resume together.
- **Reconnects:** if a phone backgrounds or drops signal, it rejoins the same room automatically and catches up.
- **Call:** the camera runs at low resolution and frame rate (480p / 20fps) so the movie gets most of the bandwidth. Either person can start it; the other taps the camera button to join.

## Using it

1. Open the site, enter a name and tap **Start a room**. Tap the top-left pill to share the invite link.
2. She opens the link, enters her name and taps **Join the room**. On Android, ⋮ → *Add to Home screen* installs it as an app.
3. In Stremio, pick a movie and choose a **debrid stream** (e.g. `[RD+]`), then copy its stream link. If installed, Together also appears in Android's **Share** menu.
4. Tap the link icon, paste, then **Load for both**, then ▶.

Earphones help: they keep the movie audio out of the call mic.

### Picking a stream that plays in a browser

Phone browsers can't decode every format:

| Works everywhere | Often fails |
|---|---|
| MP4 / MKV with **H.264** video + **AAC** audio | **DTS, AC3, EAC3, TrueHD** audio (video plays, **no sound**) |
| HEVC/H.265 on most recent Android phones | Dolby Vision-only, AV1 on older phones |

The app detects the "plays but silent" case and warns both of you. If that happens, pick a different stream (look for `AAC`, `x264`, or "WEB-DL" release names).

### The "Stream through our server" checkbox

Real-Debrid and most debrid services ban accounts that stream from **two IPs at once**. With the box ticked, the server fetches the file once per viewer from its single IP and relays the bytes untouched, with no re-encoding. The costs: it uses the server's bandwidth (around 2× the file size per movie), and a slow server means slow starts. Untick it if your debrid service allows multiple IPs or she has her own account.

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
