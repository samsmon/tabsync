<script>
  import { onMount } from 'svelte';
  import { slide, fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { listGroups, updateGroup, deleteGroup, importGroups, removeTab, undo, moveTab, onChanged, ARCHIVE } from '../lib/groups.js';
  import { parseOneTab, toOneTab } from '../lib/onetab.js';
  import { sync } from '../lib/sync.js';
  import Options from '../options/Options.svelte';
  import Icon from '../lib/Icon.svelte';
  import { getTheme, setTheme, THEMES } from '../lib/theme.js';
  import { installUpdate, getFolder, currentVersion } from '../lib/updater.js';
  import { deviceId, deviceMeta } from '../lib/device.js';

  // Tabs/groups slide out when restored or removed and glide when reordered.
  // Off for the first render, so the initial list doesn't slide in card by card.
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let animated = $state(false);
  const motion = $derived({ duration: animated && !reduced ? 180 : 0 });

  const PAGE = 30;
  let groups = $state([]);
  let q = $state('');
  let shown = $state(PAGE);
  let status = $state('');
  let sentinel = $state();

  const filtered = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return groups;
    return groups
      .map((g) => ({ ...g, data: { ...g.data, tabs: g.data.tabs.filter((t) => (t.title + ' ' + t.url).toLowerCase().includes(s)) } }))
      .filter((g) => g.data.tabs.length);
  });
  const total = $derived(groups.reduce((n, g) => n + g.data.tabs.length, 0));
  // The quick archive lives in the sidebar, not the main list.
  // Device filter: 'this' (default), 'all', or another device's id. Groups saved before
  // device ids existed have none and show under every filter.
  let myId = $state('');
  deviceId().then((id) => (myId = id));
  let devFilter = $state((() => { try { return localStorage.getItem('deviceFilter') || 'this'; } catch { return 'this'; } })());
  function setDevFilter(v) {
    devFilter = v;
    try { localStorage.setItem('deviceFilter', v); } catch {}
  }
  // [{ id, name, count }] for every device that has groups; its newest group's name wins
  const devices = $derived.by(() => {
    const m = new Map();
    for (const g of groups) {
      const id = g.data.deviceId;
      if (!id || g.id === ARCHIVE) continue;
      const d = m.get(id) ?? { id, name: g.data.device, count: 0, at: 0 };
      d.count++;
      if (g.data.createdAt > d.at) Object.assign(d, { name: g.data.device, at: g.data.createdAt });
      m.set(id, d);
    }
    return [...m.values()].sort((a, b) => (b.id === myId) - (a.id === myId) || a.name.localeCompare(b.name));
  });
  // two profiles with the same detected name get a short id suffix
  const devLabel = (d) => devices.some((o) => o !== d && o.name === d.name) ? `${d.name} (${d.id.slice(0, 4)})` : d.name;
  const wantId = $derived(devFilter === 'this' ? myId : devFilter);
  const listed = $derived(filtered.filter((g) => g.id !== ARCHIVE &&
    (devFilter === 'all' || !g.data.deviceId || g.data.deviceId === wantId)));
  const archived = $derived(filtered.find((g) => g.id === ARCHIVE));
  const archiveCount = $derived(groups.find((g) => g.id === ARCHIVE)?.data.tabs.length ?? 0);

  async function reload() { groups = await listGroups(); }

  // Last sync outcome is written by sync() wherever it ran (here or the background alarm).
  let syncInfo = $state(null); // { at, ok, error? }
  let syncing = $state(false);
  let syncOff = $state(false);
  let clock = $state(Date.now());

  async function doSync() {
    syncing = true;
    try { syncOff = !!(await sync())?.skipped; } catch {} finally { syncing = false; }
    reload();
  }

  function ago(ms) {
    const s = (clock - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(ms).toLocaleDateString();
  }

  const syncLabel = $derived(
    syncing ? 'Syncing…'
    : syncOff ? 'Sync off'
    : !syncInfo ? 'Sync'
    : syncInfo.ok ? `Synced ${ago(syncInfo.at)}`
    : 'Sync failed',
  );
  const syncTitle = $derived(
    syncOff ? 'Set up a server in Settings'
    : syncInfo && !syncInfo.ok ? `${syncInfo.error} (${ago(syncInfo.at)}). Click to retry.`
    : 'Sync now',
  );

  // Undo: every removal from the list returns a snapshot; removals made while the toast
  // is still up are merged, so one Undo brings all of them back.
  // raw: a deep $state proxy can't be structured-cloned into IndexedDB by undo()
  // Self-update: the worker checks the releases repo; the banner installs with one click.
  let update = $state(null); // { version, url, notes, page } when a newer release exists
  let hasFolder = $state(false);
  let updStep = $state('');
  let updError = $state('');
  let updatedNotice = $state('');

  async function runUpdate() {
    updError = '';
    try {
      await installUpdate(update, (s) => (updStep = s));
    } catch (e) {
      updStep = '';
      // closing the folder picker is not an error worth showing
      if (e.name !== 'AbortError') updError = e.message;
    }
    hasFolder = !!(await getFolder());
  }

  let toast = $state.raw(null); // { verb, text, count, snap }
  let toastTimer;
  function offerUndo(verb, snap, count) {
    if (!snap?.length) return;
    clearTimeout(toastTimer);
    const merged = toast && toast.verb === verb
      ? { verb, count: toast.count + count, snap: [...toast.snap, ...snap] }
      : { verb, count, snap };
    toast = { ...merged, text: `${verb} ${merged.count} tab${merged.count === 1 ? '' : 's'}` };
    toastTimer = setTimeout(() => (toast = null), 8000);
  }
  function doUndo() {
    if (!toast) return;
    clearTimeout(toastTimer);
    undo(toast.snap);
    toast = null;
  }
  function onKey(e) {
    const typing = e.target.closest?.('input, textarea');
    if (toast && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
  }

  onMount(() => {
    reload().then(() => {
      requestAnimationFrame(() => (animated = true));
      // Settings links here as list.html#import / #export
      if (location.hash === '#import') openImport();
      if (location.hash === '#export') openExport();
    });
    chrome.storage.local.get(['syncStatus', 'update', 'updatedFrom']).then((s) => {
      syncInfo = s.syncStatus ?? null;
      update = s.update?.version ? s.update : null;
      if (s.updatedFrom) {
        updatedNotice = `Updated to v${currentVersion()} (from v${s.updatedFrom})`;
        chrome.storage.local.remove('updatedFrom');
      }
    });
    getFolder().then((d) => (hasFolder = !!d));
    const onStore = (c) => {
      if (c.syncStatus) syncInfo = c.syncStatus.newValue ?? null;
      if (c.update) update = c.update.newValue?.version ? c.update.newValue : null;
    };
    chrome.storage.onChanged.addListener(onStore);
    const tick = setInterval(() => (clock = Date.now()), 30_000);
    doSync();
    const offChanged = onChanged(reload);
    // render groups progressively instead of all at once
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (shown += PAGE));
    io.observe(sentinel);
    return () => {
      offChanged();
      chrome.storage.onChanged.removeListener(onStore);
      clearInterval(tick);
      io.disconnect();
    };
  });

  // Restored tabs open in the background of this window, so you stay here.
  // Holding Ctrl/Cmd keeps them in the list.
  // The quick archive always keeps its links, whatever its stored `locked` flag says.
  const keepOnRestore = (g, e) => g.id === ARCHIVE || g.data.locked || e.ctrlKey || e.metaKey;

  async function openTab(g, t, e) {
    e.preventDefault();
    chrome.tabs.create({ url: t.url, active: false });
    if (!keepOnRestore(g, e)) offerUndo('Restored', await removeTab(t.id), 1);
  }

  // Groups that came from a Chrome tab group are restored as one again (same name and color).
  async function regroup(g, tabIds, windowId) {
    if (!g.data.chromeGroup || !tabIds.length) return;
    const id = await chrome.tabs.group({ tabIds, createProperties: windowId ? { windowId } : undefined });
    await chrome.tabGroups.update(id, { title: g.data.title, color: g.data.chromeGroup.color });
  }

  async function restoreAll(g, e) {
    const tabs = await Promise.all(g.data.tabs.map((t) => chrome.tabs.create({ url: t.url, active: false })));
    await regroup(g, tabs.map((t) => t.id));
    if (!keepOnRestore(g, e)) offerUndo('Restored', await deleteGroup(g.id), g.data.tabs.length);
  }

  async function restoreWindow(g, e) {
    const win = await chrome.windows.create({ url: g.data.tabs.map((t) => t.url) });
    await regroup(g, win.tabs.map((t) => t.id), win.id);
    if (!keepOnRestore(g, e)) offerUndo('Restored', await deleteGroup(g.id), g.data.tabs.length);
  }

  let editing = $state(null); // group id whose title is being edited

  function saveTitle(g, e) {
    if (editing !== g.id) return;
    editing = null;
    const title = e.currentTarget.value.trim();
    if (title !== g.data.title) updateGroup(g.id, { title });
  }

  function titleKey(g, e) {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') editing = null;
  }

  const focus = (el) => { el.focus(); el.select(); };

  // Copies the group's URLs one per line; Shift+click copies "url | title" (re-importable).
  let copied = $state(null); // group id showing "Copied!"
  let copiedTimer;
  async function copyGroup(g, e) {
    const text = e.shiftKey ? toOneTab([g]) : g.data.tabs.map((t) => t.url).join('\n') + '\n';
    await navigator.clipboard.writeText(text);
    clearTimeout(copiedTimer);
    copied = g.id;
    copiedTimer = setTimeout(() => (copied = null), 1500);
  }

  // No confirm dialogs: every removal can be undone from the toast.
  async function remove(g) { offerUndo('Deleted', await deleteGroup(g.id), g.data.tabs.length); }
  async function removeOne(t) { offerUndo('Deleted', await removeTab(t.id), 1); }

  let io = $state(null); // null | 'import' | 'export'
  let ioText = $state('');

  function openImport() { io = 'import'; ioText = ''; }
  function openExport() { io = 'export'; ioText = toOneTab(groups); }

  async function doImport() {
    const parsed = parseOneTab(ioText);
    if (!parsed.length) { status = 'Nothing to import'; return; }
    await importGroups(parsed, await deviceMeta());
    status = `Imported ${parsed.reduce((n, g) => n + g.length, 0)} tabs in ${parsed.length} groups`;
    io = null;
    await reload();
    doSync();
  }

  async function loadFile(e) {
    const f = e.currentTarget.files?.[0];
    if (f) ioText = await f.text();
  }

  function download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ioText], { type: 'text/plain' }));
    a.download = `tabsync-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Collapsed groups are a per-device view preference, so they stay out of sync.
  const readCollapsed = () => { try { return JSON.parse(localStorage.getItem('collapsed') ?? '[]'); } catch { return []; } };
  let collapsed = $state(new Set(readCollapsed()));
  function toggle(g) {
    collapsed.has(g.id) ? collapsed.delete(g.id) : collapsed.add(g.id);
    collapsed = new Set(collapsed);
    saveCollapsed();
  }
  function saveCollapsed() {
    try { localStorage.setItem('collapsed', JSON.stringify([...collapsed])); } catch {}
  }
  const allCollapsed = $derived(listed.length > 0 && listed.every((g) => collapsed.has(g.id)));
  function toggleAll() {
    // rebuilt from current groups, which also drops ids of groups that no longer exist
    collapsed = new Set(allCollapsed ? [] : listed.map((g) => g.id));
    saveCollapsed();
  }

  // Drag a tab onto another tab to insert before it, or anywhere else on a group to append.
  let dragId = $state(null);
  let drop = $state(null); // { gid, before }
  function dragStart(t, e) {
    dragId = t.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/uri-list', t.url);
  }
  function dragOver(gid, before, e) {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    if (drop?.gid !== gid || drop?.before !== before) drop = { gid, before };
  }
  function dropTab(e) {
    e.preventDefault();
    if (dragId && drop) moveTab(dragId, drop.gid, drop.before);
    dragEnd();
  }
  function dragEnd() { dragId = null; drop = null; }

  let settings = $state();
  function ioFromSettings(kind) {
    settings.close();
    kind === 'import' ? openImport() : openExport();
  }

  // Chrome's tab group palette, for the dot on groups that came from a tab group.
  const CHROME_COLORS = { grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
    pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#fa903e' };

  const favicon = (url) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`;
  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

  let theme = $state(getTheme());
  function cycleTheme() {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    setTheme(theme);
  }
</script>

<svelte:window onkeydown={onKey} />

<header>
  <div class="bar">
    <div class="brand">
      <h1>TabSync</h1>
      <span class="count">{total} tabs</span>
    </div>
    <label class="search">
      <Icon name="search" size={15} />
      <input type="search" placeholder="Search tabs" bind:value={q} />
    </label>
    <div class="actions">
      <button class="btn ghost sync" class:bad={!syncing && syncInfo && !syncInfo.ok && !syncOff} class:off={syncOff}
        class:busy={syncing} title={syncTitle} onclick={doSync} disabled={syncing}>
        <span class="dot"></span>{syncLabel}
      </button>
      <button class="icon-btn" title={allCollapsed ? 'Expand all' : 'Collapse all'} onclick={toggleAll} disabled={!groups.length}>
        <Icon name={allCollapsed ? 'expand' : 'collapse'} />
      </button>
      <button class="icon-btn" title="Import" onclick={openImport}><Icon name="upload" /></button>
      <button class="icon-btn" title="Export" onclick={openExport}><Icon name="download" /></button>
      <button class="icon-btn" title={`Theme: ${theme}`} onclick={cycleTheme}>
        <Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'} />
      </button>
      <button class="icon-btn" title="Settings" onclick={() => settings.showModal()}><Icon name="settings" /></button>
    </div>
  </div>
  {#if status}<div class="status">{status}</div>{/if}
  {#if update || updatedNotice}
    <div class="notice" transition:slide={motion}>
      {#if update}
        <Icon name="download" size={15} />
        <span class="grow">
          <strong>TabSync v{update.version}</strong> is available <span class="muted">(you have v{currentVersion()})</span>
          {#if updError}<span class="err">{updError}</span>
          {:else if updStep}<span class="muted">{updStep}</span>
          {:else if !hasFolder}<span class="muted">First update: pick the folder you loaded in chrome://extensions (it has manifest.json).</span>{/if}
        </span>
        <a class="btn ghost" href={update.page} target="_blank" rel="noreferrer">What's new</a>
        <button class="btn primary" onclick={runUpdate} disabled={!!updStep}>{updStep ? 'Updating…' : 'Update'}</button>
      {:else}
        <Icon name="check" size={15} />
        <span class="grow">{updatedNotice}</span>
        <button class="icon-btn sm" title="Dismiss" onclick={() => (updatedNotice = '')}><Icon name="x" size={14} /></button>
      {/if}
    </div>
  {/if}
</header>

<dialog bind:this={settings} onclick={(e) => e.target === settings && settings.close()}>
  <button class="icon-btn close" title="Close" onclick={() => settings.close()}><Icon name="x" /></button>
  <Options onio={ioFromSettings} />
</dialog>

<div class="page">
  {#if io}
    <div class="card io" transition:slide={motion}>
      <div class="io-head">
        <h2>{io === 'import' ? 'Import' : 'Export'}</h2>
        <button class="icon-btn" title="Close" onclick={() => (io = null)}><Icon name="x" /></button>
      </div>
      {#if io === 'import'}
        <p class="muted">Paste from OneTab "Export URLs", or pick the .txt file. Format: <code>url | title</code>, blank line between groups.</p>
        <input class="file" type="file" accept=".txt,text/plain" onchange={loadFile} />
      {:else}
        <p class="muted">OneTab-compatible export of {groups.length} groups.</p>
      {/if}
      <textarea class="field" bind:value={ioText} readonly={io === 'export'} rows="12" spellcheck="false"></textarea>
      <div class="row">
        {#if io === 'import'}
          <button class="btn primary" onclick={doImport} disabled={!ioText.trim()}>Import</button>
        {:else}
          <button class="btn primary" onclick={download}><Icon name="download" size={15} />Download .txt</button>
          <button class="btn" onclick={() => navigator.clipboard.writeText(ioText)}><Icon name="copy" size={15} />Copy</button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="layout">
  <main>
    {#each listed.slice(0, shown) as g (g.id)}
      <section class="card" class:starred={g.data.starred} class:pinned={g.data.pinned} out:slide={motion} animate:flip={motion} role="group"
        aria-label={g.data.title || `${g.data.tabs.length} tabs`} class:drop-end={drop?.gid === g.id && drop.before === null}
        ondragover={(e) => dragOver(g.id, null, e)} ondrop={dropTab}>
        <div class="ghead">
          <div class="gtitle">
            {#if g.data.chromeGroup}<span class="cg" style:--cg={CHROME_COLORS[g.data.chromeGroup.color]} title="From a Chrome tab group; restores as one"></span>{/if}
            <button class="icon-btn sm" title={collapsed.has(g.id) ? 'Expand' : 'Minimize'} aria-expanded={!collapsed.has(g.id)}
              onclick={() => toggle(g)}><Icon name={collapsed.has(g.id) ? 'chevronRight' : 'chevronDown'} /></button>
            {#if editing === g.id}
              <input class="field title-input" value={g.data.title} placeholder="Name this group" use:focus
                onblur={(e) => saveTitle(g, e)} onkeydown={(e) => titleKey(g, e)} />
            {:else}
              <button class="title" title="Click to rename" onclick={() => (editing = g.id)}>{g.data.title || `${g.data.tabs.length} tabs`}</button>
            {/if}
            <span class="meta">
              {#if g.data.title || collapsed.has(g.id)}<span class="pill">{g.data.tabs.length}</span>{/if}
              {fmt(g.data.createdAt)}
              {#if g.data.device}<span class="device" title="Saved on this device"><Icon name="monitor" size={12} />{g.data.device}</span>{/if}
              {#if g.data.pinned}<span class="pill lock"><Icon name="pin" size={11} />Pinned</span>{/if}
              {#if g.data.locked}<span class="pill lock"><Icon name="lock" size={11} />Locked</span>{/if}
            </span>
          </div>
          <div class="gactions">
            <button class="btn" onclick={(e) => restoreAll(g, e)} title="Open all here. Hold Ctrl/Cmd to keep them in the list">
              <Icon name="restore" size={15} />Restore all
            </button>
            <button class="icon-btn" onclick={(e) => restoreWindow(g, e)} title="Restore in new window"><Icon name="window" /></button>
            <button class="icon-btn" class:on={copied === g.id} onclick={(e) => copyGroup(g, e)}
              title={copied === g.id ? 'Copied' : 'Copy URLs (Shift: with titles, OneTab format)'}>
              <Icon name={copied === g.id ? 'check' : 'copy'} />
            </button>
            <button class="icon-btn" class:on={g.data.locked} onclick={() => updateGroup(g.id, { locked: !g.data.locked })}
              title={g.data.locked ? 'Unlock: restoring removes tabs again' : 'Lock: keep tabs in the list when restoring'}>
              <Icon name={g.data.locked ? 'lock' : 'unlock'} />
            </button>
            <button class="icon-btn" class:on={g.data.pinned} onclick={() => updateGroup(g.id, { pinned: !g.data.pinned })}
              title={g.data.pinned ? 'Unpin' : 'Pin to top'}>
              <Icon name="pin" filled={g.data.pinned} />
            </button>
            <button class="icon-btn star" class:on={g.data.starred} onclick={() => updateGroup(g.id, { starred: !g.data.starred })}
              title={g.data.starred ? 'Unstar' : 'Star (listed right after pinned groups)'}>
              <Icon name="star" filled={g.data.starred} />
            </button>
            <button class="icon-btn danger" onclick={() => remove(g)} title="Delete group"><Icon name="trash" /></button>
          </div>
        </div>
        <ul hidden={collapsed.has(g.id)}>
          {#each g.data.tabs as t (t.id)}
            <li transition:slide={motion} animate:flip={motion} draggable="true" class:dragging={dragId === t.id}
              class:drop-before={drop?.before === t.id}
              ondragstart={(e) => dragStart(t, e)} ondragend={dragEnd} ondragover={(e) => dragOver(g.id, t.id, e)}>
              <span class="grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
              <img src={favicon(t.url)} alt="" width="16" height="16" loading="lazy" draggable="false" />
              <a href={t.url} draggable="false" title={t.url} onclick={(e) => openTab(g, t, e)}>{t.title}</a>
              <span class="host">{host(t.url)}</span>
              <button class="icon-btn sm danger remove" title="Remove from list" onclick={() => removeOne(t)}><Icon name="x" size={14} /></button>
            </li>
          {/each}
        </ul>
      </section>
    {:else}
      <div class="empty card">
        {#if q}
          <p class="muted">No groups match "{q}".</p>
        {:else if devFilter !== 'all' && groups.some((g) => g.id !== ARCHIVE)}
          <p><strong>No groups from {devFilter === 'this' ? 'this device' : 'that device'}</strong></p>
          <p><button class="btn" onclick={() => setDevFilter('all')}>Show all devices</button></p>
        {:else}
          <p><strong>No saved tabs yet</strong></p>
          <p class="muted">Click the TabSync toolbar icon to send your open tabs here.</p>
        {/if}
      </div>
    {/each}
    <div bind:this={sentinel}></div>
  </main>

  <div class="side">
  {#if devices.some((d) => d.id !== myId)}
    <nav class="card devices" aria-label="Filter by device">
      <div class="ahead"><h2>Devices</h2></div>
      <button class="dev" class:on={devFilter === 'this'} onclick={() => setDevFilter('this')}>
        <Icon name="monitor" size={14} /><span class="dname">This device</span>
        <span class="pill">{devices.find((d) => d.id === myId)?.count ?? 0}</span>
      </button>
      <button class="dev" class:on={devFilter === 'all'} onclick={() => setDevFilter('all')}>
        <Icon name="window" size={14} /><span class="dname">All devices</span>
        <span class="pill">{groups.filter((g) => g.id !== ARCHIVE).length}</span>
      </button>
      {#each devices.filter((d) => d.id !== myId) as d (d.id)}
        <button class="dev" class:on={devFilter === d.id} onclick={() => setDevFilter(d.id)} title={d.name}>
          <span class="ddot"></span><span class="dname">{devLabel(d)}</span>
          <span class="pill">{d.count}</span>
        </button>
      {/each}
    </nav>
  {/if}
  <aside class="card archive" class:drop-end={drop?.gid === ARCHIVE && drop.before === null}
    ondragover={(e) => dragOver(ARCHIVE, null, e)} ondrop={dropTab} aria-label="Quick archive">
    <div class="ahead">
      <h2>Quick archive</h2>
      {#if archiveCount}<span class="pill">{archiveCount}</span>{/if}
    </div>
    {#if archived?.data.tabs.length}
      <ul>
        {#each archived.data.tabs as t (t.id)}
          <li transition:slide={motion} animate:flip={motion} draggable="true" class:dragging={dragId === t.id}
            class:drop-before={drop?.before === t.id}
            ondragstart={(e) => dragStart(t, e)} ondragend={dragEnd} ondragover={(e) => dragOver(ARCHIVE, t.id, e)}>
            <img src={favicon(t.url)} alt="" width="16" height="16" loading="lazy" draggable="false" />
            <a href={t.url} draggable="false" title={t.url} onclick={(e) => openTab(archived, t, e)}>
              <span class="atitle">{t.title}</span>
              <span class="host">{host(t.url)}</span>
            </a>
            <button class="icon-btn sm danger remove" title="Remove from archive" onclick={() => removeOne(t)}><Icon name="x" size={14} /></button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted hint">{q ? 'No matches.' : 'Right-click any link and choose "Send link to Quick archive", or drag a tab here. Links stay here after you open them.'}</p>
    {/if}
  </aside>
  </div>
  </div>
</div>

{#if toast}
  <div class="toast" role="status" transition:fly={{ y: 16, duration: motion.duration }}>
    <span>{toast.text}</span>
    <button class="btn ghost" onclick={doUndo}><Icon name="undo" size={15} />Undo</button>
    <button class="icon-btn sm" title="Dismiss" onclick={() => (toast = null)}><Icon name="x" size={14} /></button>
  </div>
{/if}

<style>
  /* z-index: sections use content-visibility, which makes them paint over a plain sticky header */
  header {
    position: sticky; top: 0; z-index: 10;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .bar, .page { width: 100%; max-width: 1360px; margin: 0 auto; padding-inline: 20px; }
  .bar { display: flex; align-items: center; gap: 16px; height: 60px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  h1 { font-size: 16px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
  .count { font-size: 12px; color: var(--muted); background: var(--surface-2); padding: 2px 8px; border-radius: 99px; }
  .search {
    flex: 1; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; min-width: 140px;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--muted);
  }
  .search:focus-within { border-color: var(--muted); box-shadow: 0 0 0 3px var(--surface-2); }
  .search input { flex: 1; border: 0; outline: 0; background: none; color: var(--text); height: 100%; min-width: 0; }
  .actions { display: flex; align-items: center; gap: 2px; }
  .status { max-width: 1360px; margin: -6px auto 0; padding: 0 20px 8px; font-size: 12px; color: var(--muted); }
  .notice {
    display: flex; align-items: center; gap: 10px; max-width: 1320px; margin: 0 auto 10px; padding: 8px 8px 8px 14px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); font-size: 13px;
  }
  .notice .grow { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .notice .err { color: var(--danger); }
  .notice a.btn { text-decoration: none; }
  @media (max-width: 1360px) { .notice { margin-inline: 20px; } }

  .sync { color: var(--muted); font-weight: 500; }
  .sync .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent); }
  .sync.busy .dot { background: var(--warn); animation: pulse 1s ease-in-out infinite; }
  .sync.off .dot { background: var(--muted); box-shadow: none; }
  .sync.bad { color: var(--danger); }
  .sync.bad .dot { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
  @keyframes pulse { 50% { opacity: 0.35; } }

  .page { padding-top: 20px; padding-bottom: 60px; }
  /* minmax(0, 1fr): without it a long nowrap title stretches the grid column past the window */
  /* list + quick archive sidebar; the sidebar moves above the list on narrow windows */
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: start; }
  .side { position: sticky; top: 80px; display: grid; gap: 14px; max-height: calc(100vh - 100px); grid-template-rows: auto minmax(0, 1fr); }
  .archive { overflow-y: auto; padding: 12px 8px 8px; min-height: 0; }
  .devices { padding: 12px 8px 8px; display: grid; gap: 2px; }
  .dev { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: 7px;
    background: none; color: var(--muted); font-size: 13px; text-align: left; cursor: pointer; }
  .dev:hover { background: var(--surface-2); color: var(--text); }
  .dev.on { background: var(--surface-2); color: var(--text); font-weight: 600; }
  .dname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ddot { width: 14px; display: grid; place-items: center; }
  .ddot::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .ahead { display: flex; align-items: center; gap: 8px; padding: 0 6px 8px; }
  .ahead h2 { font-size: 14px; margin: 0; }
  .archive li { height: auto; padding: 5px 4px; align-items: flex-start; }
  .archive li img { margin-top: 2px; }
  .archive li a { display: grid; gap: 1px; white-space: normal; }
  .archive .atitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive .host { max-width: none; }
  .archive .hint { margin: 0; padding: 4px 6px 8px; font-size: 13px; line-height: 1.5; }
  aside.drop-end { outline: 2px dashed var(--accent); outline-offset: -2px; }
  .cg { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--cg); }
  .device { display: inline-flex; align-items: center; gap: 4px; }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .side { position: static; max-height: none; order: -1; grid-template-rows: auto; }
    .archive { max-height: 320px; }
  }
  main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
  section { min-width: 0; padding: 10px 10px 8px; content-visibility: auto; contain-intrinsic-size: auto 220px; }
  section.starred { border-color: color-mix(in srgb, var(--star) 45%, var(--border)); }
  section.pinned { border-color: color-mix(in srgb, var(--text) 55%, var(--border)); }

  .ghead { display: flex; align-items: center; gap: 12px; padding: 0 2px 6px; min-width: 0; }
  .gtitle { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 0; overflow: hidden; }
  .title {
    border: 0; background: none; padding: 3px 6px; border-radius: 6px; cursor: text;
    font-size: 15px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; max-width: 100%;
  }
  .title:hover { background: var(--surface-2); }
  .title-input { height: 30px; font-size: 15px; font-weight: 600; width: min(320px, 100%); }
  .meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap; flex: 0 1 auto; min-width: 0; overflow: hidden; }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 99px; background: var(--surface-2); font-size: 11px; font-weight: 500; }
  .pill.lock { color: var(--accent); background: var(--accent-soft); }
  .gactions { display: flex; align-items: center; gap: 2px; margin-left: auto; flex: none; }
  .gactions .btn { margin-right: 6px; }
  .star.on { color: var(--star); }

  ul { list-style: none; margin: 0; padding: 0; }
  ul[hidden] { display: none; }
  li { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 4px 0 2px; border-radius: 7px; min-width: 0; cursor: grab; }
  li:hover { background: var(--surface-2); }
  li img { flex: none; border-radius: 3px; }
  li a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); text-decoration: none; }
  li a:hover { text-decoration: underline; text-underline-offset: 3px; }
  .host { flex: none; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }
  .grip { color: var(--muted); opacity: 0; transition: opacity 0.12s; }
  .remove { opacity: 0; }
  li:hover .grip, li:hover .remove, .remove:focus-visible { opacity: 1; }
  li.dragging { opacity: 0.4; }
  li.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
  section.drop-end ul { box-shadow: 0 2px 0 var(--accent); }
  section.drop-end:has(ul[hidden]) { outline: 2px dashed var(--accent); outline-offset: -2px; }

  .io { padding: 16px; margin-bottom: 14px; display: grid; gap: 10px; }
  .io-head { display: flex; align-items: center; justify-content: space-between; }
  .io h2 { font-size: 15px; margin: 0; }
  .io p { margin: 0; font-size: 13px; }
  .io textarea { width: 100%; font: 12px/1.5 ui-monospace, 'Cascadia Code', monospace; resize: vertical; }
  .file { font-size: 13px; color: var(--muted); }
  .row { display: flex; gap: 8px; }

  .empty { padding: 48px 20px; text-align: center; }
  .empty p { margin: 4px 0; }

  dialog { width: min(480px, calc(100vw - 32px)); }
  .close { position: absolute; top: 12px; right: 12px; }

  .toast {
    position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 20;
    display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 16px;
    background: var(--text); color: var(--bg); border-radius: 12px; box-shadow: var(--shadow-lg); font-size: 13px;
  }
  .toast span { margin-right: 6px; }
  .toast .btn, .toast .icon-btn { color: var(--bg); }
  .toast .btn:hover, .toast .icon-btn:hover { background: color-mix(in srgb, var(--bg) 18%, transparent); color: var(--bg); }

  @media (max-width: 720px) {
    .bar { flex-wrap: wrap; height: auto; padding-block: 10px; }
    .search { order: 3; flex-basis: 100%; }
    .host { display: none; }
  }
</style>
