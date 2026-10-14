"""End-to-end test: two Chrome profiles with the extension, a local 'streaming site', and the real server."""
import asyncio, os, re, subprocess, sys, time, shutil, tempfile
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(ROOT, '..', 'extension')
SERVER_DIR = os.path.join(ROOT, '..', 'server')
CHROME = os.environ.get('CHROME') or ('/opt/pw-browsers/chromium-1194/chrome-linux/chrome' if os.path.exists('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') else None)
MOVIE = os.path.join(ROOT, 'site', 'movie.webm')
if not os.path.exists(MOVIE):  # 5-minute test clip with picture + sound (needs ffmpeg)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=300',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=300', '-c:v', 'libvpx', '-b:v', '300k', '-deadline', 'realtime',
                    '-cpu-used', '8', '-g', '25', '-c:a', 'libvorbis', '-shortest', MOVIE], check=True)
SITE = 'http://localhost:8800'
SERVER = 'http://localhost:8787'

results = []
def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)

def start_server():
    env = dict(os.environ, PORT='8787')
    return subprocess.Popen(['node', 'server.js'], cwd=SERVER_DIR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

async def wait_for(fn, timeout=10, interval=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = await fn()
            if last:
                return last
        except Exception as e:
            last = e
        await asyncio.sleep(interval)
    return last if last else False

async def make_user(pw, name):
    d = tempfile.mkdtemp(prefix=f'cs-{name}-')
    ctx = await pw.chromium.launch_persistent_context(
        d, executable_path=CHROME, headless=True, channel=None if CHROME else 'chromium',
        args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--headless=new',
              '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
              '--autoplay-policy=no-user-gesture-required'],
        permissions=['camera', 'microphone'],
    )
    sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
    ext_id = sw.url.split('/')[2]
    watch = await ctx.new_page()
    await watch.goto(f'{SITE}/watch1.html')
    await asyncio.sleep(1.5)
    panel = await ctx.new_page()
    await panel.goto(f'chrome-extension://{ext_id}/panel.html?autoMedia=1')
    tab_id = await panel.evaluate("""async () => (await chrome.tabs.query({})).find(t => t.url.includes('/watch')).id""")
    await panel.goto(f'chrome-extension://{ext_id}/panel.html?autoMedia=1&tabId={tab_id}')
    await panel.evaluate(f"chrome.storage.local.set({{serverUrl: '{SERVER}'}})")
    await panel.reload()
    panel.on('console', lambda m: m.type == 'error' and print(f'  [{name} panel console] {m.text}'))
    return dict(ctx=ctx, watch=watch, panel=panel, ext=ext_id, name=name, dir=d)

async def vstate(u):
    return await u['watch'].evaluate("() => { const v = document.querySelector('video'); return { t: v.currentTime, paused: v.paused, src: location.pathname, vol: v.volume }; }")

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha')
            b = await make_user(pw, 'Ben')

            # --- host creates a party
            await a['panel'].fill('#name', 'Asha')
            await a['panel'].click('#create')
            label = await wait_for(lambda: a['panel'].text_content('#room-label'))
            room = re.search(r'Party (\w+)', label or '')
            check('host creates party', bool(room), label)
            room = room.group(1)

            # host starts the movie at ~10s
            await a['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 10; return v.play(); }")
            await asyncio.sleep(3)

            # --- guest joins with invite link
            await b['panel'].fill('#name', 'Ben')
            await b['panel'].fill('#join-code', f'{SERVER}/j/{room}')
            await b['panel'].click('#join')

            async def b_synced():
                sa, sb = await vstate(a), await vstate(b)
                return (not sb['paused']) and abs(sa['t'] - sb['t']) < 1.0 and sb['t'] > 5
            ok = await wait_for(b_synced, 15)
            sa, sb = await vstate(a), await vstate(b)
            check('guest joins mid-movie and catches up (<1s apart)', ok is True, f"A={sa['t']:.2f} B={sb['t']:.2f} Bpaused={sb['paused']}")

            # --- pause on host → guest pauses
            await a['watch'].evaluate("() => document.querySelector('video').pause()")
            ok = await wait_for(lambda: _paused(b), 5)
            sa, sb = await vstate(a), await vstate(b)
            check('host pause pauses guest', ok is True and abs(sa['t'] - sb['t']) < 0.7, f"A={sa['t']:.2f} B={sb['t']:.2f}")

            # --- guest seeks + plays → host follows
            await b['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 120; }")
            await asyncio.sleep(1)
            await b['watch'].evaluate("() => document.querySelector('video').play()")
            async def a_follow():
                sa, sb = await vstate(a), await vstate(b)
                return (not sa['paused']) and abs(sa['t'] - sb['t']) < 1.0 and sa['t'] > 115
            ok = await wait_for(a_follow, 10)
            sa, sb = await vstate(a), await vstate(b)
            check('guest seek + play moves host', ok is True, f"A={sa['t']:.2f} B={sb['t']:.2f}")

            # --- drift correction: knock guest 0.8s off without a seek event looking like a user action
            await asyncio.sleep(2)
            async def drift_ok():
                sa, sb = await vstate(a), await vstate(b)
                return abs(sa['t'] - sb['t']) < 0.35
            ok = await wait_for(drift_ok, 12)
            sa, sb = await vstate(a), await vstate(b)
            check('stays tightly in sync while playing (<0.35s)', ok is True, f"A={sa['t']:.2f} B={sb['t']:.2f}")

            # --- chat
            await a['panel'].fill('#chat-input', 'popcorn ready?')
            await a['panel'].press('#chat-input', 'Enter')
            ok = await wait_for(lambda: b['panel'].evaluate("() => document.getElementById('chat').innerText.includes('popcorn ready?')"), 5)
            check('chat message reaches friend', ok is True)

            # --- video chat: both should see each other's camera
            async def remote_video(u):
                return await u['panel'].evaluate("""() => [...document.querySelectorAll('.tile:not(.self) video')].some(v => v.videoWidth > 0 && !v.paused)""")
            ok_a = await wait_for(lambda: remote_video(a), 20)
            ok_b = await wait_for(lambda: remote_video(b), 5)
            check('live video: host sees guest', ok_a is True)
            check('live video: guest sees host', ok_b is True)
            ok = await wait_for(lambda: a['panel'].evaluate("""() => [...document.querySelectorAll('.tile:not(.self) video')].some(v => v.srcObject && v.srcObject.getAudioTracks().length > 0)"""), 5)
            check('live audio track received', ok is True)

            # --- camera toggle shows avatar on the other side
            await b['panel'].click('#toggle-cam')
            ok = await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self)')].some(t => t.classList.contains('no-video'))"), 6)
            check('friend turning camera off shows their avatar', ok is True)
            await b['panel'].click('#toggle-cam')
            ok = await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self)')].some(t => !t.classList.contains('no-video'))"), 10)
            check('friend turning camera back on shows video again', ok is True)

            # --- host switches episode → guest auto-follows and syncs
            await a['watch'].goto(f'{SITE}/watch2.html')
            await asyncio.sleep(1.5)
            await a['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 30; v.play().catch(() => {}); }")
            async def ep2():
                sa, sb = await vstate(a), await vstate(b)
                return sb['src'] == '/watch2.html' and not sb['paused'] and abs(sa['t'] - sb['t']) < 1.0
            ok = await wait_for(ep2, 25)
            sa, sb = await vstate(a), await vstate(b)
            check('host changes episode → guest follows and syncs', ok is True, f"A={sa['src']}@{sa['t']:.2f} B={sb['src']}@{sb['t']:.2f} Bpaused={sb['paused']}")

            # --- server crash/restart → party resumes on its own
            server.kill(); server.wait()
            await asyncio.sleep(2)
            server = start_server()
            ok = await wait_for(lambda: a['panel'].evaluate("() => document.getElementById('conn-dot').classList.contains('ok')"), 25)
            ok2 = await wait_for(lambda: b['panel'].evaluate("() => document.getElementById('conn-dot').classList.contains('ok')"), 25)
            check('both reconnect after server restart', ok is True and ok2 is True)
            await a['watch'].evaluate("() => document.querySelector('video').pause()")
            ok = await wait_for(lambda: _paused(b), 8)
            if ok is not True:
                for u in (a, b):
                    print('   ', u['name'], await vstate(u), await u['panel'].text_content('#sync-status'), (await u['panel'].inner_text('#chat'))[-300:].replace('\n',' | '))
            check('sync still works after restart', ok is True)
            ok = await wait_for(lambda: remote_video(b), 20)
            check('video chat re-established after restart', ok is True)

            # --- screenshot of the panel for the README
            await b['panel'].set_viewport_size({'width': 380, 'height': 760})
            await a['panel'].fill('#chat-input', 'this scene 😂')
            await a['panel'].press('#chat-input', 'Enter')
            await asyncio.sleep(1)
            await b['panel'].screenshot(path=os.path.join(ROOT, 'panel.png'))

            await a['ctx'].close(); await b['ctx'].close()
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

async def _paused(u):
    s = await vstate(u)
    return s['paused']

if __name__ == "__main__":
    asyncio.run(main())
