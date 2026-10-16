"""Reproduce: friend re-opens the invite link mid-movie -> does playback loop (rewind/pause/play)?"""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER, SITE

async def vstate(u):
    return await u['watch'].evaluate("() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused } : { t: -1, paused: true }; }")

PAGE = os.environ.get('PAGE', 'watch1.html')

async def events(u):
    return await u['panel'].evaluate("() => [...document.querySelectorAll('#chat .msg.sys')].map(e => e.textContent)")

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha'); b = await make_user(pw, 'Ben')
            for u in (a, b):
                await u['watch'].goto(f'{SITE}/{PAGE}'); await asyncio.sleep(1)
                await u['panel'].reload()
            await a['panel'].fill('#name', 'Asha'); await a['panel'].click('#create')
            room = re.search(r'Party (\w+)', await wait_for(lambda: a['panel'].text_content('#room-label'))).group(1)
            await a['watch'].mouse.click(1100, 650)  # a real person clicks first
            await a['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 60; v.play().catch(()=>{}); }")
            await asyncio.sleep(2)
            await b['panel'].fill('#name', 'Ben'); await b['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await b['panel'].click('#join')
            await asyncio.sleep(10)
            if os.environ.get('SLOW'):
                cdp = await b['ctx'].new_cdp_session(b['watch'])
                await cdp.send('Network.enable')
                await cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 300, 'downloadThroughput': 70000, 'uploadThroughput': 70000})
            # Ben watched earlier from 20s, so his player will try to resume there
            await b['watch'].evaluate("() => localStorage.setItem('pos', '20')")
            before = len(await events(a))
            # Ben opens the invite link again (what DJ described)
            await b['watch'].goto(f'{SERVER}/j/{room}')
            await wait_for(lambda: b['watch'].is_visible('#join'), 5)
            await b['watch'].click('#join')
            await wait_for(lambda: b['panel'].input_value('#join-code'), 3)
            if await b['panel'].is_visible('#join'):
                await b['panel'].click('#join')
            # localhost isn't a known streaming site, so the friend clicks "Open it" in the panel
            if await wait_for(lambda: b['panel'].evaluate("() => document.getElementById('banner-text').textContent.includes('localhost')"), 8) is True:
                await b['panel'].click('#banner-action')
            await wait_for(lambda: b['watch'].evaluate("() => !!document.querySelector('video')"), 10)
            samples = []
            for i in range(int(os.environ.get('N', 40))):
                sa, sb = await vstate(a), await vstate(b)
                samples.append((round(sa['t'],1), sa['paused'], round(sb['t'],1), sb['paused']))
                await asyncio.sleep(0.5)
            print('ALL A events:', await events(a)); ev = (await events(a))[before:]
            controls = [e for e in ev if re.search(r'(played|paused|jumped to)', e)]
            print('events after rejoin:', ev)
            print('samples (A t,paused | B t,paused):', samples[::4])
            rewinds = sum(1 for x, y in zip(samples, samples[1:]) if y[0] < x[0] - 1)
            toggles = sum(1 for x, y in zip(samples, samples[1:]) if y[1] != x[1])
            check('no rewinds on host after friend rejoins', rewinds == 0, f'rewinds={rewinds}')
            check('no play/pause flapping', toggles <= 2, f'toggles={toggles}')
            check('rejoin causes no control messages', len(controls) == 0, str(controls))
            ts = samples[-1]
            check('both end up playing in sync', not ts[1] and not ts[3] and abs(ts[0]-ts[2]) < 1.0, str(ts))
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

asyncio.run(main())
