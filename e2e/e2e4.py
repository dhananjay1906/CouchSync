"""4 friends: everyone sees 3 faces, playback stays in sync, a 5th person is turned away."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, vstate, check, results, ROOT, SERVER

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            names = ['Asha', 'Ben', 'Cy', 'Dee']
            users = [await make_user(pw, n) for n in names]
            host = users[0]
            await host['panel'].fill('#name', 'Asha')
            await host['panel'].click('#create')
            label = await wait_for(lambda: host['panel'].text_content('#room-label'))
            room = re.search(r'Party (\w+)', label).group(1)
            await host['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 50; v.play().catch(()=>{}); }")
            await asyncio.sleep(2)
            for u in users[1:]:
                await u['panel'].fill('#name', u['name'])
                await u['panel'].fill('#join-code', f'{SERVER}/j/{room}')
                await u['panel'].click('#join')
            async def all_sync():
                st = [await vstate(u) for u in users]
                ts = [s['t'] for s in st]
                return all(not s['paused'] for s in st) and max(ts) - min(ts) < 1.0
            ok = await wait_for(all_sync, 20)
            st = [round((await vstate(u))['t'], 2) for u in users]
            check('4 people playing in sync (<1s spread)', ok is True, str(st))

            async def faces(u):
                return await u['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self) video')].filter(v => v.videoWidth > 0).length")
            async def all_faces():
                return all([(await faces(u)) == 3 for u in users])
            ok = await wait_for(all_faces, 30)
            counts = [await faces(u) for u in users]
            check('everyone sees all 3 friends live', ok is True, str(counts))

            await users[2]['watch'].evaluate("() => document.querySelector('video').pause()")
            async def all_paused():
                return all([(await vstate(u))['paused'] for u in users])
            ok = await wait_for(all_paused, 6)
            check('any friend pausing pauses all 4', ok is True)

            fifth = await make_user(pw, 'Eve')
            await fifth['panel'].fill('#name', 'Eve')
            await fifth['panel'].fill('#join-code', f'{SERVER}/j/{room}')
            await fifth['panel'].click('#join')
            err = await wait_for(lambda: fifth['panel'].evaluate("() => { const e = document.getElementById('start-error'); return !e.classList.contains('hidden') && e.textContent; }"), 8)
            check('5th person gets a clear "party is full" message', isinstance(err, str) and 'full' in err, str(err))

            await users[3]['panel'].set_viewport_size({'width': 380, 'height': 780})
            await users[0]['panel'].fill('#chat-input', 'this scene 😂')
            await users[0]['panel'].press('#chat-input', 'Enter')
            await users[1]['panel'].click('.reactions button[data-r="🔥"]')
            await asyncio.sleep(1.5)
            await users[3]['panel'].screenshot(path=os.path.join(ROOT, 'panel-4.png'))
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

asyncio.run(main())
