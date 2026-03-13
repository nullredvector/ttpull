// ttpull background service worker
// Wakes on alarm, collects TikTok session via content script, pushes to container

const ALARM_NAME = 'ttpull-sync';
const DEFAULT_INTERVAL_HOURS = 24;

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get({
      serverUrl: 'http://localhost:3847',
      intervalHours: DEFAULT_INTERVAL_HOURS,
      enabled: false,
      lastPush: null,
      lastStatus: null,
    }, resolve);
  });
}

async function saveSettings(patch) {
  return new Promise(resolve => {
    chrome.storage.local.set(patch, resolve);
  });
}

// ── Alarm management ─────────────────────────────────────────────────────────

async function scheduleAlarm() {
  const { intervalHours, enabled } = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (!enabled) return;
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: intervalHours * 60,
    delayInMinutes: 1,
  });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) pushSession();
});

// ── Session push ──────────────────────────────────────────────────────────────

// Collect all TikTok cookies then ask the active TikTok tab for page context.
// If no TikTok tab is open we skip the push (cookies alone aren't enough —
// we need uid/secUid from the page to build API requests).
async function pushSession({ manual = false } = {}) {
  const { serverUrl, enabled } = await getSettings();
  if (!manual && !enabled) return;
  if (!serverUrl) return;

  await saveSettings({ lastStatus: 'collecting…' });

  // 1. Cookies
  const cookies = await chrome.cookies.getAll({ domain: '.tiktok.com' });
  if (!cookies.length) {
    await saveSettings({ lastStatus: 'no TikTok cookies found — open tiktok.com first' });
    return;
  }

  // 2. Extract uid from cookies
  const cookieVal = (name) => cookies.find(c => c.name === name)?.value || '';
  const uid = cookieVal('uid_tt') || cookieVal('uid_tt_ss') || '';

  if (!uid) {
    await saveSettings({ lastStatus: 'no uid cookie — log in to tiktok.com first' });
    return;
  }

  // 3. Get browser info from an open TikTok tab (for API request params)
  let browserInfo = {
    language: 'en-US', platform: 'MacIntel',
    screenWidth: 1920, screenHeight: 1080,
    timezone: 'America/New_York',
  };
  let deviceId = '';

  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
  for (const tab of tabs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          let did = '';
          try {
            did = localStorage.getItem('tt_device_id')
               || localStorage.getItem('device_id')
               || '';
          } catch {}
          return {
            deviceId: did,
            browserInfo: {
              language: navigator.language || 'en-US',
              platform: /Win/.test(navigator.platform) ? 'Win32'
                       : /Mac/.test(navigator.platform) ? 'MacIntel'
                       : 'Linux x86_64',
              screenWidth:  screen.width,
              screenHeight: screen.height,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          };
        },
      });
      if (result?.result) {
        browserInfo = result.result.browserInfo;
        deviceId = result.result.deviceId;
        break;
      }
    } catch { /* tab may be loading */ }
  }

  // 4. Build context — secUid will be resolved by the container via API
  const ctx = { uid, secUid: '', uniqueId: '', region: 'US', deviceId, browserInfo };

  // 5. POST to container
  const payload = {
    cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain })),
    ctx,
    pushedAt: Date.now(),
  };

  try {
    const res = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const now = new Date().toLocaleString();
    await saveSettings({
      lastPush: now,
      lastStatus: res.ok ? `pushed OK at ${now}` : `server error: ${data.error || res.status}`,
    });
  } catch (err) {
    await saveSettings({ lastStatus: `connection failed: ${err.message}` });
  }
}

// ── Message handler (from popup) ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'push_now') {
    pushSession({ manual: true }).then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === 'schedule_changed') {
    scheduleAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(scheduleAlarm);
chrome.runtime.onStartup.addListener(scheduleAlarm);
