# CouchSync 🛋️

Free watch parties for up to **4 people**: playback stays in sync, everyone's **live camera + mic** sit in a sidebar right inside the video page (like Teleparty), plus chat and emoji reactions. No subscriptions. You run your own tiny server.

Everyone needs their **own** account for the streaming service. CouchSync never streams the movie itself; it only syncs play/pause/position.

```
extension/   Chrome extension (in-page sidebar: faces, chat, sync)
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
3. Open any video (e.g. YouTube), click the CouchSync icon → the sidebar opens on the right of the page → enter your name → **Start a party in this tab**.
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
3. Click 📷 to allow camera/mic. The browser asks once per website (say Allow / "Always allow").
4. Anyone can play/pause/seek with the site's normal controls, and everyone follows. The host can lock controls in ⚙️ Settings.
5. **The player's fullscreen button works:** the movie fills the screen and the sidebar stays on the right. (A few players live inside a separate embedded frame — then fullscreen covers the sidebar; collapse it to floating faces or use F11.)

**Headphones are strongly recommended.** Otherwise your mic picks up the movie and friends hear it twice. Chrome's echo cancellation helps but can't fully remove it. "Lower movie volume while friends talk" (on by default) also helps.

---

## Which browsers
- **Chrome, Edge, Brave, Opera** (any Chromium browser): the sidebar lives inside the web page itself, so it looks and works the same everywhere. No extra window.
- **Firefox and Safari: not supported.** They use different extension systems; that would be a separate port.

## The sidebar: open, floating faces, hidden
- **Toolbar icon** opens/closes the sidebar on the current tab. It works on any page with an HTML5 video — big streaming sites and small/personal sites alike (plain http too).
- **|→** (top of the sidebar) collapses it: the movie goes full width and friends' faces float in a small box you can drag anywhere. The box has ⇤ (back to the sidebar), 🎙️, 📷 and ✕ (hide the faces).
- **✕ / hidden:** nothing on screen except a small orange "CouchSync" tab on the right edge; the call and sync keep going. Click the tab or the toolbar icon to bring it back.
- Hover a face → **hide** just that person. "Show hidden" brings them back.
- **⧉** pops the faces into an always-on-top picture-in-picture window, if you want them outside the browser.
- Reloading the page or clicking to the next episode reopens the sidebar by itself, still in the party.

## Settings (⚙️ in the panel)
- **Only I (host) can play / pause / seek** — guests' changes are undone and they're told why.
- **Lock party** — nobody new can join. **Remove** next to a name kicks someone; they can't rejoin that party.
- **Hide my IP address** — video goes through the relay so friends never see your IP (needs a relay server).
- **Lower movie volume while friends talk**, **Auto-open the host's video**.
- **Copy debug info** — paste it to whoever is helping you when something breaks.

## What can go wrong, and what CouchSync does about it

| Problem | How it's handled |
|---|---|
| Players act on their own (autoplay, "resume where you left off", buffering blips) | Only actions after a real click/key are shared; anything the player does by itself is put back to the party's position. |
| Media keys, headphone buttons, picture-in-picture, "Are you still watching?" | A no-click pause/play that sticks for ~1.5s is treated as real and shared — no pause/play fight. |
| Someone refreshes the video page or reopens the invite link | The page re-syncs by itself; no rewinds for anyone else. |
| Slow internet / buffering | Everyone waits once (max 20s), then the slow person catches up quietly instead of pausing everyone again. |
| Ads | Everyone waits — but never more than 3 minutes, so a stuck ad can't freeze the party. |
| Prime Video / Hulu change episodes without changing the URL | The episode title is part of the sync key; friends are told which episode to pick and the party waits for them. |
| Different editions/regions (lengths differ) | Friends are warned that scenes won't line up. |
| Host-only mode | Guests snap back instantly instead of drifting. |
| Party open in two windows | The old window stops and offers "Use it here" — no reconnect loop. |
| Sidebar hidden or page reloaded | Call and sync keep running while hidden; after a reload it reopens and rejoins by itself. |
| Player fullscreen hides the panel | A one-time hint explains Esc → F11. |
| Netflix changes its internal player | Detected and shown; play/pause still sync, use ⇆ if someone drifts. |
| Old extension versions | Friends on old versions are flagged; the server warns outdated clients. |
| Impersonation / kicking someone by their ID | Public IDs are separate from each person's secret ID. |
| Host sends friends to a random website | Only known streaming sites (or the same site you're on) open automatically; anything else needs a click and shows the site name. |
| Strangers using your relay (and your bill) | Relay credentials only go to people currently in a party, rate-limited. |
| Floods / spam | Limits on connections and new parties per network, total parties, play/pause/seek spam, and chat. |
| Server restart / redeploy | Clients are told, reconnect with random spread, and the party is rebuilt. |
| Idle tabs | The extension sleeps on every tab unless you're in a party. |
| Video calls blocked by strict networks | Needs a relay (TURN) — see below. Tiles show "Connecting…/Can't reach" and Settings shows direct vs relay. |
| Upload bandwidth / relay cost | Video bitrate drops as the party grows and on relay connections. |
| Late joiners | See the last 50 chat messages. |

### Server settings (environment variables on Render)
| Variable | Default | What it does |
|---|---|---|
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | — | Cloudflare relay (free up to 1,000 GB/month). Strongly recommended. |
| `TURN_URLS` + `TURN_SECRET` or `TURN_USERNAME`/`TURN_CREDENTIAL` | — | Any other TURN relay (coturn, ExpressTURN, Metered). |
| `MIN_CLIENT_VERSION` | 1.1.0 | Older extensions get an "update" warning. |
| `MAX_MEMBERS` | 4 | People per party. |
| `MAX_ROOMS` | 5000 | Total parties at once. |
| `MAX_CONN_PER_IP` | 30 | Connections from one network. |
| `MAX_ROOMS_PER_IP_PER_10MIN` | 10 | New parties from one network per 10 minutes. |
| `AD_WAIT_LIMIT_MS` | 180000 | Longest everyone waits for one person's ad. |

## Still not solved (needs money, a store listing, or a different design)
- **Video calls on blocked networks need a relay account** (Cloudflare/ExpressTURN signup).
- **Updates are manual** until it's on the Chrome Web Store ($5 one-time + review; see PRIVACY.md and the checklist below). Chrome also shows a developer-mode warning for unpacked extensions.
- **Closing the tab ends your part of the party** (the sidebar lives in the page). Reopen the invite link to come back.
- **Fullscreen hides the panel** — use F11.
- **Not tested on the real Netflix/Prime/Hulu/Disney+/Max players** — only on test pages that imitate them. Expect small fixes.
- **Ad-stitched streams** (some Prime/Hulu ad plans) can still drift; ad-free plans sync best.
- **One server instance**: parties live in memory. Fine for friends and small groups; for thousands of users you'd move party state to Redis and run several servers, and pay for the relay traffic (~$0.05/GB on Cloudflare after 1,000 GB).
- **No phones, Safari, or Firefox.** Max 4 people (bigger groups need a paid media server).

### Chrome Web Store checklist (if you publish)
1. Pick a name/logo that doesn't use any streaming service's or Teleparty's trademarks.
2. Host PRIVACY.md somewhere public and link it.
3. Justify permissions: "all sites" (to find the video player on any streaming site), tabs, storage, scripting.
4. $5 developer registration, upload the zipped `extension` folder, wait for review.

## Tests
```bash
cd server && npm test          # 17 server tests: sync, holds, ads, reconnects, limits, kick/lock, impersonation, spam
cd e2e && python3 e2e.py       # 2 people in real Chrome: sync, chat, video, episode switch, server restart
python3 e2e4.py                # 4 people: all in sync, everyone sees 3 faces, 5th rejected
python3 e2e_join.py            # invite-link flow
python3 e2e_embed.py           # in-page sidebar: invite, sync, collapse/float, hide, fullscreen, reload
python3 e2e_float.py           # floating faces window, hiding a person
python3 e2e_invite.py          # invite joins the right party on the first click
python3 e2e_v11.py             # media keys, still-watching, host-only, two windows, kick/lock, idle tabs, episodes
PAGE=yt2.html python3 e2e_rejoin.py  # rejoin with YouTube-like player quirks (no rewinds)
```
(e2e tests need `pip install playwright && playwright install chromium`, and the `CHROME` path in `e2e.py` adjusted for your machine.)
