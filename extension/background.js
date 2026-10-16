// CouchSync service worker: opens the side panel and handles invite links.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const TRUSTED_SITES = /(^|\.)(netflix\.com|youtube\.com|youtu\.be|primevideo\.com|amazon\.[a-z.]+|hulu\.com|disneyplus\.com|max\.com|hbomax\.com|crunchyroll\.com|paramountplus\.com|peacocktv\.com|tv\.apple\.com|tubitv\.com|pluto\.tv|twitch\.tv|vimeo\.com)$/;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.bg === 'open-panel' && sender.tab) {
    // From the "Reopen" button on the video page (a user click).
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {}));
    return;
  }
  if (!msg || msg.bg !== 'join-page' || !sender.tab) return;
  const tabId = sender.tab.id;
  const pending = { room: String(msg.room || ''), server: String(msg.server || ''), at: Date.now(), tabId };
  if (!/^[a-z0-9]{4,32}$/.test(pending.room) || !/^https?:\/\//.test(pending.server)) return;
  chrome.storage.local.set({ pendingJoin: pending, serverUrl: pending.server });
  // Try to open the panel right away (works when Chrome treats it as part of the click).
  chrome.sidePanel.open({ tabId }).catch(() => {});
  const url = msg.media && msg.media.url;
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  // Only jump straight to well-known streaming sites; anything else is offered in the panel instead.
  if (url && /^https?:\/\//.test(url) && TRUSTED_SITES.test(host)) chrome.tabs.update(tabId, { url });
  chrome.runtime.sendMessage({ panel: 'pending-join' }).catch(() => {});
});
