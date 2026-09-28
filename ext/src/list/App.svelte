<script>
  import { onMount } from 'svelte';
  import { listGroups, updateGroup, deleteGroup, importGroups, removeTab, undo, moveTab } from '../lib/groups.js';
  import { parseOneTab, toOneTab } from '../lib/onetab.js';
  import { sync } from '../lib/sync.js';
  import Options from '../options/Options.svelte';

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
      // Settings links here as list.html#import / #export
      if (location.hash === '#import') openImport();
      if (location.hash === '#export') openExport();
    });
    chrome.storage.local.get('syncStatus').then((s) => (syncInfo = s.syncStatus ?? null));
    const onStore = (c) => c.syncStatus && (syncInfo = c.syncStatus.newValue ?? null);
    chrome.storage.onChanged.addListener(onStore);
    const tick = setInterval(() => (clock = Date.now()), 30_000);
    doSync();
    const onMsg = (m) => m?.type === 'changed' && reload();
    chrome.runtime.onMessage.addListener(onMsg);
    // render groups progressively instead of all at once
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (shown += PAGE));
    io.observe(sentinel);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStore);
      clearInterval(tick);
      io.disconnect();
    };
  });

  // Restored tabs open in the background of this window, so you stay here.
  // Holding Ctrl/Cmd keeps them in the list.
  const keepOnRestore = (g, e) => g.data.locked || e.ctrlKey || e.metaKey;

  async function openTab(g, t, e) {
    e.preventDefault();
    chrome.tabs.create({ url: t.url, active: false });
    if (!keepOnRestore(g, e)) offerUndo('Restored', await removeTab(t.id), 1);
  }

  async function restoreAll(g, e) {
    for (const t of g.data.tabs) chrome.tabs.create({ url: t.url, active: false });
    if (!keepOnRestore(g, e)) offerUndo('Restored', await deleteGroup(g.id), g.data.tabs.length);
  }

  async function restoreWindow(g, e) {
    await chrome.windows.create({ url: g.data.tabs.map((t) => t.url) });
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
    await importGroups(parsed);
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
  const allCollapsed = $derived(groups.length > 0 && groups.every((g) => collapsed.has(g.id)));
  function toggleAll() {
    // rebuilt from current groups, which also drops ids of groups that no longer exist
    collapsed = new Set(allCollapsed ? [] : groups.map((g) => g.id));
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

  const favicon = (url) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`;
  const fmt = (ms) => new Date(ms).toLocaleString();
</script>

<svelte:window onkeydown={onKey} />

<header>
  <h1>TabSync <small>{total} tabs</small></h1>
  <input type="search" placeholder="Search tabs…" bind:value={q} />
  <button class="sync" class:bad={!syncing && syncInfo && !syncInfo.ok && !syncOff} title={syncTitle} onclick={doSync} disabled={syncing}>
    <span class="dot"></span>{syncLabel}
  </button>
  <button onclick={toggleAll} disabled={!groups.length}>{allCollapsed ? 'Expand all' : 'Collapse all'}</button>
  <button onclick={openImport}>Import</button>
  <button onclick={openExport}>Export</button>
  <button onclick={() => settings.showModal()}>Settings</button>
  {#if status}<span class="status">{status}</span>{/if}
</header>

<dialog bind:this={settings} onclick={(e) => e.target === settings && settings.close()}>
  <button class="close" title="Close" onclick={() => settings.close()}>×</button>
  <Options onio={ioFromSettings} />
</dialog>

{#if io}
  <div class="io">
    {#if io === 'import'}
      <p>Paste from OneTab → "Export URLs", or pick the .txt file. Format: <code>url | title</code>, blank line between groups.</p>
      <input type="file" accept=".txt,text/plain" onchange={loadFile} />
    {:else}
      <p>OneTab-compatible export ({groups.length} groups).</p>
    {/if}
    <textarea bind:value={ioText} readonly={io === 'export'} rows="12" spellcheck="false"></textarea>
    <div class="row">
      {#if io === 'import'}
        <button onclick={doImport} disabled={!ioText.trim()}>Import</button>
      {:else}
        <button onclick={download}>Download .txt</button>
        <button onclick={() => navigator.clipboard.writeText(ioText)}>Copy</button>
      {/if}
      <button onclick={() => (io = null)}>Close</button>
    </div>
  </div>
{/if}

<main>
  {#each filtered.slice(0, shown) as g (g.id)}
    <section role="group" aria-label={g.data.title || `${g.data.tabs.length} tabs`} class:drop-end={drop?.gid === g.id && drop.before === null}
      ondragover={(e) => dragOver(g.id, null, e)} ondrop={dropTab}>
      <div class="ghead">
        <button class="caret" title={collapsed.has(g.id) ? 'Expand' : 'Minimize'} aria-expanded={!collapsed.has(g.id)}
          onclick={() => toggle(g)}>{collapsed.has(g.id) ? '▸' : '▾'}</button>
        {#if editing === g.id}
          <input class="title" value={g.data.title} placeholder="Name this group" use:focus
            onblur={(e) => saveTitle(g, e)} onkeydown={(e) => titleKey(g, e)} />
        {:else}
          <button class="title" title="Click to rename" onclick={() => (editing = g.id)}>{g.data.title || `${g.data.tabs.length} tabs`}</button>
        {/if}
        <span class="muted">{#if collapsed.has(g.id)}{g.data.tabs.length} tabs · {/if}{fmt(g.data.createdAt)}</span>
        <button onclick={(e) => restoreAll(g, e)} title="Hold Ctrl/Cmd to keep them in the list">Restore all</button>
        <button onclick={(e) => restoreWindow(g, e)}>In new window</button>
        <button onclick={(e) => copyGroup(g, e)} title="Copy URLs (Shift: with titles, OneTab format)">{copied === g.id ? 'Copied!' : 'Copy'}</button>
        <button onclick={() => updateGroup(g.id, { locked: !g.data.locked })}>{g.data.locked ? 'Unlock' : 'Lock'}</button>
        <button onclick={() => updateGroup(g.id, { starred: !g.data.starred })}>{g.data.starred ? '★' : '☆'}</button>
        <button class="danger" onclick={() => remove(g)}>Delete</button>
      </div>
      <ul hidden={collapsed.has(g.id)}>
        {#each g.data.tabs as t (t.id)}
          <li draggable="true" class:dragging={dragId === t.id} class:drop-before={drop?.before === t.id}
            ondragstart={(e) => dragStart(t, e)} ondragend={dragEnd} ondragover={(e) => dragOver(g.id, t.id, e)}>
            <button class="x" title="Remove" onclick={() => removeOne(t)}>×</button>
            <img src={favicon(t.url)} alt="" width="16" height="16" loading="lazy" draggable="false" />
            <a href={t.url} draggable="false" onclick={(e) => openTab(g, t, e)}>{t.title}</a>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="muted">No saved tabs. Click the toolbar icon to collapse your tabs here.</p>
  {/each}
  <div bind:this={sentinel}></div>
</main>

{#if toast}
  <div class="toast" role="status">
    {toast.text}
    <button onclick={doUndo}>Undo</button>
    <button class="x" title="Dismiss" onclick={() => (toast = null)}>×</button>
  </div>
{/if}

<style>
  :global(body) { font: 14px/1.4 system-ui, sans-serif; margin: 0; background: Canvas; color: CanvasText; }
  /* z-index: sections use content-visibility, which makes them paint over a plain sticky header */
  header { position: sticky; top: 0; z-index: 10; display: flex; gap: 8px; align-items: center; padding: 10px max(16px, calc((100% - 1000px) / 2 + 16px)); background: Canvas; border-bottom: 1px solid #8884; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0 8px 0 0; }
  small, .muted { color: GrayText; font-weight: normal; font-size: 12px; }
  input { flex: 1; min-width: 160px; padding: 6px 8px; }
  main { padding: 8px 16px 40px; max-width: 1000px; margin: 0 auto; box-sizing: border-box; }
  section { padding: 12px 0; border-bottom: 1px solid #8883; content-visibility: auto; contain-intrinsic-size: auto 200px; }
  .ghead { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  button.title { border: 0; background: none; padding: 0; margin-right: 4px; font-size: 14px; font-weight: bold; color: inherit; }
  input.title { flex: 0 1 260px; min-width: 120px; padding: 2px 6px; font: bold 14px system-ui, sans-serif; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 6px; align-items: center; padding: 2px 0; min-width: 0; }
  li a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: LinkText; text-decoration: none; }
  li a:hover { text-decoration: underline; }
  button { font: inherit; font-size: 12px; cursor: pointer; }
  .x { border: 0; background: none; color: GrayText; font-size: 14px; padding: 0 4px; }
  .danger { color: #c33; }
  .sync { display: inline-flex; align-items: center; gap: 6px; }
  .sync .dot { width: 7px; height: 7px; border-radius: 50%; background: #3a3; }
  .sync:disabled .dot { background: #d90; }
  .sync.bad { color: #c33; }
  .sync.bad .dot { background: #c33; }
  li[draggable='true'] { cursor: grab; }
  li.dragging { opacity: 0.4; }
  li.drop-before { box-shadow: 0 -2px 0 LinkText; }
  section.drop-end ul { box-shadow: 0 2px 0 LinkText; }
  section.drop-end:has(ul[hidden]) { outline: 2px dashed LinkText; outline-offset: -2px; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20; display: flex; gap: 10px; align-items: center;
    padding: 8px 10px 8px 14px; border-radius: 8px; background: CanvasText; color: Canvas; box-shadow: 0 4px 16px #0004; font-size: 13px; }
  .toast button { color: inherit; background: none; border: 1px solid currentColor; border-radius: 4px; padding: 2px 8px; }
  .toast .x { border: 0; color: inherit; }
  .caret { border: 0; background: none; padding: 0 2px; width: 18px; color: GrayText; }
  ul[hidden] { display: none; }
  dialog { border: 1px solid #8884; border-radius: 8px; padding: 8px 0 16px; width: min(460px, calc(100vw - 32px)); background: Canvas; color: CanvasText; }
  dialog::backdrop { background: #0006; }
  .close { position: absolute; top: 8px; right: 10px; border: 0; background: none; font-size: 20px; color: GrayText; }
  .io { margin: 12px auto; width: calc(100% - 32px); box-sizing: border-box; padding: 12px; border: 1px solid #8884; border-radius: 6px; max-width: 968px; display: grid; gap: 8px; }
  .io p { margin: 0; font-size: 13px; }
  .io textarea { width: 100%; box-sizing: border-box; font: 12px ui-monospace, monospace; }
  .row { display: flex; gap: 6px; }
  .status { font-size: 12px; color: GrayText; }
</style>
