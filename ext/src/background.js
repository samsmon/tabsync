// MV3 service worker: wakes on events, does its job, gets killed by Chrome. Zero idle RAM.
import { createGroup } from './lib/groups.js';
import { sync } from './lib/sync.js';

const LIST_URL = chrome.runtime.getURL('list.html');

const keep = (t) => t.url && !t.url.startsWith(LIST_URL) && !t.pinned && !/^(chrome|edge|about|devtools):/.test(t.url);

async function sendTabs(tabs) {
  tabs = tabs.filter(keep);
  if (!tabs.length) return openList();
  await createGroup(tabs.map((t) => ({ url: t.url, title: t.title || t.url })));
  await openList();
  await chrome.tabs.remove(tabs.map((t) => t.id));
  sync().catch(console.warn);
}

async function openList() {
  const [existing] = await chrome.tabs.query({ url: LIST_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: LIST_URL, pinned: true, index: 0 });
  }
}

chrome.action.onClicked.addListener(async () => {
  sendTabs(await chrome.tabs.query({ currentWindow: true }));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'send-this', title: 'Send only this tab', contexts: ['page', 'action'] });
  chrome.contextMenus.create({ id: 'send-others', title: 'Send all except this tab', contexts: ['page', 'action'] });
  chrome.contextMenus.create({ id: 'send-all-windows', title: 'Send tabs from all windows', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'show', title: 'Show TabSync', contexts: ['page', 'action'] });
  chrome.alarms.create('sync', { periodInMinutes: 1 });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'send-this') return sendTabs([tab]);
  if (info.menuItemId === 'send-others') {
    const all = await chrome.tabs.query({ currentWindow: true });
    return sendTabs(all.filter((t) => t.id !== tab.id));
  }
  if (info.menuItemId === 'send-all-windows') return sendTabs(await chrome.tabs.query({}));
  if (info.menuItemId === 'show') return openList();
});

chrome.alarms.onAlarm.addListener((a) => a.name === 'sync' && sync().catch(console.warn));
chrome.runtime.onStartup.addListener(() => sync().catch(console.warn));
