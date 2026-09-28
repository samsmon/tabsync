// Self-update for the unpacked extension. Chrome can't update an unpacked extension, but a page
// the user has granted a folder to (File System Access API) can overwrite that folder's files.
// Flow: check this (public) repo's GitHub Releases -> download the zip -> unzip -> write into the
// extension folder the user picked once -> chrome.runtime.reload().
import { unzipSync } from 'fflate';
import { db } from './db.js';

export const RELEASES_REPO = 'samsmon/tabsync';
const API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

export const currentVersion = () => chrome.runtime.getManifest().version;

// '0.10.0' > '0.9.3'; missing parts count as 0.
export function isNewer(latest, current) {
  const a = latest.replace(/^v/, '').split('.').map(Number);
  const b = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// Result lands in chrome.storage.local.update = { version, url, notes, page, checkedAt } or
// { checkedAt } when up to date, so the list page can react to checks made by the worker.
export async function checkForUpdate() {
  const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) { // no release published yet
    await chrome.storage.local.set({ update: { checkedAt: Date.now() } });
    return { checkedAt: Date.now() };
  }
  if (!res.ok) throw new Error(`update check failed: ${res.status}`);
  const rel = await res.json();
  const asset = rel.assets?.find((a) => a.name.endsWith('.zip'));
  const version = rel.tag_name.replace(/^v/, '');
  const update = asset && isNewer(version, currentVersion())
    ? { version, url: asset.browser_download_url, notes: rel.body ?? '', page: rel.html_url, checkedAt: Date.now() }
    : { checkedAt: Date.now() };
  await chrome.storage.local.set({ update });
  return update;
}

// --- the extension folder -------------------------------------------------------------

export const getFolder = () => db.kvGet('extFolder');

// Must run from a click. Refuses folders that aren't this extension, so a wrong pick
// can't overwrite unrelated files.
export async function pickFolder() {
  const dir = await window.showDirectoryPicker({ id: 'tabsync-ext', mode: 'readwrite' });
  await assertExtensionFolder(dir);
  await db.kvSet('extFolder', dir);
  return dir;
}

async function assertExtensionFolder(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  } catch {
    throw new Error('That folder has no manifest.json. Pick the folder you loaded in chrome://extensions.');
  }
  if (manifest.name !== chrome.runtime.getManifest().name) {
    throw new Error(`That folder holds "${manifest.name}", not TabSync.`);
  }
}

// Permission to a stored handle can lapse when the browser restarts; asking again needs a click.
async function ensureWritable(dir) {
  const opts = { mode: 'readwrite' };
  if ((await dir.queryPermission(opts)) === 'granted') return;
  if ((await dir.requestPermission(opts)) !== 'granted') throw new Error('Folder access was not granted.');
}

// --- install ---------------------------------------------------------------------------

// Writes every file from the zip into `dir`, manifest.json last so a half-written update
// never pairs a new manifest with old code. Files the new version no longer has are left alone.
export async function writeFiles(dir, files) {
  const paths = Object.keys(files).filter((p) => !p.endsWith('/')).sort((a, b) =>
    (a === 'manifest.json') - (b === 'manifest.json'));
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.some((p) => p === '..' || p === '')) throw new Error(`Unsafe path in update: ${path}`);
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(files[path]);
    await w.close();
  }
  return paths.length;
}

// onStep(text) reports progress. Ends by reloading the extension, which closes this page.
export async function installUpdate(update, onStep = () => {}) {
  let dir = await getFolder();
  if (!dir) {
    onStep('Pick the TabSync folder…');
    dir = await pickFolder();
  }
  await ensureWritable(dir);
  await assertExtensionFolder(dir);

  onStep(`Downloading v${update.version}…`);
  const res = await fetch(update.url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'] ?? new Uint8Array()) || '{}');
  if (manifest.version !== update.version) throw new Error('The downloaded zip is not the expected version.');

  onStep('Installing…');
  await writeFiles(dir, files);
  await chrome.storage.local.set({ update: { checkedAt: Date.now() }, updatedFrom: currentVersion() });

  onStep('Restarting…');
  chrome.runtime.reload();
}
