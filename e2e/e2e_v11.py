"""Tests for the v1.1 fixes, in real Chrome with the extension."""
import asyncio, os, re, subprocess, sys
os.environ.setdefault('EXTRA_CHROME_ARGS', '--host-resolver-rules=MAP www.amazon.test 127.0.0.1')
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER, SITE

PRIME = 'http://www.amazon.test:8800/gp/video/detail/B0TESTTEST1'


async def vstate(u):
    return await u['watch'].evaluate("() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused, src: location.pathname, dur: v.duration } : { t: -1, paused: true }; }")


async def chat(u):
    return await u['panel'].inner_text('#chat')


async def party(pw, names, page=None):
    users = [await make_user(pw, n) for n in names]
    if page:
        for u in users:
            await u['watch'].goto(page)
            await asyncio.sleep(1)
    host = users[0]
    await host['panel'].fill('#name', names[0])
    await host['panel'].click('#create')
    room = re.search(r'Party (\w+)', await wait_for(lambda: host['panel'].text_content('#room-label'))).group(1)
    await host['watch'].mouse.click(1100, 650)
    await host['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 30; v.play().catch(()=>{}); }")
    await asyncio.sleep(2)
    for u in users[1:]:
        await u['panel'].fill('#name', u['name'])
        await u['panel'].fill('#join-code', f'{SERVER}/j/{room}')
        await u['panel'].click('#join')
    async def synced():
        st = [await vstate(u) for u in users]
        ts = [x['t'] for x in st]
        return all(not x['paused'] for x in st) and max(ts) - min(ts) < 1.0
    ok = await wait_for(synced, 20)
    return users, room, ok is True


async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            # ---------------------------------------------------------------- media keys / still watching
            (a, b), room, ok = await party(pw, ['Asha', 'Ben'], f'{SITE}/watch1.html')
            check('setup: two people in sync', ok)
            await asyncio.sleep(5)  # well past the page-load window
            # Ben presses the pause key on his keyboard/headphones: no click reaches the page
            await b['watch'].evaluate("() => document.querySelector('video').pause()")
            ok = await wait_for(lambda: _paused(a), 6)
            check('media-key pause (no click) pauses everyone', ok is True)
            check('…and is shown as Ben pausing', 'Ben paused' in await chat(a))
            await b['watch'].evaluate("() => document.querySelector('video').play()")
            ok = await wait_for(lambda: _playing(a), 6)
            check('media-key play resumes everyone', ok is True)

            # "Are you still watching?": the site keeps re-pausing its player
            await asyncio.sleep(3)
            await b['watch'].evaluate("""() => { window.__plays = 0; const v = document.querySelector('video');
                v.addEventListener('play', () => { window.__plays++; setTimeout(() => v.pause(), 50); });
                v.pause(); }""")
            await asyncio.sleep(10)
            plays = await b['watch'].evaluate("() => window.__plays")
            check('"still watching" prompt: no pause/play fight', plays <= 2, f'play attempts={plays}')
            check('"still watching" prompt: friends wait (party pauses)', await _paused(a) is True)

            # ---------------------------------------------------------------- host-only
            await b['watch'].reload(); await asyncio.sleep(2)
            ok = await wait_for(lambda: b['panel'].evaluate("() => document.getElementById('sync-status').textContent.includes('In sync') || document.getElementById('sync-status').textContent.includes('Waiting')"), 15)
            check('refreshing the video page re-syncs by itself', ok is True)
            await a['watch'].mouse.click(1100, 650)
            await a['watch'].evaluate("() => document.querySelector('video').play()")
            await wait_for(lambda: _playing(b), 15)
            await a['panel'].click('#open-settings')
            await a['panel'].check('#set-hostonly')
            await a['panel'].click('#close-settings')
            await asyncio.sleep(1)
            await b['watch'].mouse.click(1100, 650)
            await b['watch'].evaluate("() => document.querySelector('video').pause()")
            await asyncio.sleep(3)
            sb, sa = await vstate(b), await vstate(a)
            check("host-only: a guest's pause is undone (stays with the party)", not sb['paused'] and not sa['paused'] and abs(sa['t'] - sb['t']) < 1.5, f'A={sa} B={sb}')
            check('host-only: guest is told why', 'Only the host' in await chat(b))
            await a['panel'].click('#open-settings'); await a['panel'].uncheck('#set-hostonly'); await a['panel'].click('#close-settings')

            # ---------------------------------------------------------------- two windows, same person
            panel2 = await b['ctx'].new_page()
            await panel2.goto(b['panel'].url)   # opening the panel again rejoins the party by itself
            await asyncio.sleep(8)
            old_banner = await b['panel'].evaluate("() => document.getElementById('banner-text').textContent")
            ok2 = await panel2.evaluate("() => document.getElementById('conn-dot').classList.contains('ok')")
            n_members = await a['panel'].evaluate("() => document.querySelectorAll('#members .member').length")
            check('second window: old one stops and says so (no reconnect loop)', 'another window' in old_banner, old_banner)
            check('second window: new one stays connected', ok2 is True)
            members_txt = await a['panel'].evaluate("() => { document.getElementById('open-settings').click(); return document.getElementById('members').innerText; }")
            await a['panel'].click('#close-settings')
            check('second window: still counted as one person', members_txt.count('Ben') == 1, members_txt)
            await panel2.close()

            # ---------------------------------------------------------------- remove + lock
            c = await make_user(pw, 'Cy')
            await c['panel'].fill('#name', 'Cy'); await c['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await c['panel'].click('#join')
            await wait_for(lambda: a['panel'].evaluate("() => document.getElementById('chat').innerText.includes('Cy joined')"), 10)
            await a['panel'].click('#open-settings')
            await a['panel'].locator('.member', has_text='Cy').locator('button.danger').click()
            await a['panel'].locator('.member', has_text='Cy').locator('button', has_text='Sure?').click()
            err = await wait_for(lambda: c['panel'].evaluate("() => { const e = document.getElementById('start-error'); return !e.classList.contains('hidden') && e.textContent; }"), 8)
            check('host can remove someone; they are told', isinstance(err, str) and 'removed' in err, str(err))
            await c['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await c['panel'].click('#join')
            err = await wait_for(lambda: c['panel'].evaluate("() => { const e = document.getElementById('start-error'); return !e.classList.contains('hidden') && e.textContent; }"), 8)
            check('removed person cannot come back', isinstance(err, str) and 'removed' in err, str(err))
            await a['panel'].check('#set-lock')
            await a['panel'].click('#close-settings')
            d = await make_user(pw, 'Dee')
            await d['panel'].fill('#name', 'Dee'); await d['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await d['panel'].click('#join')
            err = await wait_for(lambda: d['panel'].evaluate("() => { const e = document.getElementById('start-error'); return !e.classList.contains('hidden') && e.textContent; }"), 8)
            check('locked party turns newcomers away', isinstance(err, str) and 'locked' in err, str(err))

            # ---------------------------------------------------------------- idle tabs sleep
            await d['panel'].evaluate("() => { window.__status = 0; chrome.runtime.onMessage.addListener(m => { if (m && m.cs === 'status') window.__status++; }); }")
            await d['watch'].mouse.click(1100, 650)
            await d['watch'].evaluate("() => document.querySelector('video').play()")
            await asyncio.sleep(6)
            n = await d['panel'].evaluate("() => window.__status")
            check('not in a party: video tabs stay idle (no scanning/messages)', n == 0, f'status messages={n}')

            # ---------------------------------------------------------------- panel closed
            kids_before = await b['watch'].evaluate("() => document.body.children.length")
            await b['panel'].close()
            await asyncio.sleep(16)
            kids_after = await b['watch'].evaluate("() => document.body.children.length")
            check('closing the panel shows a "you are no longer synced" notice on the video', kids_after == kids_before + 1, f'{kids_before}->{kids_after}')

            # ---------------------------------------------------------------- editions differ
            for u in (a, c, d):
                await u['ctx'].close()
            (e, f), room2, ok = await party(pw, ['Eve', 'Finn'], f'{SITE}/mv.html')
            await f['watch'].evaluate("() => localStorage.setItem('short', '1')")
            await f['watch'].reload(); await asyncio.sleep(3)
            txt = await wait_for(lambda: e['panel'].evaluate("() => document.getElementById('chat').innerText.includes('different versions') && document.getElementById('chat').innerText"), 15)
            check("different video lengths are flagged", isinstance(txt, str), '')
            for u in (e, f):
                await u['ctx'].close()

            # ---------------------------------------------------------------- Prime-style episodes on one URL
            (g, h), room3, ok = await party(pw, ['Gia', 'Hal'], PRIME)
            check('prime-style page: in sync on episode 1', ok)
            early = await h['panel'].inner_text('#chat')
            check('no false "host switched" message on joining', 'Host switched' not in early)
            await g['watch'].mouse.click(1100, 650)
            await g['watch'].evaluate("() => { window.nextEp(); document.querySelector('video').play().catch(()=>{}); }")
            told = await wait_for(lambda: h['panel'].evaluate("() => document.getElementById('chat').innerText.includes('S1 E2. Pick it') && document.getElementById('chat').innerText"), 15)
            check('friend is told the host switched episode (same URL)', isinstance(told, str) and 'E2' in told, (told or '')[-160:] if isinstance(told, str) else str(told))
            await h['watch'].mouse.click(1100, 650)
            await h['watch'].evaluate("() => { window.nextEp(); }")
            async def ep2_synced():
                sg, sh = await vstate(g), await vstate(h)
                return not sg['paused'] and not sh['paused'] and abs(sg['t'] - sh['t']) < 1.0
            ok = await wait_for(ep2_synced, 25)
            sg, sh = await vstate(g), await vstate(h)
            check('after the friend picks episode 2, both play it in sync', ok is True, f'G={sg} H={sh}')
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


async def _paused(u):
    return (await vstate(u))['paused']


async def _playing(u):
    return not (await vstate(u))['paused']

asyncio.run(main())
