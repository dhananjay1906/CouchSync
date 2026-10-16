"""Floating faces window + hiding a person's video."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER

async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800'])
    server = start_server()
    await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            a = await make_user(pw, 'Asha'); b = await make_user(pw, 'Ben')
            await a['panel'].fill('#name', 'Asha'); await a['panel'].click('#create')
            room = re.search(r'Party (\w+)', await wait_for(lambda: a['panel'].text_content('#room-label'))).group(1)
            await b['panel'].fill('#name', 'Ben'); await b['panel'].fill('#join-code', f'{SERVER}/j/{room}'); await b['panel'].click('#join')
            ok = await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self) video')].some(v => v.videoWidth > 0)"), 20)
            check('setup: Asha sees Ben', ok is True)

            # hide Ben
            await a['panel'].hover('.tile:not(.self)')
            await a['panel'].click('.tile:not(.self) .tile-hide')
            hidden = await a['panel'].evaluate("() => document.querySelector('.tile:not(.self)').classList.contains('user-hidden')")
            chip = await a['panel'].evaluate("() => !document.getElementById('show-hidden').classList.contains('hidden') && document.getElementById('show-hidden').textContent")
            playing = await a['panel'].evaluate("() => { const v = document.querySelector('.tile:not(.self) video'); return !v.paused && !v.muted; }")
            check("✕ hides a person's video", hidden is True)
            check('…shows a "Show hidden" button', isinstance(chip, str) and '1 hidden' in chip, str(chip))
            check('…and you can still hear them', playing is True)
            await a['panel'].click('#show-hidden')
            back = await a['panel'].evaluate("() => !document.querySelector('.tile:not(.self)').classList.contains('user-hidden')")
            check('"Show hidden" brings them back', back is True)

            # float faces
            await a['panel'].click('#float')
            await asyncio.sleep(1.5)
            mode = await a['panel'].evaluate("""() => {
              const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
              if (w) return { doc: true, gridInPip: !!w.document.getElementById('grid'), tiles: w.document.querySelectorAll('.tile').length,
                               friendPlaying: [...w.document.querySelectorAll('.tile:not(.self) video')].some(v => !v.paused),
                               placeholder: !document.getElementById('float-placeholder').classList.contains('hidden') };
              return { doc: false, classic: !!document.pictureInPictureElement };
            }""")
            print('   float mode:', mode)
            ok = (mode.get('doc') and mode['gridInPip'] and mode['friendPlaying'] and mode['placeholder']) or mode.get('classic')
            check('⧉ floats the faces in an always-on-top window', bool(ok), str(mode))
            # video sync keeps working while floating
            await a['watch'].mouse.click(1100, 650)
            await a['watch'].evaluate("() => { const v = document.querySelector('video'); v.currentTime = 40; v.play().catch(()=>{}); }")
            ok = await wait_for(lambda: b['watch'].evaluate("() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 39; }"), 12)
            check('movie sync keeps working while faces float', ok is True)
            if mode.get('doc'):
                await a['panel'].evaluate("() => window.documentPictureInPicture.window.close()")
                await asyncio.sleep(1)
                back = await a['panel'].evaluate("() => !!document.getElementById('grid') && document.querySelectorAll('#grid .tile').length >= 2 && document.getElementById('float-placeholder').classList.contains('hidden')")
                check('closing the floating window puts faces back in the panel', back is True)
                still = await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('#grid .tile:not(.self) video')].some(v => !v.paused && v.videoWidth > 0)"), 5)
                check('…and their video keeps playing', still is True)
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)
asyncio.run(main())
