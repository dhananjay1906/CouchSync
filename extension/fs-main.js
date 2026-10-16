// Runs in the page's own JavaScript world. Does nothing unless the CouchSync sidebar is open.
// When it is, a player's fullscreen button makes the whole page fullscreen instead, and the player is
// stretched over everything except the sidebar — so friends and chat stay visible in fullscreen.
(() => {
  if (window.__couchsyncFs) return;
  window.__couchsyncFs = true;
  const root = () => document.documentElement;
  const sidebarOpen = () => root().hasAttribute('data-couchsync-open');
  let target = null; // the element the player wanted fullscreen

  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement');
  const wdesc = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenElement');
  const realFs = () => (desc && desc.get ? desc.get.call(document) : null);

  function wrap(name) {
    const orig = Element.prototype[name];
    if (typeof orig !== 'function') return;
    Element.prototype[name] = function (...args) {
      if (!sidebarOpen() || this === root() || realFs()) return orig.apply(this, args);
      target = this;
      this.classList.add('couchsync-fs-target');
      root().setAttribute('data-couchsync-fs', '1');
      const r = orig.apply(root(), args);
      if (r && r.catch) r.catch(() => cleanup());
      return r;
    };
  }
  wrap('requestFullscreen');
  wrap('webkitRequestFullscreen');
  wrap('webkitRequestFullScreen');

  // Tell the player that *it* is fullscreen, so its own fullscreen button/icon keep working.
  function patch(d) {
    if (!d || !d.get) return;
    const name = d === desc ? 'fullscreenElement' : 'webkitFullscreenElement';
    Object.defineProperty(Document.prototype, name, {
      configurable: true,
      get() { const v = d.get.call(this); return v === root() && target ? target : v; },
    });
  }
  patch(desc);
  patch(wdesc);

  function cleanup() {
    if (target) target.classList.remove('couchsync-fs-target');
    target = null;
    root().removeAttribute('data-couchsync-fs');
  }
  document.addEventListener('fullscreenchange', () => { if (!realFs()) cleanup(); }, true);
  document.addEventListener('webkitfullscreenchange', () => { if (!realFs()) cleanup(); }, true);
})();
