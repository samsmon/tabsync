// Identifies this browser profile. chrome.storage.local is per profile, so two Chrome
// profiles on the same PC get different ids even though their detected names match.
// Groups store both: the id for filtering, the name for display. Never synced.
const OS = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD' };

async function detect() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const brand = brands.find((b) => !/chromium|not.?a.?brand/i.test(b))?.replace(/^(Microsoft|Google) /, '') ?? 'Chrome';
  const { os } = await chrome.runtime.getPlatformInfo();
  return `${brand} on ${OS[os] ?? os}`;
}

export async function deviceId() {
  const { deviceId } = await chrome.storage.local.get('deviceId');
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

export async function deviceName() {
  const { deviceName } = await chrome.storage.local.get('deviceName');
  if (deviceName) return deviceName;
  const name = await detect();
  await chrome.storage.local.set({ deviceName: name });
  return name;
}

export async function setDeviceName(name) {
  await chrome.storage.local.set({ deviceName: name.trim() || (await detect()) });
}

// Fields stamped on every group saved here.
export const deviceMeta = async () => ({ device: await deviceName(), deviceId: await deviceId() });
