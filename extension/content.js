// CouchSync content script. Runs in every frame of every page, but stays idle
// until the side panel activates the frame that holds the main video.
(() => {
  if (window.__couchsyncLoaded) return;
  window.__couchsyncLoaded = true;

  const HOST = location.hostname;
  const IS_TOP = window === window.top;
  const site =
    /(^|\.)netflix\.com$/.test(HOST) ? 'netflix' :
    /(^|\.)youtube\.com$/.test(HOST) ? 'youtube' :
    /(^|\.)(primevideo|amazon)\.[a-z.]+$/.test(HOST) ? 'prime' :
    /(^|\.)hulu\.com$/.test(HOST) ? 'hulu' :
    /(^|\.)disneyplus\.com$/.test(HOST) ? 'disney' :
    /(^|\.)(max|hbomax)\.com$/.test(HOST) ? 'max' :
    'generic';

  // ---------- join page bridge (the invite link page served by our server) ----------
  if (IS_TOP && document.querySelector('meta[name="couchsync-join"]')) {
    document.documentElement.dataset.couchsyncExt = '1';
    window.addEventListener('message', e => {
      if (e.source !== window || !e.data || e.data.source !== 'couchsync-join-page') return;
      chrome.runtime.sendMessage({ bg: 'join-page', room: e.data.room, server: e.data.server, media: e.data.media });
    });
  }

  // ---------- state ----------
  let video = null;
  let active = false;       // panel chose this frame as the party video
  let target = null;        // { playing, position, at, rate, seq }
  let clockOffset = 0;      // serverTime - Date.now()
  let mediaDuration = 0;    // host's video length, used to spot ads
  let ourRate = null;       // playbackRate we set ourselves (drift nudges)
  let lastSeekTarget = null, lastSeekAt = 0;
  let buffering = false, waitingTimer = null;
  let ad = false;
  let blocked = false;      // autoplay blocked; needs a click
  let duckOn = false, duckSavedVolume = null;
  let lastReportKey = '';

  const serverNow = () => Date.now() + clockOffset;
  function expected() {
    if (!target) return null;
    const p = target.playing ? target.position + ((serverNow() - target.at) / 1000) * target.rate : target.position;
    return Math.max(0, p);
  }

  // ---------- finding the main video (including inside shadow DOM, which Disney+ and others use) ----------
  function collectVideos(root, out, depth = 0) {
    if (!root || depth > 12) return out;
    root.querySelectorAll('video').forEach(v => out.push(v));
    const all = root.querySelectorAll('*');
    for (const el of all) {
      let sr = el.shadowRoot;
      if (!sr && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        try { sr = chrome.dom.openOrClosedShadowRoot(el); } catch { sr = null; }
      }
      if (sr) collectVideos(sr, out, depth + 1);
    }
    return out;
  }

  function videoArea(v) {
    const r = v.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && getComputedStyle(v).visibility !== 'hidden';
    return visible ? r.width * r.height : 0;
  }

  let lastDeepScan = 0, deepCache = [];
  function pickVideo() {
    let vids = Array.from(document.querySelectorAll('video'));
    // Shadow-DOM scan is slower, so only do it when the light DOM has nothing (e.g. Disney+), at most every 3s.
    if (!vids.some(v => videoArea(v) >= 200 * 100) && Date.now() - lastDeepScan > 3000) {
      lastDeepScan = Date.now();
      vids = collectVideos(document, []);
      deepCache = vids;
    } else if (!vids.length) {
      vids = deepCache.filter(v => v.isConnected);
    }
    let best = null, bestScore = 0;
    for (const v of vids) {
      const area = videoArea(v);
      if (area < 200 * 100) continue; // ignore thumbnails/previews
      let score = area;
      if (v.readyState > 0 || v.currentSrc) score *= 2;
      if (!v.paused) score *= 1.5;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  const EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'waiting', 'playing', 'canplay', 'stalled', 'loadedmetadata', 'emptied'];
  function attach(v) {
    if (video === v) return;
    if (video) EVENTS.forEach(ev => video.removeEventListener(ev, onVideoEvent));
    video = v;
    ourRate = null;
    if (video) {
      EVENTS.forEach(ev => video.addEventListener(ev, onVideoEvent));
      if (active && target) applyTarget(true);
    }
  }

  // ---------- site adapters ----------
  function detectAd() {
    try {
      if (site === 'youtube') {
        const p = document.querySelector('#movie_player');
        if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) return true;
      }
      if (site === 'prime') {
        const t = document.querySelector('.atvwebplayersdk-ad-timer-text, .atvwebplayersdk-adtimeindicator-text');
        if (t && t.offsetParent !== null && t.textContent.trim()) return true;
      }
      if (site === 'hulu') {
        const t = document.querySelector('.AdUnitView, .ad-container, [class*="AdBadge"]');
        if (t && t.offsetParent !== null) return true;
      }
    } catch {}
    // Generic heuristic: party is watching a long title, but this player is showing a short clip.
    if (video && mediaDuration > 900 && Number.isFinite(video.duration) && video.duration > 0 && video.duration < 240) return true;
    return false;
  }

  function nativeSeek(t) {
    lastSeekTarget = t; lastSeekAt = Date.now();
    if (site === 'netflix') {
      // Setting video.currentTime on Netflix triggers error M7375; use its player API from the page world.
      window.postMessage({ source: 'couchsync-cs', cmd: 'seek', ms: Math.round(t * 1000) }, '*');
      return;
    }
    try { video.currentTime = t; } catch {}
  }

  let expectPlayUntil = 0, expectPauseUntil = 0;
  function nativePlay() {
    if (!video) return;
    expectPlayUntil = Date.now() + 1500;
    const p = video.play();
    if (p && p.catch) p.catch(err => {
      if (err && err.name === 'NotAllowedError') showBlocked();
    });
  }
  function nativePause() { expectPauseUntil = Date.now() + 1500; try { video && video.pause(); } catch {} }
  function setRate(r) {
    if (!video) return;
    ourRate = r;
    try { if (Math.abs(video.playbackRate - r) > 0.001) video.playbackRate = r; } catch {}
  }

  // ---------- applying the party state ----------
  function applyTarget(force) {
    if (!active || !video || !target || ad) return;
    const exp = expected();
    const dur = video.duration;
    const live = !Number.isFinite(dur);
    if (!live && dur > 0 && exp >= dur - 0.5) { if (!video.paused && !target.playing) nativePause(); return; }

    if (!live) {
      const diff = video.currentTime - exp;
      if (Math.abs(diff) > (force ? 0.75 : 1.5)) nativeSeek(exp);
    }
    if (target.playing && video.paused) nativePlay();
    if (!target.playing && !video.paused) nativePause();
    if (ourRate === null || Math.abs(ourRate - target.rate) > 0.001) setRate(target.rate);
  }

  // Gentle drift correction: nudge speed for small drift, seek for big drift.
  function driftCheck() {
    if (!active || !video || !target || ad || buffering || blocked) return;
    if (Date.now() - lastSeekAt < 3000) return;
    const dur = video.duration;
    if (!Number.isFinite(dur) || video.readyState < 3) return;
    const exp = expected();
    if (exp >= dur - 0.5) return;
    const diff = video.currentTime - exp;
    if (!target.playing) {
      if (!video.paused) nativePause();
      if (Math.abs(diff) > 0.5) nativeSeek(exp);
      return;
    }
    if (video.paused) { nativePlay(); return; }
    if (Math.abs(diff) > 1.5) nativeSeek(exp);
    else if (Math.abs(diff) > 0.25) setRate(target.rate * (diff > 0 ? 0.93 : 1.07));
    else if (Math.abs(diff) < 0.1 && Math.abs(video.playbackRate - target.rate) > 0.001) setRate(target.rate);
  }

  // ---------- local user actions → party ----------
  function emit(action, extra) {
    if (!active || !target || ad) return;
    const position = video ? video.currentTime : 0;
    // Optimistic local update so drift correction doesn't fight the user before the server echoes back.
    const t = serverNow();
    if (action === 'play') target = { ...target, playing: true, position, at: t };
    else if (action === 'pause') target = { ...target, playing: false, position, at: t };
    else if (action === 'seek') target = { ...target, position, at: t };
    else if (action === 'rate') target = { ...target, position, at: t, rate: extra.rate };
    chrome.runtime.sendMessage({ cs: 'event', action, position, ...extra }).catch(() => {});
  }

  function onVideoEvent(e) {
    const v = e.target;
    if (v !== video) return;
    switch (e.type) {
      case 'play':
        hideBlocked();
        if (Date.now() < expectPlayUntil) { expectPlayUntil = 0; break; } // we started it
        if (target && !target.playing) emit('play');
        break;
      case 'pause':
        if (Date.now() < expectPauseUntil) { expectPauseUntil = 0; break; } // we paused it
        if (target && target.playing && !v.ended && !buffering) emit('pause');
        break;
      case 'seeked': {
        const exp = expected();
        const ours = lastSeekTarget !== null && Date.now() - lastSeekAt < 4000 && Math.abs(v.currentTime - lastSeekTarget) < 1.5;
        if (!ours && exp !== null && Math.abs(v.currentTime - exp) > 2) emit('seek');
        break;
      }
      case 'ratechange':
        if (ourRate !== null && Math.abs(v.playbackRate - ourRate) > 0.01 && target && Math.abs(v.playbackRate - target.rate) > 0.01) {
          ourRate = v.playbackRate;
          emit('rate', { rate: v.playbackRate });
        }
        break;
      case 'waiting':
      case 'stalled':
        clearTimeout(waitingTimer);
        waitingTimer = setTimeout(() => { if (video && video.readyState < 3) { buffering = true; report(true); } }, 1000);
        break;
      case 'playing':
      case 'canplay':
        clearTimeout(waitingTimer);
        if (buffering) { buffering = false; report(true); }
        if (e.type === 'canplay' && active) applyTarget(false);
        break;
      case 'loadedmetadata':
      case 'emptied':
        if (active) setTimeout(() => applyTarget(true), 300);
        break;
    }
  }

  // ---------- autoplay-blocked prompt ----------
  let blockedEl = null;
  function showBlocked() {
    blocked = true;
    chrome.runtime.sendMessage({ cs: 'autoplay-blocked' }).catch(() => {});
    if (blockedEl) return;
    blockedEl = document.createElement('div');
    const sr = blockedEl.attachShadow({ mode: 'closed' });
    sr.innerHTML = `<style>
      button{all:initial;position:fixed;z-index:2147483647;left:50%;top:50%;transform:translate(-50%,-50%);
      background:#ff6b4a;color:#fff;font:600 18px system-ui,sans-serif;padding:16px 26px;border-radius:12px;cursor:pointer;
      box-shadow:0 8px 30px rgba(0,0,0,.5)}</style><button>▶ Click to sync with your party</button>`;
    sr.querySelector('button').addEventListener('click', ev => {
      ev.stopPropagation();
      hideBlocked();
      if (target && target.playing) nativePlay();
      applyTarget(true);
    });
    (document.fullscreenElement || document.body || document.documentElement).appendChild(blockedEl);
  }
  function hideBlocked() {
    blocked = false;
    if (blockedEl) { blockedEl.remove(); blockedEl = null; }
  }

  // ---------- duck movie volume while friends talk ----------
  function setDuck(on) {
    if (!video || on === duckOn) return;
    duckOn = on;
    if (on) { duckSavedVolume = video.volume; video.volume = Math.max(0, video.volume * 0.35); }
    else if (duckSavedVolume !== null) { video.volume = duckSavedVolume; duckSavedVolume = null; }
  }

  // ---------- status to panel ----------
  function report(forceSend) {
    const has = !!video;
    const status = {
      cs: 'status',
      top: IS_TOP,
      site,
      hasVideo: has,
      area: has ? videoArea(video) : 0,
      currentTime: has ? video.currentTime : 0,
      duration: has && Number.isFinite(video.duration) ? video.duration : 0,
      paused: has ? video.paused : true,
      buffering, ad, blocked,
      title: IS_TOP ? document.title : '',
    };
    const key = `${has}|${buffering}|${ad}|${blocked}`;
    if (!has && !forceSend && lastReportKey === key) return; // frames without video stay quiet
    lastReportKey = key;
    chrome.runtime.sendMessage(status).catch(() => {});
  }

  // ---------- panel → content ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.cs) return;
    switch (msg.cs) {
      case 'ping': sendResponse({ ok: true, hasVideo: !!video }); return;
      case 'snapshot':
        sendResponse(video ? { hasVideo: true, currentTime: video.currentTime, paused: video.paused, duration: Number.isFinite(video.duration) ? video.duration : 0 } : { hasVideo: false });
        return;
      case 'activate':
        active = !!msg.active;
        if (!active) { setDuck(false); hideBlocked(); if (video && ourRate !== null && target) setRate(target.rate); }
        else applyTarget(true);
        break;
      case 'state':
        target = msg.state;
        clockOffset = msg.offset || 0;
        mediaDuration = msg.mediaDuration || 0;
        // Host just started a new title: their player (e.g. autoplaying next episode) is the source of truth.
        if (msg.hostAuthority && active && video && !ad) {
          const exp = expected();
          if (!video.paused && !target.playing) { emit('play'); break; }
          if (Number.isFinite(video.duration) && Math.abs(video.currentTime - exp) > 1.5) { emit('seek'); break; }
        }
        applyTarget(!!msg.force);
        break;
      case 'duck': if (active) setDuck(!!msg.on); break;
      case 'status': report(true); break;
      case 'deactivate-all': active = false; target = null; setDuck(false); hideBlocked(); break;
    }
    sendResponse && sendResponse({ ok: true });
  });

  // ---------- main loop ----------
  setInterval(() => {
    const v = pickVideo();
    if (v !== video) attach(v);
    const wasAd = ad;
    ad = !!video && detectAd();
    if (ad !== wasAd) {
      report(true);
      if (!ad && active) setTimeout(() => applyTarget(true), 500);
    }
    driftCheck();
    if (video || lastReportKey.startsWith('true')) report(false);
  }, 1000);
})();
