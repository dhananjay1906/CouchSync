"""Friends' audio actually arrives and plays (not muted, not paused)."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
from e2e import make_user, start_server, wait_for, check, results, ROOT, SERVER

AUDIO = """async () => {
  const out = [];
  for (const t of document.querySelectorAll('.tile:not(.self)')) {
    const v = t.querySelector('video'); const s = v.srcObject;
    out.push({ hasAudio: !!(s && s.getAudioTracks().some(a => a.readyState === 'live')), muted: v.muted, paused: v.paused, volume: v.volume });
  }
  return out;
}"""

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
            for u, other in ((a, 'Ben'), (b, 'Asha')):
                st = await wait_for(lambda: _ok(u), 20)
                info = await u['panel'].evaluate(AUDIO)
                check(f"{u['name']} receives and plays {other}'s mic", st is True, str(info))
            # Audio level actually moving (fake mic is a beeping tone) -> speaking ring lights up
            ok = await wait_for(lambda: a['panel'].evaluate("() => [...document.querySelectorAll('.tile:not(.self)')].some(t => t.classList.contains('speaking'))"), 10, 0.1)
            check("friend's voice level is detected (green ring)", ok is True)
            # Muting on B stops the ring on A
            await b['panel'].click('#toggle-mic')
            await asyncio.sleep(2)
            icon = await a['panel'].evaluate("() => document.querySelector('.tile:not(.self) .icons').textContent")
            check('muting shows 🔇 on friend side', '🔇' in icon, icon)
    finally:
        server.kill(); static.kill()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

async def _ok(u):
    info = await u['panel'].evaluate(AUDIO)
    return bool(info) and all(i['hasAudio'] and not i['muted'] and not i['paused'] and i['volume'] > 0 for i in info)

asyncio.run(main())
