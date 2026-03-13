// ttpull background service worker
// Wakes on alarm, collects TikTok session via content script, pushes to container.
// Also fetches liked/bookmarked video lists from the browser (where anti-bot
// signatures are auto-applied) and sends metadata to the container for download.

const ALARM_NAME = 'ttpull-sync';
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
  if (alarm.name === ALARM_NAME) runFullSync();
});

// ── Find a TikTok tab ────────────────────────────────────────────────────────

async function findTikTokTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
  return tabs[0] || null;
}

// ── Session push ──────────────────────────────────────────────────────────────

async function pushSession({ manual = false } = {}) {
  const { serverUrl, enabled } = await getSettings();
  if (!manual && !enabled) return;
  if (!serverUrl) return;

  await saveSettings({ lastStatus: 'collecting…' });

  // 1. Cookies
  const cookies = await chrome.cookies.getAll({ domain: '.tiktok.com' });
  if (!cookies.length) {
    await saveSettings({ lastStatus: 'no cookies found — open the site first' });
    return;
  }

  // 2. Extract uid from cookies
  const cookieVal = (name) => cookies.find(c => c.name === name)?.value || '';
  const uid = cookieVal('uid_tt') || cookieVal('uid_tt_ss') || '';

  if (!uid) {
    await saveSettings({ lastStatus: 'no uid cookie — log in first' });
    return;
  }

  // 3. Get browser info from an open tab
  let browserInfo = {
    language: 'en-US', platform: 'MacIntel',
    screenWidth: 1920, screenHeight: 1080,
    timezone: 'America/New_York',
  };
  let deviceId = '';

  const tab = await findTikTokTab();
  if (tab) {
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
      }
    } catch { /* tab may be loading */ }
  }

  // 4. Build context
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

// ── Fetch video lists from browser ──────────────────────────────────────────
// This runs in the TikTok page context where anti-bot signatures are auto-applied.

async function fetchVideoListInBrowser(tab, type, limit) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (type, limit) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // Use XMLHttpRequest — TikTok's anti-bot code patches XHR to add
      // X-Bogus / _signature automatically. fetch() may not get patched.
      function xhrGet(url) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.withCredentials = true;
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try { resolve(JSON.parse(xhr.responseText)); }
              catch { reject(new Error(`non-JSON response (${xhr.responseText.length} chars)`)); }
            } else {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error('network error'));
          xhr.ontimeout = () => reject(new Error('timeout'));
          xhr.timeout = 15000;
          xhr.send();
        });
      }

      // Extract cookies for params
      const cookies = document.cookie.split(';').reduce((acc, c) => {
        const [k, ...v] = c.trim().split('=');
        acc[k] = v.join('=');
        return acc;
      }, {});

      // Build query params matching what the site's own code sends
      function buildParams(cursor) {
        const p = new URLSearchParams({
          aid:              '1988',
          app_language:     navigator.language?.split('-')[0] || 'en',
          app_name:         'tiktok_web',
          browser_language: navigator.language || 'en-US',
          browser_name:     'Mozilla',
          browser_online:   'true',
          browser_platform: navigator.platform || 'MacIntel',
          browser_version:  '5.0',
          channel:          'tiktok_web',
          cookie_enabled:   'true',
          device_platform:  'web_pc',
          focus_state:      'true',
          from_page:        'user',
          history_len:      String(history.length),
          is_fullscreen:    'false',
          is_page_visible:  'true',
          os:               /Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'windows' : 'linux',
          priority_region:  '',
          referer:          '',
          region:           'US',
          screen_height:    String(screen.height),
          screen_width:     String(screen.width),
          tz_name:          Intl.DateTimeFormat().resolvedOptions().timeZone,
          webcast_language: navigator.language?.split('-')[0] || 'en',
          msToken:          cookies.msToken || '',
          count:            String(limit ? Math.min(limit, 30) : 30),
          cursor:           cursor,
        });
        // Add secUid for likes
        if (type === 'likes') {
          p.set('secUid', cookies.secUid || '');
        }
        return p;
      }

      // Determine endpoint
      const endpoints = {
        likes:     'https://www.tiktok.com/api/favorite/item_list/',
        bookmarks: 'https://www.tiktok.com/api/user/collect/item_list/',
      };
      const endpoint = endpoints[type];
      if (!endpoint) return { error: `unknown type: ${type}` };

      const videos = [];
      let cursor = '0';
      let hasMore = true;

      while (hasMore) {
        const params = buildParams(cursor);
        const url = `${endpoint}?${params}`;
        try {
          const data = await xhrGet(url);
          const sc = data.statusCode ?? data.status_code ?? -1;
          if (sc !== 0) return { error: `API error ${sc}: ${data.statusMsg || data.status_msg || ''}`, videos };

          const items = data.itemList || data.item_list || [];
          if (items.length === 0) break;

          for (const item of items) {
            // Prefer highest quality: downloadAddr > bitrateInfo max > playAddr
            const vid = item.video || {};
            let videoUrl = '';

            // bitrateInfo contains all quality levels — pick the highest bitrate
            if (vid.bitrateInfo && vid.bitrateInfo.length > 0) {
              const best = vid.bitrateInfo.reduce((a, b) =>
                (b.Bitrate || b.bitrate || 0) > (a.Bitrate || a.bitrate || 0) ? b : a
              );
              videoUrl = best.PlayAddr?.UrlList?.[0]
                      || best.playAddr?.urlList?.[0]
                      || best.PlayAddr || '';
            }

            // downloadAddr is usually the original quality
            if (!videoUrl) videoUrl = vid.downloadAddr || '';
            if (!videoUrl) videoUrl = vid.playAddr || '';

            videos.push({
              id:         item.id,
              desc:       item.desc || '',
              authorId:   item.author?.id || '',
              authorName: item.author?.uniqueId || '',
              coverUrl:   vid.originCover || vid.cover || '',
              videoUrl,
              duration:   vid.duration || 0,
              createTime: item.createTime || 0,
            });
            if (limit && videos.length >= limit) break;
          }

          if (limit && videos.length >= limit) break;

          hasMore = data.hasMore ?? false;
          cursor = String(data.cursor || 0);

          await sleep(800 + Math.random() * 400);
        } catch (e) {
          return { error: e.message, videos };
        }
      }

      return { videos };
    },
    args: [type, limit],
  });

  return result?.result || { error: 'script execution failed' };
}

// ── Run full sync (fetch lists in browser → send to container for download) ──

async function runFullSync({ testMode = false } = {}) {
  const { serverUrl, enabled, testMode: savedTestMode } = await getSettings();
  const useTestMode = testMode || savedTestMode;
  const limit = useTestMode ? 2 : 0;

  if (!serverUrl) {
    await saveSettings({ lastStatus: 'no server URL configured' });
    return;
  }

  // Ensure session is pushed first
  await pushSession({ manual: true });

  const tab = await findTikTokTab();
  if (!tab) {
    await saveSettings({ lastStatus: 'no open tab — open the site first' });
    return;
  }

  await saveSettings({ lastStatus: 'fetching liked videos…' });

  // Fetch likes from browser
  const likesResult = await fetchVideoListInBrowser(tab, 'likes', limit);
  if (likesResult.error) {
    console.warn('[ttpull] likes fetch error:', likesResult.error);
  }
  const likes = likesResult.videos || [];

  await saveSettings({ lastStatus: `got ${likes.length} likes, fetching bookmarks…` });

  // Fetch bookmarks from browser
  const bookmarksResult = await fetchVideoListInBrowser(tab, 'bookmarks', limit);
  if (bookmarksResult.error) {
    console.warn('[ttpull] bookmarks fetch error:', bookmarksResult.error);
  }
  const bookmarks = bookmarksResult.videos || [];

  await saveSettings({ lastStatus: `got ${likes.length} likes + ${bookmarks.length} bookmarks, sending to container…` });

  // Send metadata to container for download
  try {
    const res = await fetch(`${serverUrl}/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ likes, bookmarks }),
    });
    const data = await res.json();
    const now = new Date().toLocaleString();
    await saveSettings({
      lastStatus: res.ok
        ? `sent ${likes.length} likes + ${bookmarks.length} bookmarks at ${now}`
        : `server error: ${data.error || res.status}`,
    });
  } catch (err) {
    await saveSettings({ lastStatus: `connection failed: ${err.message}` });
  }
}

// ── Message handler (from popup) ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'push_now') {
    pushSession({ manual: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'run_now') {
    runFullSync({ testMode: msg.testMode }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'schedule_changed') {
    scheduleAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(scheduleAlarm);
chrome.runtime.onStartup.addListener(scheduleAlarm);
