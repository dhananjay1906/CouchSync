import asyncio, os, re, subprocess
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, ROOT, SERVER
async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800']); server = start_server(); await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            us = [await make_user(pw, n) for n in ['Asha', 'Ben', 'Cy']]
            a = us[0]
            await a['panel'].fill('#name', 'Asha'); await a['panel'].click('#create')
            room = re.search(r'Party (\w+)', await wait_for(lambda: a['panel'].text_content('#room-label'))).group(1)
            for u in us[1:]:
                await u['panel'].fill('#name', u['name']); await u['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await u['panel'].click('#join')
            await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self) video')].filter(v => v.videoWidth > 0).length >= 2"), 25)
            await a['panel'].click('#float'); await asyncio.sleep(2)
            pip = [p for p in a['ctx'].pages if p.url in ('about:blank', '') and p not in (a['watch'], a['panel'])]
            print('pages:', [p.url for p in a['ctx'].pages])
            if pip:
                await pip[-1].set_viewport_size({'width': 320, 'height': 460})
                await asyncio.sleep(1)
                await pip[-1].screenshot(path=os.path.join(ROOT, 'float.png'))
            await a['panel'].set_viewport_size({'width': 380, 'height': 520})
            await a['panel'].screenshot(path=os.path.join(ROOT, 'panel-floating.png'))
    finally:
        server.kill(); static.kill()
asyncio.run(main())
