"""In-page sidebar (Teleparty-style): open, invite, sync, video, collapse, fullscreen, reload, embed protection."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER, SITE

def sw_of(u):
    return u['ctx'].service_workers[0]

async def tab_id(u, page):
    url = page.url
    return await sw_of(u).evaluate("async (url) => (await chrome.tabs.query({})).find(t => t.url === url)?.id", url)

async def toggle(u, page, mode='toggle'):
    tid = await tab_id(u, page)
    await sw_of(u).evaluate("async ([id, mode]) => toggleSidebar(await chrome.tabs.get(id), mode)", [tid, mode])

async def side(page, timeout=10):
    async def f():
        return next((fr for fr in page.frames if 'panel.html?embed=1' in fr.url), None)
    return await wait_for(f, timeout)

async def vstate(page):
    return await page.evaluate("() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused } : { t: -1, paused: true }; }")

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha'); b = await make_user(pw, 'Ben')
            for u in (a, b):
                await u['panel'].goto('about:blank')   # no separate panel tab: everything happens in the page
            A, B = a['watch'], b['watch']

            # ---- open the sidebar on the video page
            await toggle(a, A)
            fa = await side(A)
            check('toolbar button opens the sidebar inside the page', fa is not None)
            W = await A.evaluate("() => innerWidth")
            bw = await A.evaluate("() => document.body.getBoundingClientRect().width")
            check('the page shrinks to make room for it', abs((W - 360) - bw) < 30, f'viewport={W} body={bw}')
            await fa.fill('#name', 'Asha'); await fa.click('#create')
            label = await wait_for(lambda: fa.evaluate("() => !document.getElementById('party').classList.contains('hidden') && document.getElementById('room-label').textContent"), 10)
            room = re.search(r'Party (\w+)', label).group(1)
            check('party starts from the sidebar', bool(room))
            await A.mouse.click(300, 650)
            await A.evaluate("() => { const v = document.querySelector('video'); v.currentTime = 30; v.play().catch(()=>{}); }")
            await asyncio.sleep(2)

            # ---- friend opens the invite link
            await sw_of(b).evaluate("() => chrome.storage.local.set({ name: 'Ben' })")
            await B.goto(f'{SERVER}/j/{room}')
            await wait_for(lambda: B.is_visible('#join'), 5)
            await B.click('#join')
            fb = await side(B)
            check('invite: sidebar opens in the friend\'s page', fb is not None)
            lab = await wait_for(lambda: fb.evaluate("() => !document.getElementById('party').classList.contains('hidden') && document.getElementById('room-label').textContent"), 12)
            check('invite: friend joins the party on the first click', isinstance(lab, str) and room in lab, str(lab))
            if await wait_for(lambda: fb.evaluate("() => document.getElementById('banner-text').textContent.includes('localhost')"), 8) is True:
                await fb.click('#banner-action')
            await asyncio.sleep(2)
            fb = await side(B, 15)
            check('after going to the video page the sidebar is back by itself', fb is not None)
            async def synced():
                sa, sb2 = await vstate(A), await vstate(B)
                return not sb2['paused'] and abs(sa['t'] - sb2['t']) < 1.0
            ok = await wait_for(synced, 25)
            sa, sb2 = await vstate(A), await vstate(B)
            check('movie syncs between the two pages', ok is True, f'A={sa} B={sb2}')
            fa = await side(A)
            ok = await wait_for(lambda: fa.evaluate("() => [...document.querySelectorAll('.tile:not(.self) video')].some(v => v.videoWidth > 0)"), 25)
            check('video chat works inside the sidebar', ok is True)

            # ---- collapse to floating faces, hide, reopen
            await fa.click('#collapse')
            await asyncio.sleep(1)
            mode = await A.evaluate("() => document.documentElement.getAttribute('data-couchsync-open')")
            mini = await fa.evaluate("() => document.body.classList.contains('mini') && [...document.querySelectorAll('.tile:not(.self) video')].some(v => !v.paused && v.videoWidth > 0)")
            bw2 = await A.evaluate("() => document.body.getBoundingClientRect().width")
            check('|→ collapses to floating faces over the full-width video', mode == 'mini' and mini is True and abs(bw2 - W) < 5, f'mode={mode} mini={mini} body={bw2}')
            fe = await fa.frame_element()
            fbox = await fe.bounding_box()
            # the floating box's buttons sit in a bar just above the faces: [⇤][🎙️][📷][✕]
            def btn(i): return (fbox['x'] + 6 + i * 34 + 15, fbox['y'] - 16)
            await A.bring_to_front(); await asyncio.sleep(0.3)
            mic0 = await fa.evaluate("() => !document.getElementById('toggle-mic').classList.contains('off')")
            await A.mouse.click(*btn(1)); await asyncio.sleep(0.8)
            mic1 = await fa.evaluate("() => !document.getElementById('toggle-mic').classList.contains('off')")
            check('floating 🎙️ button mutes with a real mouse click', mic0 != mic1, f'{mic0}->{mic1}')
            await A.mouse.click(*btn(1)); await asyncio.sleep(0.8)
            await A.mouse.click(*btn(3)); await asyncio.sleep(1.0)
            mode = await A.evaluate("() => document.documentElement.getAttribute('data-couchsync-open')")
            still = await fa.evaluate("() => [...document.querySelectorAll('.tile:not(.self) video')].some(v => !v.paused)")
            check('✕ hides the faces completely (call keeps running)', mode == 'hidden' and still is True, f'mode={mode}')
            await toggle(a, A)
            await asyncio.sleep(0.5)
            mode = await A.evaluate("() => document.documentElement.getAttribute('data-couchsync-open')")
            check('toolbar button brings the full sidebar back', mode == 'open')
            ok = await wait_for(synced, 10)
            check('sync unaffected by collapsing/expanding', ok is True)

            # ---- fullscreen keeps the sidebar visible
            await A.evaluate("""() => { const b = document.createElement('button'); b.id = 'fsbtn'; b.textContent = 'fs';
                b.style.cssText = 'position:fixed;left:10px;top:600px;z-index:5';
                b.onclick = () => document.querySelector('video').requestFullscreen(); document.body.append(b); }""")
            await A.bring_to_front()
            await A.click('#fsbtn')
            await asyncio.sleep(1.5)
            fs = await A.evaluate("""() => ({ fs: !!document.fullscreenElement, reported: document.fullscreenElement === document.querySelector('video'),
                attr: document.documentElement.hasAttribute('data-couchsync-fs'),
                vw: document.querySelector('video').getBoundingClientRect().width, iw: innerWidth })""")
            print('   fullscreen:', fs)
            check('player fullscreen keeps the sidebar visible next to the video', fs['fs'] and fs['attr'] and abs(fs['vw'] - (fs['iw'] - 360)) < 30, str(fs))
            check("…and the player still thinks it's fullscreen (its button keeps working)", fs['reported'] is True)
            await A.evaluate("() => document.exitFullscreen()")
            await asyncio.sleep(1)
            back = await A.evaluate("() => !document.fullscreenElement && !document.documentElement.hasAttribute('data-couchsync-fs')")
            check('Esc / exit fullscreen restores the page', back is True)

            # ---- reload keeps you in the party
            await A.reload()
            fa = await side(A, 15)
            lab = await wait_for(lambda: fa.evaluate("() => !document.getElementById('party').classList.contains('hidden') && document.getElementById('room-label').textContent"), 15) if fa else None
            check('reloading the page reopens the sidebar in the same party', isinstance(lab, str) and room in lab, str(lab))
            await wait_for(lambda: fa.evaluate("() => document.getElementById('sync-status').textContent.includes('In sync')"), 20)
            await A.mouse.click(300, 650)
            await A.evaluate("() => document.querySelector('video').pause()")
            ok = await wait_for(lambda: B.evaluate("() => document.querySelector('video').paused"), 10)
            check('sync still works after the reload', ok is True)

            # ---- other websites can't use the panel
            ext = (await side(B)).url.split('/')[2]
            await B.evaluate(f"""() => {{ const f = document.createElement('iframe'); f.id='evil'; f.src = 'chrome-extension://{ext}/panel.html?embed=1&tabId=1#forged'; document.body.append(f); }}""")
            await asyncio.sleep(2)
            evil = next((fr for fr in B.frames if fr.url.endswith('#forged')), None)
            txt = await evil.evaluate("() => document.body.innerText") if evil else 'not loaded'
            check('a website framing the panel itself gets nothing', 'only be opened' in txt or txt == 'not loaded', txt[:80])
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
if __name__ == "__main__":
    asyncio.run(main())
