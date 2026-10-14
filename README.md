# CouchSync 🛋️

Free watch parties for up to **4 people**: playback stays in sync, everyone's **live camera + mic** sit in a side panel next to the movie, plus chat and emoji reactions. No subscriptions. You run your own tiny server.

Everyone needs their **own** account for the streaming service. CouchSync never streams the movie itself; it only syncs play/pause/position.

```
extension/   Chrome extension (side panel: faces, chat, sync)
server/      Node server: rooms, sync, chat, video-call signaling
e2e/         Automated browser tests (2-person, 4-person, invite link)
render.yaml  One-click free hosting on Render
```

---

## 1. Try it on your own computer (5 minutes)

```bash
cd server
npm install
npm start            # → CouchSync server listening on :8787
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `extension` folder.
2. Pin CouchSync (puzzle icon → pin).
3. Open any video (e.g. YouTube), click the CouchSync icon → side panel opens → enter your name → **Start a party in this tab**.
4. Test with a second Chrome profile on the same computer: load the extension there too and paste the invite link.

`localhost` only works on your machine. To use it with friends, do step 2.

## 2. Put the server online for free

### Option A: Render (always reachable, free)
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → **New → Blueprint** → pick the repo (it reads `render.yaml`).
3. You get a URL like `https://couchsync-xxxx.onrender.com`. Open `/health` to check it says `ok`.

Render's free tier sleeps after 15 minutes with no traffic. The first person to connect after that waits about a minute while it wakes up. During a party it stays awake, because the app sends messages constantly. 750 free hours a month covers running it all month.

### Option B: Your own PC + Cloudflare Tunnel (no account needed)
```bash
npm start                                   # in server/
cloudflared tunnel --url http://localhost:8787
```
It prints an `https://something.trycloudflare.com` URL. It changes every time you restart, and only works while your PC is on.

### Point the extension at your server
Edit `extension/config.js`:
```js
export const DEFAULT_SERVER = 'https://couchsync-xxxx.onrender.com';
```
Then zip the `extension` folder and send it to your friends. (Friends who open an invite link get the server set automatically anyway.)

## 3. Friends install it
Each friend: unzip → `chrome://extensions` → Developer mode → **Load unpacked** → pick the folder. Works in Chrome, Edge and Brave on Windows, Mac and Linux. Not on phones (no browser extensions there).

> Publishing on the Chrome Web Store would avoid "Load unpacked", but it costs a one-time $5 developer fee and requires Google review. Not needed for you and your friends.

## 4. Using it
1. **Host**: open the movie or episode, click the CouchSync icon → **Start a party** → **🔗 Invite** copies the link → send it.
2. **Friends**: open the link → **Join party** → the movie opens → click the CouchSync icon. The panel joins and syncs automatically.
3. Click 📷 once to allow camera/mic. Chrome can't prompt inside a side panel, so a one-time tab opens for that.
4. Anyone can play/pause/seek with the site's normal controls, and everyone follows. The host can lock controls in ⚙️ Settings.
5. **Use F11 (browser fullscreen), not the player's fullscreen button.** Player fullscreen covers the side panel, which hides faces and chat.

**Headphones are strongly recommended.** Otherwise your mic picks up the movie and friends hear it twice. Chrome's echo cancellation helps but can't fully remove it. "Lower movie volume while friends talk" (on by default) also helps.

---

## What can go wrong, and what CouchSync does about it

| Problem | How it's handled |
|---|---|
| Someone's internet is slow / buffering | Everyone pauses with "⏸ Waiting for Ben…" and resumes together. If one person is stuck more than 20s, the rest carry on so one bad connection can't freeze the party. |
| Someone gets an ad (YouTube, ad-supported Prime/Hulu) | Same as buffering: the others wait, then everyone resumes. |
| Small drift over a long movie | Checked every second. Under 1.5s it's corrected by speeding up or slowing down slightly (unnoticeable); bigger drift triggers a seek. Tested: stays within about 0.3s. |
| Infinite "you paused → I paused → you paused" loops | Every play/pause/seek is tagged as "ours" or "the user's"; only user actions are broadcast. |
| Netflix crashes when seeked (error M7375) | Seeks use Netflix's own player API instead of the video element. |
| Disney+ hides the video in a closed shadow DOM | Uses Chrome's `chrome.dom.openOrClosedShadowRoot` to find it. |
| Players inside iframes (many smaller sites) | The script runs in all frames and the panel picks the largest playing video. |
| Thumbnails or preview trailers mistaken for the movie | Small videos are ignored; on known sites only real player pages (e.g. `/watch/…`) count. |
| Host goes to the next episode, or Netflix autoplays it | Friends' tabs automatically open the same episode; everyone waits until all have loaded it. |
| Chrome blocks autoplay for a friend | A big "▶ Click to sync" button appears on their video. One click fixes it. |
| Wi-Fi blip, laptop sleeps, panel closed by accident | Auto-reconnects with backoff. Your seat is held for 30 seconds, and reopening the panel rejoins the same party. |
| Server restarts (e.g. Render redeploy) | Everyone reconnects and the party is rebuilt with the same invite link and position. Tested. |
| Host leaves | The next person automatically becomes host. |
| Video call can't connect (strict office/school/mobile networks) | Automatic ICE restart. For the roughly 10–20% of networks that block direct connections, add a TURN relay (below). |
| Camera busy in Zoom/Teams, or no camera | Falls back to mic only, or watch-only. You still see everyone else. |
| A 5th person tries to join | Told clearly "This party is full (max 4)." |
| Spam / huge messages | Chat length limits and rate limits on the server. |
| Tab opened before installing the extension | The panel injects the script into it automatically. |

### Optional: TURN relay for friends behind strict networks
If one friend's video never connects (everything else works), set these on your Render service (**Environment**):

- **Cloudflare (free up to 1,000 GB/month):** create a TURN key in the Cloudflare dashboard (Realtime → TURN), then set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`.
- **Or your own coturn:** `TURN_URLS=turn:your.host:3478` and `TURN_SECRET=<static-auth-secret>`.

## Honest limits
- **Real streaming sites were not tested here.** I couldn't sign into Netflix, Prime or Disney+ from the build machine. The sync engine, 4-way video, invite links and reconnects were tested end-to-end in real Chrome against a test video page. Netflix, YouTube, Disney+, Prime, Hulu and Max have specific handling based on how their players are known to work, and any other site with a normal HTML5 video should work generically. These sites change their players without warning, so expect to tweak `content.js` occasionally. If a site misbehaves, the "⇆ Sync all to me" button force-aligns everyone.
- **Ad-supported tiers that stitch ads into the stream** (some Prime/Hulu plans) can shift timestamps differently per person. Ad-free plans sync best.
- **Everyone needs the same title available.** Region-locked shows may not exist for a friend in another country.
- **Mesh video caps at 4 people.** Each person uploads their camera to 3 others at about 350 kbps each. Past 4 you'd need a media server (e.g. LiveKit).
- Don't use the name "Teleparty" or its logo, and check each streaming service's terms. Syncing playback is how all these tools work, but don't try to rebroadcast video.

## Tests
```bash
cd server && npm test          # 12 server tests: sync, holds, ads, reconnects, limits, signaling
cd e2e && python3 e2e.py       # 2 people in real Chrome: sync, chat, video, episode switch, server restart
python3 e2e4.py                # 4 people: all in sync, everyone sees 3 faces, 5th rejected
python3 e2e_join.py            # invite-link flow
```
(e2e tests need `pip install playwright && playwright install chromium`, and the `CHROME` path in `e2e.py` adjusted for your machine.)
