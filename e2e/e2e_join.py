import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, vstate, check, results, ROOT, SERVER, SITE

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha')
            await a['panel'].fill('#name', 'Asha'); await a['panel'].click('#create')
            room = re.search(r'Party (\w+)', await wait_for(lambda: a['panel'].text_content('#room-label'))).group(1)
            await a['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 20; v.play().catch(()=>{}); }")
            await asyncio.sleep(2.5)
            b = await make_user(pw, 'Ben')
            page = b['watch']
            await page.goto(f'{SERVER}/j/{room}')
            vis = await wait_for(lambda: page.is_visible('#join'), 5)
            check('invite page detects the extension', vis is True)
            info = await page.text_content('#info')
            check('invite page shows what is playing', 'Test Movie' in info, info)
            await page.click('#join')
            ok = await wait_for(lambda: page.evaluate("() => location.pathname === '/watch1.html'"), 8)
            check('clicking Join opens the host\'s video', ok is True)
            code = await wait_for(lambda: b['panel'].input_value('#join-code'), 5)
            check('open panel picks up the invite (asks for name first)', room in (code or ''), str(code))
            await b['panel'].fill('#name', 'Ben'); await b['panel'].click('#join')
            async def synced():
                sa, sb = await vstate(a), await vstate(b)
                return not sb['paused'] and abs(sa['t'] - sb['t']) < 1
            ok = await wait_for(synced, 15)
            check('guest is synced after entering name', ok is True)
            bad = await make_user(pw, 'X')
            await bad['watch'].goto(f'{SERVER}/j/zzzzzzzz')
            await asyncio.sleep(1)
            txt = await bad['watch'].text_content('#info')
            check('dead invite link explains itself', 'ended' in txt, txt)
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
asyncio.run(main())

