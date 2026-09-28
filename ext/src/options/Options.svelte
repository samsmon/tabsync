<script>
  import { onMount } from 'svelte';
  import { setup } from '../lib/sync.js';

  // Inside the list page's modal, import/export open in place instead of navigating.
  let { onio } = $props();

  let server = $state('');
  let token = $state('');
  let passphrase = $state('');
  let msg = $state('');
  let busy = $state(false);

  onMount(async () => {
    const s = await chrome.storage.local.get(['server', 'token', 'keyJwk']);
    server = s.server ?? 'http://';
    token = s.token ?? '';
    if (s.keyJwk) msg = 'Connected. Re-enter to change.';
  });

  async function save(e) {
    e.preventDefault();
    busy = true;
    msg = 'Deriving key…';
    try {
      const r = await setup(server.trim(), token.trim(), passphrase);
      passphrase = '';
      msg = `Connected. Pulled ${r.pulled}, pushed ${r.pushed}.`;
    } catch (err) {
      msg = 'Error: ' + err.message;
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={save} class:page={!onio}>
  <div class="head">
    <h1>Settings</h1>
    <p class="muted">Sync your list end-to-end encrypted through your own server.</p>
  </div>

  <label>
    <span>Server URL</span>
    <input class="field" bind:value={server} placeholder="https://tabsync.homelab.lan" required />
  </label>
  <label>
    <span>Token</span>
    <input class="field" type="password" bind:value={token} required />
  </label>
  <label>
    <span>Passphrase</span>
    <input class="field" type="password" bind:value={passphrase} required minlength="8" />
    <small class="muted">
      Encrypts your tabs before they leave this device. Use the same one on every device.
      It is never sent to the server; if you lose it, synced data cannot be recovered.
    </small>
  </label>
  <div class="row">
    <button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
    {#if msg}<span class="msg" class:err={msg.startsWith('Error')}>{msg}</span>{/if}
  </div>

  <hr />

  <div class="head">
    <h2>Import / Export</h2>
    <p class="muted">OneTab-compatible: <code>url | title</code>, blank line between groups.</p>
  </div>
  <div class="row">
    {#if onio}
      <button type="button" class="btn" onclick={() => onio('import')}>Import URLs</button>
      <button type="button" class="btn" onclick={() => onio('export')}>Export URLs</button>
    {:else}
      <a class="btn" href="list.html#import">Import URLs</a>
      <a class="btn" href="list.html#export">Export URLs</a>
    {/if}
  </div>
</form>

<style>
  form { display: grid; gap: 16px; padding: 24px; }
  form.page { max-width: 480px; margin: 40px auto; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow); }
  .head { display: grid; gap: 2px; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 15px; margin: 0; }
  .head p { margin: 0; font-size: 13px; }
  label { display: grid; gap: 6px; }
  label span { font-size: 13px; font-weight: 550; }
  small { font-size: 12px; line-height: 1.5; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  a.btn { text-decoration: none; }
  .msg { font-size: 13px; color: var(--ok); }
  .msg.err { color: var(--danger); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 4px 0; width: 100%; }
</style>
