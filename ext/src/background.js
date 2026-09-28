// MV3 service worker: wakes on events, does its job, gets killed by Chrome. Zero idle RAM.
import { createGroup, addToArchive } from './lib/groups.js';
import { deviceMeta } from './lib/device.js';
import { sync } from './lib/sync.js';
import { checkForUpdate } from './lib/updater.js';

const checkUpdate = () => checkForUpdate().catch(console.warn);

const LIST_URL = chrome.runtime.getURL('list.html');

const keep = (t) => t.url && !t.url.startsWith(LIST_URL) && !t.pinned && !/^(chrome|edge|about|devtools):/.test(t.url);

// meta: extra group fields, e.g. the Chrome tab group's name and color
async function sendTabs(tabs, meta = {}) {
  tabs = tabs.filter(keep);
  if (!tabs.length) return openList();
  // duplicates are dropped from the list but their tabs still close
  await createGroup(tabs.map((t) => ({ url: t.url, title: t.title || t.url })), { ...meta, ...(await deviceMeta()) });
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

// Multi-selected tabs win; otherwise the active tab's tab group; otherwise the whole window.
chrome.action.onClicked.addListener(async (active) => {
  const selected = await chrome.tabs.query({ currentWindow: true, highlighted: true });
  if (selected.length > 1) return sendTabs(selected);
  if (active.groupId > -1) {
    // keep the tab group's name and color so restoring can rebuild it
    const tg = await chrome.tabGroups.get(active.groupId);
    return sendTabs(await chrome.tabs.query({ groupId: active.groupId }), { title: tg.title ?? '', chromeGroup: { color: tg.color } });
  }
  sendTabs(await chrome.tabs.query({ currentWindow: true }));
});

// Saves without closing anything; the badge flashes how many were added (0 = already archived).
async function archive(items) {
  const n = await addToArchive(items);
  await chrome.action.setBadgeBackgroundColor({ color: '#18181b' });
  await chrome.action.setBadgeText({ text: n ? `+${n}` : '0' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
  sync().catch(console.warn);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll(); // onInstalled also runs after updates; ids must be unique
  chrome.contextMenus.create({ id: 'archive-link', title: 'Send link to Quick archive', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'archive-page', title: 'Save page to Quick archive', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'send-this', title: 'Send only this tab', contexts: ['page', 'action'] });
  chrome.contextMenus.create({ id: 'send-others', title: 'Send all except this tab', contexts: ['page', 'action'] });
  chrome.contextMenus.create({ id: 'send-all-windows', title: 'Send tabs from all windows', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'show', title: 'Show TabSync', contexts: ['page', 'action'] });
  chrome.alarms.create('sync', { periodInMinutes: 1 });
  chrome.alarms.create('update', { periodInMinutes: 360 });
  checkUpdate();
  // A self-update reloads the extension, which closes the list page; bring it back.
  chrome.storage.local.get('updatedFrom').then((s) => s.updatedFrom && openList());
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'send-this') return sendTabs([tab]);
  if (info.menuItemId === 'send-others') {
    const all = await chrome.tabs.query({ currentWindow: true });
    return sendTabs(all.filter((t) => t.id !== tab.id));
  }
  if (info.menuItemId === 'send-all-windows') return sendTabs(await chrome.tabs.query({}));
  if (info.menuItemId === 'show') return openList();
  if (info.menuItemId === 'archive-link') return archive([{ url: info.linkUrl, title: info.linkText?.trim() || info.linkUrl }]);
  if (info.menuItemId === 'archive-page') return archive([{ url: tab.url, title: tab.title || tab.url }]);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') sync().catch(console.warn);
  if (a.name === 'update') checkUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  openList();
  sync().catch(console.warn);
  checkUpdate();
});
