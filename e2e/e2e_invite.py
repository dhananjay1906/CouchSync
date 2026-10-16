"""Friend who was recently in his OWN party opens your invite: must land in YOUR party on the first try."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER, SITE

async def room_of(panel):
    t = await wait_for(lambda: panel.evaluate("() => { const l = document.getElementById('room-label'); return l && !document.getElementById('party').classList.contains('hidden') && l.textContent; }"), 15)
    m = re.search(r'Party (\w+)', t or '')
    return m.group(1) if m else None

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha')
            await a['panel'].fill('#name', 'Asha'); await a['panel'].click('#create')
            host_room = await room_of(a['panel'])

            for order in ('panel-opens-same-moment', 'panel-opened-before-clicking-join'):
                b = await make_user(pw, 'Ben')
                panel_url = b['panel'].url
                # Ben had his own party a few minutes ago (this is what got resumed by mistake)
                await b['panel'].fill('#name', 'Ben'); await b['panel'].click('#create')
                old_room = await room_of(b['panel'])
                await b['panel'].goto('about:blank')   # Ben closes the panel
                await asyncio.sleep(1)
                await b['watch'].goto(f'{SERVER}/j/{host_room}')
                await wait_for(lambda: b['watch'].is_visible('#join'), 5)
                if order == 'panel-opens-same-moment':
                    await asyncio.gather(b['watch'].click('#join'), b['panel'].goto(panel_url))
                else:
                    await b['panel'].goto(panel_url)   # opens the panel while still on the invite page
                got = await room_of(b['panel'])
                await asyncio.sleep(3)   # make sure nothing switches it afterwards
                final = await b['panel'].evaluate("() => document.getElementById('room-label').textContent")
                check(f'{order}: joins the host party on the first try (not his old one)', got == host_room and host_room in final, f'host={host_room} old={old_room} got={got} final={final}')
                await b['ctx'].close()
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

asyncio.run(main())
