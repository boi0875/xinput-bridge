// Settings live in chrome.storage.sync. relay.js (a classic content script that
// can't import this module) reads `toasts` and `disabledSites` with the same
// defaults, so keep the two in step.

export const DEFAULT_SETTINGS = Object.freeze({
  deadzone: 0.04,        // radial stick deadzone, 0..0.3
  rumble: true,
  rumbleStrength: 1,     // 0..1
  toasts: true,          // on-page "controller connected" notices
  identity: 'xbox',      // 'xbox': report as a Microsoft pad; 'device': real name and USB ids
  disabledSites: [],     // hostnames where the bridge stays out of the way
});

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(patch) {
  return chrome.storage.sync.set(patch);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULT_SETTINGS) patch[key] = newValue ?? DEFAULT_SETTINGS[key];
    }
    if (Object.keys(patch).length) callback(patch);
  });
}

export function hostnameOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u.hostname || 'local files' : null;
  } catch {
    return null;
  }
}
