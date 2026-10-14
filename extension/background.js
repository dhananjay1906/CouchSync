// CouchSync service worker: opens the side panel and handles invite links.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.bg !== 'join-page' || !sender.tab) return;
  const tabId = sender.tab.id;
  const pending = { room: String(msg.room || ''), server: String(msg.server || ''), at: Date.now(), tabId };
  if (!/^[a-z0-9]{4,32}$/.test(pending.room) || !/^https?:\/\//.test(pending.server)) return;
  chrome.storage.local.set({ pendingJoin: pending, serverUrl: pending.server });
  // Try to open the panel right away (works when Chrome treats it as part of the click).
  chrome.sidePanel.open({ tabId }).catch(() => {});
  const url = msg.media && msg.media.url;
  if (url && /^https?:\/\//.test(url)) chrome.tabs.update(tabId, { url });
  chrome.runtime.sendMessage({ panel: 'pending-join' }).catch(() => {});
});
