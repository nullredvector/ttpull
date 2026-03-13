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
async function pushSession() {
  const { serverUrl, enabled } = await getSettings();
  if (!enabled || !serverUrl) return;

  await saveSettings({ lastStatus: 'collecting…' });

  // 1. Cookies
  const cookies = await chrome.cookies.getAll({ domain: '.tiktok.com' });
  if (!cookies.length) {
    await saveSettings({ lastStatus: 'no TikTok cookies found — open tiktok.com first' });
    return;
  }

  // 2. Page context from an open TikTok tab
  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
  if (!tabs.length) {
    await saveSettings({ lastStatus: 'no TikTok tab open — navigate to tiktok.com first' });
    return;
  }

  let pageCtx = null;
  for (const tab of tabs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__TTPULL_CTX__ || null,
      });
      if (result?.result) { pageCtx = result.result; break; }
    } catch { /* tab may be loading */ }
  }

  if (!pageCtx) {
    await saveSettings({ lastStatus: 'could not read page context — reload tiktok.com' });
    return;
  }

  // 3. POST to container
  const payload = {
    cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain })),
    ctx: pageCtx,
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
    pushSession().then(() => sendResponse({ ok: true }));
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
