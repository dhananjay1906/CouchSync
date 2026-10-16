// CouchSync service worker.
// The panel lives inside the web page (a sidebar on the right, like Teleparty), so it works the same in
// Chrome, Edge, Brave and Opera. The toolbar button toggles it on the current tab.

// Make sure clicking the toolbar icon reaches us (not Chrome's side panel).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

async function sendToTop(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

// Open/close the sidebar in a tab. Tabs opened before the extension was installed get the script injected.
async function toggleSidebar(tab, mode = 'toggle') {
  if (!tab || tab.id == null) return false;
  try { await sendToTop(tab.id, { cs: 'sidebar-cmd', mode }); return true; } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fs-main.js'], world: 'MAIN' }).catch(() => {});
    await sendToTop(tab.id, { cs: 'sidebar-cmd', mode });
    return true;
  } catch {
    // Browser pages (settings, extension store, PDF viewer) can't host it.
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
    chrome.action.setTitle({ tabId: tab.id, title: "CouchSync can't run on this page — open a video site first" }).catch(() => {});
    return false;
  }
}

chrome.action.onClicked.addListener(tab => toggleSidebar(tab));

const TRUSTED_SITES = /(^|\.)(netflix\.com|youtube\.com|youtu\.be|primevideo\.com|amazon\.[a-z.]+|hulu\.com|disneyplus\.com|max\.com|hbomax\.com|crunchyroll\.com|paramountplus\.com|peacocktv\.com|tv\.apple\.com|tubitv\.com|pluto\.tv|twitch\.tv|vimeo\.com)$/;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // A content script asking which tab it's in (the panel iframe needs it).
  if (msg.bg === 'whoami') { sendResponse({ tabId: sender.tab ? sender.tab.id : null }); return; }

  // A page just loaded: should the sidebar open by itself? (you were in a party in this tab, or an invite is waiting)
  if (msg.bg === 'should-open' && sender.tab) {
    chrome.storage.local.get(['pendingJoin', 'currentParty', 'sidebarMode']).then(s => {
      const t = Date.now(), id = sender.tab.id;
      const pending = s.pendingJoin && s.pendingJoin.tabId === id && t - s.pendingJoin.at < 10 * 60_000;
      const inParty = s.currentParty && s.currentParty.tabId === id && t - s.currentParty.at < 20 * 60_000;
      sendResponse({ open: !!(pending || inParty), mode: (s.sidebarMode && s.sidebarMode[id]) || 'open' });
    });
    return true; // async response
  }

  if (msg.bg === 'remember-mode' && sender.tab) {
    chrome.storage.local.get('sidebarMode').then(s => {
      const m = s.sidebarMode || {};
      m[sender.tab.id] = msg.mode;
      chrome.storage.local.set({ sidebarMode: m });
    });
    return;
  }

  // "Reopen" button on the video page.
  if (msg.bg === 'open-panel' && sender.tab) { toggleSidebar(sender.tab, 'open'); return; }

  // Tests can't click the toolbar button.
  if (msg.bg === 'test-toggle' && msg.tabId != null) { chrome.tabs.get(msg.tabId).then(t => toggleSidebar(t, msg.mode || 'toggle')); return; }

  // The invite page's "Join party" button.
  if (msg.bg === 'join-page' && sender.tab) {
    const tabId = sender.tab.id;
    const pending = { room: String(msg.room || ''), server: String(msg.server || ''), at: Date.now(), tabId };
    if (!/^[a-z0-9]{4,32}$/.test(pending.room) || !/^https?:\/\//.test(pending.server)) return;
    const url = msg.media && msg.media.url;
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    chrome.storage.local.set({ pendingJoin: pending, serverUrl: pending.server }).then(() => {
      if (url && /^https?:\/\//.test(url) && TRUSTED_SITES.test(host)) {
        // Go to the host's video; the sidebar opens there by itself and joins.
        chrome.tabs.update(tabId, { url });
      } else {
        // Unknown site (or nothing picked yet): open the sidebar right here; it offers the video with a click.
        toggleSidebar(sender.tab, 'open');
      }
      chrome.runtime.sendMessage({ panel: 'pending-join' }).catch(() => {});
    });
  }
});

chrome.tabs.onRemoved.addListener(id => {
  chrome.storage.local.get('sidebarMode').then(s => {
    if (s.sidebarMode && id in s.sidebarMode) { delete s.sidebarMode[id]; chrome.storage.local.set({ sidebarMode: s.sidebarMode }); }
  });
});
