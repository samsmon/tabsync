// E2E: AES-256-GCM with a key derived from your passphrase (PBKDF2-SHA256).
// The server only ever stores ciphertext, the salt, and a verifier blob.
const ITER = 600_000;
const VERIFIER = 'tabsync-ok';
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = {
  from: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  to: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export async function deriveKey(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64.to(saltB64), iterations: ITER },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64.from(out);
}

export async function decrypt(key, blob) {
  const raw = b64.to(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(dec.decode(pt));
}

export const newSalt = () => b64.from(crypto.getRandomValues(new Uint8Array(16)));
export const makeVerifier = (key) => encrypt(key, VERIFIER);
export async function checkVerifier(key, blob) {
  try { return (await decrypt(key, blob)) === VERIFIER; } catch { return false; }
}

// Derived key is cached per-device so the service worker can sync without re-running PBKDF2.
export const exportKey = (key) => crypto.subtle.exportKey('jwk', key);
export const importKey = (jwk) =>
  crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
