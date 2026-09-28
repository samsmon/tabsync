// A readable name for this browser, stamped on groups it creates ("Edge on Windows").
// Kept per device in chrome.storage.local (never synced), so it can be renamed in Settings.
const OS = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD' };

async function detect() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const brand = brands.find((b) => !/chromium|not.?a.?brand/i.test(b))?.replace(/^(Microsoft|Google) /, '') ?? 'Chrome';
  const { os } = await chrome.runtime.getPlatformInfo();
  return `${brand} on ${OS[os] ?? os}`;
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
