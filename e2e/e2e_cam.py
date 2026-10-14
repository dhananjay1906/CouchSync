"""Camera toggling: no re-permission needed, and errors are reported once."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha')
            p = a['panel']
            await p.fill('#name', 'Asha'); await p.click('#create')
            await wait_for(lambda: p.text_content('#room-label'))
            await wait_for(lambda: p.evaluate("() => !document.querySelector('.tile.self').classList.contains('no-video')"), 10)
            await p.evaluate("""() => { window.__gum = 0; const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                navigator.mediaDevices.getUserMedia = c => { window.__gum++; return o(c); }; }""")
            for i in range(6):
                await p.click('#toggle-cam'); await asyncio.sleep(0.4)
            await p.click('#toggle-mic'); await p.click('#toggle-mic')
            calls = await p.evaluate("() => window.__gum")
            on = await p.evaluate("() => !document.querySelector('.tile.self').classList.contains('no-video')")
            check('toggling camera 6x needs no new camera permission', calls == 0, f'getUserMedia calls={calls}')
            check('camera is back on after even number of toggles', on is True)
            # Simulate the browser revoking access: camera track ends, then user clicks camera
            await p.evaluate("""() => { const v = document.querySelector('.tile.self video').srcObject.getVideoTracks()[0]; v.stop(); v.dispatchEvent(new Event('ended')); }""")
            await p.evaluate("() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', 'NotAllowedError')); }")
            for i in range(6):
                await p.click('#toggle-cam'); await asyncio.sleep(0.2)
            chat = await p.inner_text('#chat')
            n = chat.count('blocked the camera') + chat.count('permission expired')
            check('permission problem reported once, not per click', n == 1, f'messages={n}')
            tabs = len([pg for pg in a['ctx'].pages if 'permission.html' in pg.url])
            check('only one permission tab opens', tabs <= 1, f'tabs={tabs}')
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
asyncio.run(main())
