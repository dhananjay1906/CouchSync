import asyncio, os, subprocess
from playwright.async_api import async_playwright
from e2e import make_user, start_server, ROOT
async def main():
    static = subprocess.Popen(['node', os.path.join(ROOT, 'static.js'), '8800']); server = start_server(); await asyncio.sleep(1)
    try:
        async with async_playwright() as pw:
            b = await make_user(pw, 'Ben')
            sw = b['ctx'].service_workers[0]
            await b['panel'].evaluate("() => chrome.runtime.sendMessage({ bg: 'test-force-window', on: true })")
            await asyncio.sleep(0.5)
            print('forceWindow', await sw.evaluate("forceWindow"), 'hasSidePanel', await sw.evaluate("hasSidePanel"))
            r = await sw.evaluate("""async () => { try { const [t] = await chrome.tabs.query({}); await openPanelWindow(t); return 'ok ' + panelWindowId; } catch (e) { return 'ERR ' + e.message; } }""")
            print(r); await asyncio.sleep(1)
            print([p.url for p in b['ctx'].pages])
    finally:
        server.kill(); static.kill()
asyncio.run(main())
