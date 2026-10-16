"""Real-life order: people join BEFORE allowing camera/mic, then turn them on. Do they see/hear each other?"""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER, EXT

REMOTE = """() => [...document.querySelectorAll('.tile:not(.self) video')].map(v => ({w: v.videoWidth, paused: v.paused,
  a: !!(v.srcObject && v.srcObject.getAudioTracks().some(t => t.readyState === 'live' && !t.muted)),
  v: !!(v.srcObject && v.srcObject.getVideoTracks().some(t => t.readyState === 'live' && !t.muted))}))"""

async def no_auto_media(u):
    # Open the panel the normal way (no autoMedia), and make the browser say "not granted yet".
    url = u['panel'].url.replace('autoMedia=1&', '').replace('?autoMedia=1', '')
    await u['panel'].add_init_script("""(() => {
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = d => (d && (d.name === 'camera' || d.name === 'microphone') && !window.__granted)
        ? Promise.resolve({ state: 'prompt' }) : q(d);
    })();""")
    await u['panel'].goto(url)

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha'); b = await make_user(pw, 'Ben')
            for u in (a, b): await no_auto_media(u)
            await a['panel'].fill('#name', 'Asha'); await a['panel'].click('#create')
            room = re.search(r'Party (\w+)', await wait_for(lambda: a['panel'].text_content('#room-label'))).group(1)
            await b['panel'].fill('#name', 'Ben'); await b['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await b['panel'].click('#join')
            await asyncio.sleep(4)
            selfon = [await u['panel'].evaluate("() => !!document.querySelector('.tile.self video').srcObject") for u in (a, b)]
            check('nobody has camera yet (like real first join)', selfon == [False, False], str(selfon))
            # Now each person allows camera (permission page grants -> 'media-granted')
            for u in (a, b):
                await u['panel'].evaluate("() => { window.__granted = true; }")
                await u['panel'].click('#toggle-cam')
                await asyncio.sleep(1)
            for u, other in ((a, 'Ben'), (b, 'Asha')):
                ok = await wait_for(lambda: u['panel'].evaluate(REMOTE + ".length && " + "(" + REMOTE + ")().every(x => x.w > 0 && x.a && x.v && !x.paused)" if False else "() => [...document.querySelectorAll('.tile:not(.self) video')].some(v => v.videoWidth > 0 && !v.paused && v.srcObject && v.srcObject.getAudioTracks().some(t => t.readyState === 'live' && !t.muted))"), 15)
                check(f"{u['name']} sees and hears {other} after both turn camera on late", ok is True, str(await u['panel'].evaluate(REMOTE)))
            # One turns on via the permission tab path (media-granted message) instead of the button
            c = await make_user(pw, 'Cy'); await no_auto_media(c)
            await c['panel'].fill('#name', 'Cy'); await c['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await c['panel'].click('#join')
            await asyncio.sleep(4)
            await c['panel'].evaluate("() => { window.__granted = true; }")
            perm = await c['ctx'].new_page()
            await perm.goto(f"chrome-extension://{c['ext']}/permission.html")
            await perm.click('#go')   # the user clicks "Allow camera & microphone"
            ok = await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self) video')].filter(v => v.videoWidth > 0).length >= 2"), 20)
            check('host sees the friend who enabled camera via the permission tab', ok is True, str(await a['panel'].evaluate(REMOTE)))
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
asyncio.run(main())
