<script>
  import { onMount } from 'svelte';
  import { listGroups, updateGroup, deleteGroup, importGroups } from '../lib/groups.js';
  import { parseOneTab, toOneTab } from '../lib/onetab.js';
  import { sync } from '../lib/sync.js';

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

  async function doSync() {
    status = 'syncing…';
    try {
      const r = await sync();
      status = r?.skipped ? 'sync not configured' : '';
    } catch (e) { status = 'sync failed: ' + e.message; }
    reload();
  }

  onMount(() => {
    reload();
    doSync();
    const onMsg = (m) => m?.type === 'changed' && reload();
    chrome.runtime.onMessage.addListener(onMsg);
    // render groups progressively instead of all at once
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (shown += PAGE));
    io.observe(sentinel);
    return () => { chrome.runtime.onMessage.removeListener(onMsg); io.disconnect(); };
  });

  function openTab(g, i, e) {
    e.preventDefault();
    const t = g.data.tabs[i];
    chrome.tabs.create({ url: t.url, active: false });
    if (!g.data.locked) updateGroup(g.id, { tabs: g.data.tabs.filter((_, j) => j !== i) });
  }

  function removeTab(g, i) {
    updateGroup(g.id, { tabs: g.data.tabs.filter((_, j) => j !== i) });
  }

  async function restoreAll(g) {
    for (const t of g.data.tabs) chrome.tabs.create({ url: t.url, active: false });
    if (!g.data.locked) deleteGroup(g.id);
  }

  async function restoreWindow(g) {
    await chrome.windows.create({ url: g.data.tabs.map((t) => t.url) });
    if (!g.data.locked) deleteGroup(g.id);
  }

  function rename(g) {
    const title = prompt('Name this group', g.data.title);
    if (title !== null) updateGroup(g.id, { title });
  }

  function remove(g) {
    if (confirm(`Delete ${g.data.tabs.length} tabs?`)) deleteGroup(g.id);
  }

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

  const favicon = (url) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`;
  const fmt = (ms) => new Date(ms).toLocaleString();
</script>

<header>
  <h1>TabSync <small>{total} tabs</small></h1>
  <input type="search" placeholder="Search tabs…" bind:value={q} />
  <button onclick={doSync}>Sync</button>
  <button onclick={openImport}>Import</button>
  <button onclick={openExport}>Export</button>
  <a href="options.html" target="_blank">Settings</a>
  {#if status}<span class="status">{status}</span>{/if}
</header>

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
    <section>
      <div class="ghead">
        <strong>{g.data.title || `${g.data.tabs.length} tabs`}</strong>
        <span class="muted">{fmt(g.data.createdAt)}</span>
        <button onclick={() => restoreAll(g)}>Restore all</button>
        <button onclick={() => restoreWindow(g)}>In new window</button>
        <button onclick={() => rename(g)}>Name</button>
        <button onclick={() => updateGroup(g.id, { locked: !g.data.locked })}>{g.data.locked ? 'Unlock' : 'Lock'}</button>
        <button onclick={() => updateGroup(g.id, { starred: !g.data.starred })}>{g.data.starred ? '★' : '☆'}</button>
        <button class="danger" onclick={() => remove(g)}>Delete</button>
      </div>
      <ul>
        {#each g.data.tabs as t, i (t.url + i)}
          <li>
            <button class="x" title="Remove" onclick={() => removeTab(g, i)}>×</button>
            <img src={favicon(t.url)} alt="" width="16" height="16" loading="lazy" />
            <a href={t.url} onclick={(e) => openTab(g, i, e)}>{t.title}</a>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    <p class="muted">No saved tabs. Click the toolbar icon to collapse your tabs here.</p>
  {/each}
  <div bind:this={sentinel}></div>
</main>

<style>
  :global(body) { font: 14px/1.4 system-ui, sans-serif; margin: 0; background: Canvas; color: CanvasText; }
  header { position: sticky; top: 0; display: flex; gap: 8px; align-items: center; padding: 10px 16px; background: Canvas; border-bottom: 1px solid #8884; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0 8px 0 0; }
  small, .muted { color: GrayText; font-weight: normal; font-size: 12px; }
  input { flex: 1; min-width: 160px; padding: 6px 8px; }
  main { padding: 8px 16px 40px; max-width: 1000px; }
  section { padding: 12px 0; border-bottom: 1px solid #8883; content-visibility: auto; contain-intrinsic-size: auto 200px; }
  .ghead { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  .ghead strong { margin-right: 4px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 6px; align-items: center; padding: 2px 0; min-width: 0; }
  li a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: LinkText; text-decoration: none; }
  li a:hover { text-decoration: underline; }
  button { font: inherit; font-size: 12px; cursor: pointer; }
  .x { border: 0; background: none; color: GrayText; font-size: 14px; padding: 0 4px; }
  .danger { color: #c33; }
  .io { margin: 12px 16px; padding: 12px; border: 1px solid #8884; border-radius: 6px; max-width: 968px; display: grid; gap: 8px; }
  .io p { margin: 0; font-size: 13px; }
  .io textarea { width: 100%; box-sizing: border-box; font: 12px ui-monospace, monospace; }
  .row { display: flex; gap: 6px; }
  .status { font-size: 12px; color: GrayText; }
</style>
