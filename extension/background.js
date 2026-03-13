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

      // ── Resolve secUid ────────────────────────────────────────────────────
      // Required for the likes API to know whose likes to return.
      // Try multiple methods since page globals are no longer available.
      let secUid = '';

      // Method 1: look for secUid in any script tag content
      try {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const m = s.textContent.match(/"secUid"\s*:\s*"([^"]+)"/);
          if (m) { secUid = m[1]; break; }
        }
      } catch {}

      // Method 2: fetch /@me which redirects to /@username, then parse profile
      if (!secUid) {
        try {
          const res = await fetch('https://www.tiktok.com/api/user/detail/', { credentials: 'include' });
          const data = await res.json();
          secUid = data?.userInfo?.user?.secUid || '';
        } catch {}
      }

      // Method 3: try passport API
      if (!secUid) {
        try {
          const res = await fetch('https://www.tiktok.com/passport/web/account/info/', { credentials: 'include' });
          const data = await res.json();
          secUid = data?.data?.sec_uid || '';
        } catch {}
      }

      // ── Endpoint probing ──────────────────────────────────────────────────
      const LIKES_ENDPOINTS = [
        '/api/favorite/item_list/',
        '/api/user/favorite/',
      ];
      const BOOKMARK_ENDPOINTS = [
        '/api/user/collect/item_list/',
        '/api/item/bookmark/item_list/',
        '/api/user/saves/item_list/',
      ];

      const endpointList = type === 'likes' ? LIKES_ENDPOINTS : BOOKMARK_ENDPOINTS;

      // Try each endpoint with secUid included
      let workingEndpoint = null;
      let probeResponse = null;
      for (const ep of endpointList) {
        try {
          const params = new URLSearchParams({ count: '2', cursor: '0' });
          if (secUid) params.set('secUid', secUid);

          const probeUrl = `https://www.tiktok.com${ep}?${params}`;
          const res = await fetch(probeUrl, { credentials: 'include' });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { continue; }

          const sc = data.statusCode ?? data.status_code ?? -1;
          const itemCount = (data.itemList || data.item_list || []).length;
          probeResponse = { endpoint: ep, status: res.status, statusCode: sc, keys: Object.keys(data), itemCount, raw: JSON.stringify(data).slice(0, 500) };

          if (sc === 0 && itemCount > 0) {
            workingEndpoint = ep;
            break;
          }
          // Accept statusCode 0 even with 0 items as last resort
          if (sc === 0 && !workingEndpoint) {
            workingEndpoint = ep;
          }
        } catch (e) {
          probeResponse = { endpoint: ep, error: e.message };
        }
      }

      if (!workingEndpoint) {
        return { error: 'no working endpoint found', probe: probeResponse, secUid, videos: [] };
      }

      // ── Paginate ──────────────────────────────────────────────────────────
      const videos = [];
      let cursor = '0';
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          count: String(limit ? Math.min(limit, 30) : 30),
          cursor,
        });
        if (secUid) params.set('secUid', secUid);

        const url = `https://www.tiktok.com${workingEndpoint}?${params}`;
        try {
          const res = await fetch(url, { credentials: 'include' });
          const data = await res.json();
          const sc = data.statusCode ?? data.status_code ?? -1;
          if (sc !== 0) return { error: `API error ${sc}: ${data.statusMsg || data.status_msg || ''}`, secUid, videos };

          const items = data.itemList || data.item_list || [];
          if (items.length === 0) break;

          for (const item of items) {
            const vid = item.video || {};
            let videoUrl = '';

            // bitrateInfo: pick highest bitrate for best quality
            if (vid.bitrateInfo && vid.bitrateInfo.length > 0) {
              const best = vid.bitrateInfo.reduce((a, b) =>
                (b.Bitrate || b.bitrate || 0) > (a.Bitrate || a.bitrate || 0) ? b : a
              );
              videoUrl = best.PlayAddr?.UrlList?.[0]
                      || best.playAddr?.urlList?.[0]
                      || best.PlayAddr || '';
            }
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
          return { error: e.message, secUid, videos };
        }
      }

      return { videos, endpoint: workingEndpoint, secUid };
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
    console.warn('[ttpull] likes fetch error:', likesResult.error, likesResult.probe || '');
  }
  const likes = likesResult.videos || [];

  await saveSettings({ lastStatus: `got ${likes.length} likes, fetching bookmarks…` });

  // Fetch bookmarks from browser
  const bookmarksResult = await fetchVideoListInBrowser(tab, 'bookmarks', limit);
  if (bookmarksResult.error) {
    console.warn('[ttpull] bookmarks fetch error:', bookmarksResult.error, bookmarksResult.probe || '');
  }
  const bookmarks = bookmarksResult.videos || [];

  // Send debug info to container for inspection
  try {
    await fetch(`${serverUrl}/debug/fetch-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        likes: { count: likes.length, error: likesResult.error, probe: likesResult.probe, endpoint: likesResult.endpoint, secUid: likesResult.secUid },
        bookmarks: { count: bookmarks.length, error: bookmarksResult.error, probe: bookmarksResult.probe, endpoint: bookmarksResult.endpoint, secUid: bookmarksResult.secUid },
      }),
    });
  } catch {}

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
