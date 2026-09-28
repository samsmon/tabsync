import { db } from './db.js';
import { deriveKey, encrypt, decrypt, newSalt, makeVerifier, checkVerifier, exportKey, importKey } from './crypto.js';

async function config() {
  const { server, token, keyJwk } = await chrome.storage.local.get(['server', 'token', 'keyJwk']);
  if (!server || !token || !keyJwk) return null;
  return { server, token, key: await importKey(keyJwk) };
}

function api(cfg, path, init = {}) {
  return fetch(cfg.server.replace(/\/$/, '') + path, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', ...init.headers },
  });
}

// First device creates the salt+verifier; every other device must match the passphrase.
export async function setup(server, token, passphrase) {
  const cfg = { server, token };
  let res = await api(cfg, '/v1/meta');
  let meta;
  if (res.status === 404) {
    const salt = newSalt();
    const key = await deriveKey(passphrase, salt);
    meta = { salt, verifier: await makeVerifier(key) };
    res = await api(cfg, '/v1/meta', { method: 'PUT', body: JSON.stringify(meta) });
    if (!res.ok && res.status !== 409) throw new Error(`init failed: ${res.status}`);
    if (res.status === 409) return setup(server, token, passphrase);
  } else if (res.ok) {
    meta = await res.json();
  } else {
    throw new Error(res.status === 401 ? 'wrong token' : `server error ${res.status}`);
  }
  const key = await deriveKey(passphrase, meta.salt);
  if (!(await checkVerifier(key, meta.verifier))) throw new Error('wrong passphrase');
  await chrome.storage.local.set({ server, token, keyJwk: await exportKey(key) });
  await db.kvSet('cursor', 0);
  return sync();
}

let running = null;
export function sync() {
  running ??= doSync().finally(() => (running = null));
  return running;
}

async function doSync() {
  const cfg = await config();
  if (!cfg) return { skipped: true };

  // push local changes
  const dirty = (await db.all()).filter((g) => g.dirty);
  if (dirty.length) {
    const records = await Promise.all(
      dirty.map(async (g) => ({
        id: g.id,
        ts: g.ts,
        deleted: g.deleted,
        blob: g.deleted ? '' : await encrypt(cfg.key, g.data),
      })),
    );
    const res = await api(cfg, '/v1/push', { method: 'POST', body: JSON.stringify({ records }) });
    if (!res.ok) throw new Error(`push ${res.status}`);
    for (const g of dirty) {
      const cur = await db.get(g.id);
      if (cur && cur.ts === g.ts) await db.put({ ...cur, dirty: false });
    }
  }

  // pull remote changes (last-writer-wins by ts)
  let cursor = (await db.kvGet('cursor')) ?? 0;
  let pulled = 0;
  for (;;) {
    const res = await api(cfg, `/v1/pull?since=${cursor}`);
    if (!res.ok) throw new Error(`pull ${res.status}`);
    const page = await res.json();
    for (const r of page.records) {
      const cur = await db.get(r.id);
      if (cur && cur.ts >= r.ts) continue;
      const data = r.deleted ? null : await decrypt(cfg.key, r.blob);
      await db.put({ id: r.id, ts: r.ts, deleted: r.deleted, dirty: false, data });
      pulled++;
    }
    cursor = page.cursor;
    await db.kvSet('cursor', cursor);
    if (!page.more) break;
  }
  if (pulled) chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
  return { pushed: dirty.length, pulled };
}
