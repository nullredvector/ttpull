// ttpull background service worker
//
// Its only job is to copy the signed-in session (cookies) to the ttpull container, on demand or
// on a timer. The container does the real work in its own browser. This extension never runs
// anything inside the site's pages and never reads them: it only uses the cookies API.

const ALARM_NAME = 'ttpull-session-push';
const DEFAULT_INTERVAL_HOURS = 24;

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get({
      serverUrl: 'http://localhost:3847',
      intervalHours: DEFAULT_INTERVAL_HOURS,
      enabled: false,
      testMode: false,
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

// ── Timer: push the session every N hours ────────────────────────────────────

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

// Returns true when the container accepted the session.
async function pushSession({ manual = false } = {}) {
  const { serverUrl, enabled } = await getSettings();
  if (!manual && !enabled) return false;
  if (!serverUrl) return false;

  await saveSettings({ lastStatus: 'collecting…' });

  const cookies = await chrome.cookies.getAll({ domain: '.tiktok.com' });
  if (!cookies.length) {
    await saveSettings({ lastStatus: 'no cookies found — sign in to the site first' });
    return false;
  }

  const cookieVal = name => cookies.find(c => c.name === name)?.value || '';
  const uid = cookieVal('uid_tt') || cookieVal('uid_tt_ss') || '';
  if (!uid) {
    await saveSettings({ lastStatus: 'no uid cookie — sign in first' });
    return false;
  }

  const ctx = {
    uid, secUid: '', uniqueId: '', region: 'US', deviceId: '',
    browserInfo: {
      language: navigator.language || 'en-US',
      platform: /Win/.test(navigator.platform) ? 'Win32' : /Mac/.test(navigator.platform) ? 'MacIntel' : 'Linux x86_64',
      screenWidth: 1920, screenHeight: 1080,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };

  const payload = {
    cookies: cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    })),
    ctx,
    pushedAt: Date.now(),
  };

  try {
    const res = await fetch(`${serverUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    const now = new Date().toLocaleString();
    if (res.ok) {
      await saveSettings({ lastPush: now, lastStatus: `pushed OK at ${now}` });
      return true;
    }
    await saveSettings({ lastStatus: `server error: ${data.error || res.status}` });
  } catch (err) {
    await saveSettings({ lastStatus: `connection failed: ${err.message}` });
  }
  return false;
}

// ── Ask the container to run a sync now ──────────────────────────────────────

async function runNow({ testMode = false } = {}) {
  const { serverUrl } = await getSettings();
  if (!serverUrl) return;

  if (!(await pushSession({ manual: true }))) return; // status already explains why

  try {
    const res = await fetch(`${serverUrl}/sync${testMode ? '?test=1' : ''}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const now = new Date().toLocaleString();
    if (res.ok) {
      await saveSettings({ lastStatus: `sync started${testMode ? ' (test mode)' : ''} at ${now}` });
    } else if (res.status === 409) {
      await saveSettings({ lastStatus: 'a sync is already running on the container' });
    } else {
      await saveSettings({ lastStatus: `server error: ${data.error || res.status}` });
    }
  } catch (err) {
    await saveSettings({ lastStatus: `connection failed: ${err.message}` });
  }
}

// ── Messages from the popup ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'push_now') {
    pushSession({ manual: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'run_now') {
    runNow({ testMode: msg.testMode }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'schedule_changed') {
    scheduleAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // The timer name changed: clear any leftover timer from older versions.
  chrome.alarms.clear('ttpull-sync');
  scheduleAlarm();
});
chrome.runtime.onStartup.addListener(scheduleAlarm);
