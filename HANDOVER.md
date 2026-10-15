# Together: handover

Everything needed to keep developing Together on another machine (e.g. a Windows boot) and to move hosting to another Render account. Written 2026-10-15, at commit time of this file.

- **Live:** https://together-i1b2.onrender.com (Render, free tier). See [moving to another Render account](#5-moving-to-another-render-account).
- **Repo:** github.com/Abhishekcs194/together (**private**), branch `master`.
- **Architecture explainer with diagrams:** https://claude.ai/artifact/EePjSLPQoa48phrU6gYvuJ (private to the owner's claude.ai account).
- User-facing docs: [README.md](README.md).

---

## 1. What it is and where it stands

A private watch party for two phones. Both phones play the **same video file, each fetched directly from its source at full quality**, kept in sync by a small Node server. On top: a WebRTC video call, chat and emoji reactions. Movies and shows are picked inside the app from the user's own **Stremio** account (addons like Torrentio + debrid, library, Continue watching).

| Area | State |
|---|---|
| Sync (play/pause/seek, buffering holds, reconnects) | Done, tested (~40 ms gap between phones in tests) |
| Video call, chat, reactions | Done, tested in two headless Chromes with fake cameras |
| In-app browsing (Cinemeta), Torrentio streams, codec warnings | Done, tested against a stand-in Torrentio |
| Each phone resolves the same file through its own debrid | Done, tested |
| Subtitles (OpenSubtitles v3), next episode | Done, tested with the real services |
| Stremio sign-in (link code + email/password), library, Continue watching | Done, tested against a stand-in API that matches stremio-core. **Real sign-in not yet tried.** |
| Android app (Trusted Web Activity) | Built, signed, verified with apksigner/aapt. **Not yet run on a device.** |
| Two physical phones on mobile data | **Not yet tested.** TURN may be needed for calls. |

## 2. Repo map

```
server.js               Node server: static files, WebSocket rooms, /api/ice, /api/new-room,
                        /healthz, /app (APK), /.well-known/assetlinks.json, optional /stream proxy
public/
  index.html            the whole UI (home, room, browse sheet, subtitles dialog)
  app.js                connection, clock sync, playback sync, controls, chat, WebRTC call
  catalog.js            Cinemeta search/meta, stream addons, stream parsing + codec ranking,
                        "find the same file through my own addons", next episode
  stremio.js            Stremio sign-in (link code / password), addon collection, library
  browse.js             browse sheet: Search / Paste link / Account, home rows, streams list
  subs.js               subtitles: fetch SRT, convert to cues, per-person picker, timing nudge
  style.css             all styles (mobile first; landscape and ≥900px layouts)
  manifest.webmanifest  PWA manifest incl. Android share target
  sw.js                 minimal service worker (installability only, no caching)
  Together.apk          the downloadable Android app (served at /app)
android/                Trusted Web Activity wrapper (Gradle project)
test/                   protocol, call and end-to-end tests + stand-ins (see §7)
render.yaml             Render Blueprint (recreates the service on any account)
```

Only one runtime dependency: `ws`. No framework, no bundler, no database.

## 3. Run it locally (Windows)

1. Install **Node 20+** (nodejs.org installer or nvm-windows) and **Git**.
2. Clone and run:
   ```powershell
   git clone https://github.com/Abhishekcs194/together.git
   cd together
   npm install
   npm start                      # http://localhost:3000
   # another port: $env:PORT=3123; npm start
   ```
3. To act as two people on one computer, open `http://localhost:3000` in one tab and `http://127.0.0.1:3000` in another. Each origin has its own storage, so each gets its own identity.

Phones on the same Wi-Fi can't use the dev server for calls or sign-in, because camera, mic and `crypto` need HTTPS. Test those on the deployed site.

## 4. How the Render service works today

- **Account:** currently a personal workspace on a Render login that uses a work email. That's why it's moving.
- **Service:** web service `together`, free plan, Frankfurt, runtime Node.
- **Build / start:** `npm ci` / `npm start`. Health check: `GET /healthz` → `ok`.
- **Deploys:** auto-deploy on every push to `master` (about a minute).
- **Env vars:** none required. Optional, for calls on strict mobile networks: `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` (Cloudflare Realtime TURN), or `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` for any TURN server.
- **State:** rooms live in memory. A deploy, restart or sleep clears them; phones reconnect and the movie just needs picking again.
- **Free-tier sleep:** after about 15 minutes with no traffic the service sleeps, and the next visit waits about 50 s. During a movie the open WebSockets keep it awake. Fixes: the paid Starter plan, or an external ping to `/healthz` every 10 minutes (cron-job.org), which uses up free hours.
- **No secrets on the server.** Stremio keys stay on phones. Stream links (which contain the picker's debrid key) pass through a room's memory and are never logged or stored.

## 5. Moving to another Render account

The address will change (Render gives each service its own `*.onrender.com` name), and the Android app is tied to its address. So the order matters:

1. **Give the new Render account access to the repo.** In the new account: Account settings → GitHub → connect the GitHub account that owns the repo (Abhishekcs194) and grant access to `together`. It's private, so Render can only see it once access is granted.
2. **Create the service from the Blueprint.** Dashboard → **New → Blueprint** → choose `Abhishekcs194/together` → **Apply**. `render.yaml` creates the same service (free, Frankfurt, same commands, health check). Without the Blueprint: New → Web Service → the repo, runtime Node, build `npm ci`, start `npm start`, health check `/healthz`.
3. **Note the new address**, e.g. `https://together-abcd.onrender.com`, and check it:
   - `/healthz` → `ok`
   - `/.well-known/assetlinks.json` → JSON with package `io.github.abhishekcs194.together`
4. **Point the Android app at it.** Edit one line, `android/gradle.properties` → `togetherHost=together-abcd.onrender.com`. Then bump `versionCode` (e.g. 1 → 2) in `android/app/build.gradle` so phones accept it as an update. Rebuild (see §6), copy the APK to `public/Together.apk`, and update the `/app` link in README.md. Commit and push.
5. **Reinstall the app on both phones** from `https://<new address>/app`. It installs as an update only if signed with the **same keystore** (see §6). Browser storage belongs to each address, so both of you **sign in to Stremio again** and re-enter your names once.
6. **Delete the old service** in the old Render account once the new one works: service → Settings → Delete.

To avoid this dance next time, add a **custom domain** (Render → service → Settings → Custom Domains), put that in `togetherHost`, and the address never changes again.

## 6. Android app (build on Windows)

`android/` is a **Trusted Web Activity**: the app opens the live site in the phone's own Chrome engine, full screen. The library is `com.google.androidbrowserhelper:androidbrowserhelper:2.7.4`, with AGP 8.13, Gradle 8.14 (wrapper included), compile/target SDK 36, min SDK 24. Package: `io.github.abhishekcs194.together`.

**The signing key is not in the repo, on purpose.** These two files exist only on the original machine and must be copied over privately (USB stick or password manager, never git or chat):

```
android/together-release.jks      the signing key
android/keystore.properties       storeFile, storePassword, keyAlias, keyPassword
```

Lose them and you can't ship an update that installs over the existing app. The only way back would be a new key, a new fingerprint in `server.js` (`ASSET_LINKS`), and both phones uninstalling first. Back them up somewhere besides the dev machine.

**Build:**
1. Install **Android Studio**; it brings the Android SDK and a JDK. Or install JDK 17 plus the command-line SDK tools.
2. Put the two key files into `android/`.
3. Build from PowerShell:
   ```powershell
   cd android
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"   # or your JDK 17 path
   .\gradlew.bat :app:assembleRelease
   copy app\build\outputs\apk\release\app-release.apk ..\public\Together.apk
   ```
   Android Studio creates `android/local.properties` with the SDK path; it's gitignored.
4. If the key ever changes, update the fingerprint in `server.js` → `ASSET_LINKS`. Get it with `keytool -list -v -keystore together-release.jks -alias together`. Current fingerprint: `15:75:58:53:51:03:E5:E6:A6:43:1D:24:4A:0E:E6:41:91:7E:7B:ED:6F:83:2D:40:23:9C:2F:E0:BE:F2:19:D3`.

Web changes need **no** new APK. Rebuild only for the address, icon, name or package.

## 7. Tests

All in `test/`. Start the app server on port **3123** first (`$env:PORT=3123; npm start`).

| File | What it checks | Also needs |
|---|---|---|
| `protocol.js` | Rooms, 2-person limit, play/pause/seek, buffering auto-pause, chat, signalling relay, reconnect, static routes, proxy range requests | nothing else |
| `call.js` | WebRTC call: connect, both cameras, camera off → initial shown, hang up on both, call again | one headless Chrome on :9333 |
| `e2e.js` | Browse → search → streams ranking → each phone resolves its own file → play waits for the slower phone → subtitles → series → next episode → fallback warning | Chromes on :9333 and :9334, `fakeaddon.js`, `rangeserver.js` |
| `e2e-stremio.js` | Stremio link-code and password sign-in, addons/rows/library, Continue watching resumes, per-account streaming, sign-out, no keys in room state | as above + `fakestremio.js` |

Helpers:
- `rangeserver.js <video.mp4>` (:3125) serves a test video with range requests. Make one with ffmpeg:
  `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24:duration=120 -f lavfi -i sine=frequency=440:duration=120 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart test.mp4`
- `fakeaddon.js` (:3130) acts like Torrentio + debrid for two accounts, `/userA` and `/userB`.
- `fakestremio.js` (:3131) acts like api.strem.io + link.stremio.com. Pages use it through the localStorage overrides `tg.stremioApi` / `tg.stremioLink`.
- Headless Chrome, two **separate** instances (background tabs don't load media):
  ```powershell
  & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9333 --user-data-dir=$env:TEMP\tg1 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required about:blank
  # same again with port 9334 and $env:TEMP\tg2
  ```
- Run: `node test\protocol.js`, `node test\call.js`, `node test\e2e.js`, `node test\e2e-stremio.js`. Screenshots go to `test/out/`.

Re-running against the same server or Chrome profiles can produce two harmless failures: chat history left in a fixed test room, and an addon still saved in the profile. Restart the server or use fresh `--user-data-dir` folders.

## 8. Decisions and lessons (read before changing things)

- **Video never goes through the server.** Torrentio sits behind Cloudflare, which **blocks cloud IPs like Render's** (HTTP 403). Debrid services also flag one account streaming to two IPs and restrict data-centre IPs. So each phone fetches its own copy. The room shares *which file* (IMDb id + torrent hash + file index + release group), and each phone finds that file through its own addons. The old `/stream` proxy route is still there for plain direct links but is off by default.
- **Browser codecs:** phones' browsers drop **DTS / AC3 / EAC3 / TrueHD** audio silently: the picture plays, with no sound. Streams are ranked to put AAC first, flagged "may be silent", and the player warns if no audio is being decoded (`webkitAudioDecodedByteCount`).
- **Stremio APIs are called from the phone** (CORS is open). Link sign-in: `GET link.stremio.com/api/create?type=Create` → `{code, link}`, then poll `…/api/read?type=Read&code=…` until `result.authKey`. That shape was checked against stremio-core `LinkAuthKey`. Account data: `POST api.strem.io/api/{login, getUser, addonCollectionGet, datastoreGet, logout}`.
- **Sync rule of thumb:** within ±0.15 s do nothing; up to 1.5 s play at 0.94× or 1.06×; beyond that seek, then wait 3 s before seeking again. Play is held while anyone is still loading.
- **Calls** use WebRTC "perfect negotiation", so either side can add or remove media without offers colliding. Camera off = `replaceTrack(null)` plus a `call/cam` message, because a disabled track still sends black frames.
- **Headless testing:** a background tab in headless Chrome doesn't load or play media, so use two Chrome instances.

## 9. Ideas / backlog

- Always-on hosting (Starter plan) or a keep-alive ping; TURN for calls on mobile data.
- Room state in Redis so deploys don't reset rooms.
- Collapsible chat in upright phone view and in the wide-screen sidebar.
- Optional host-only controls.
- Write watch progress back to the Stremio library (today it only reads).
- Scaling path (multiple instances + Redis pub/sub, SFU for group calls, own accounts) is laid out in the architecture explainer.
