<script>
  import { onMount } from 'svelte';
  import { setup } from '../lib/sync.js';

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

<form onsubmit={save}>
  <h1>TabSync settings</h1>
  <label>Server URL <input bind:value={server} placeholder="https://tabsync.homelab.lan" required /></label>
  <label>Token <input type="password" bind:value={token} required /></label>
  <label>Passphrase <input type="password" bind:value={passphrase} required minlength="8" /></label>
  <p class="hint">
    The passphrase encrypts your tabs before they leave this device. Use the same one on every device.
    It is never sent to the server. If you lose it, synced data cannot be recovered.
  </p>
  <button disabled={busy}>Connect</button>
  {#if msg}<p>{msg}</p>{/if}
  <h2>Import / Export</h2>
  <p class="hint">OneTab-compatible (<code>url | title</code>, blank line between groups).</p>
  <p><a href="list.html#import">Import URLs</a> · <a href="list.html#export">Export URLs</a></p>
</form>

<style>
  :global(body) { font: 14px/1.4 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  form { max-width: 420px; margin: 40px auto; padding: 0 16px; display: grid; gap: 12px; }
  label { display: grid; gap: 4px; }
  input { padding: 6px 8px; font: inherit; }
  .hint { color: GrayText; font-size: 12px; margin: 0; }
</style>
