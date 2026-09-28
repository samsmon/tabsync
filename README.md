# TabSync

OneTab-style tab collapser with end-to-end encrypted sync across devices.
Server: Go + SQLite (stores ciphertext only). Extension: Svelte 5, Chrome MV3.

## Server (homelab)
```bash
echo "TABSYNC_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```
Put it behind your reverse proxy with HTTPS (the token travels in a header).

## Extension
```bash
cd ext && npm install && npm run build
```
Chrome → `chrome://extensions` → Developer mode → Load unpacked → `ext/dist`.
Open the extension's options, enter server URL, token, and a passphrase (same on every device).

## How sync works
- Each tab and each group's meta (name, lock, star) is its own record, encrypted client-side (AES-256-GCM, PBKDF2 600k).
- Push dirty records, pull by server `seq` cursor; last-writer-wins per record on client `ts`, so edits to different tabs never clobber each other. Deleting a group hides its tabs, including ones added concurrently elsewhere.
- Deletes are tombstones. Sync runs on save, on list open, and every minute via `chrome.alarms`.
