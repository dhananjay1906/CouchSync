// Runs in Netflix's own page context so we can use its player API.
// Netflix crashes (error M7375) if you set <video>.currentTime directly.
(() => {
  if (window.__couchsyncNetflix) return;
  window.__couchsyncNetflix = true;

  function getPlayer() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find(s => s.startsWith('watch')) || ids[ids.length - 1];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch {
      return null;
    }
  }

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'couchsync-cs') return;
    const p = getPlayer();
    if (!p) return;
    try {
      if (e.data.cmd === 'seek' && Number.isFinite(e.data.ms)) p.seek(e.data.ms);
      else if (e.data.cmd === 'play') p.play();
      else if (e.data.cmd === 'pause') p.pause();
    } catch { /* player not ready yet; the content script will retry on its next drift check */ }
  });
})();
