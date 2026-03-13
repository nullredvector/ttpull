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
  // Strategy: intercept XHR/fetch responses by patching the page's network
  // layer, then trigger a navigation to the likes/bookmarks tab so TikTok's
  // own code makes the API call with all required anti-bot signatures.

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (type, limit) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // ── Intercept API responses ───────────────────────────────────────────
      // Patch fetch to capture responses from the favorites/bookmarks endpoint
      const captured = [];
      const targetPaths = type === 'likes'
        ? ['/api/favorite/item_list']
        : ['/api/user/collect/item_list', '/api/item/bookmark/item_list', '/api/user/saves/item_list'];

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await origFetch.apply(this, args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (targetPaths.some(p => url.includes(p))) {
          try {
            const clone = response.clone();
            const data = await clone.json();
            captured.push(data);
          } catch {}
        }
        return response;
      };

      // Also patch XHR
      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      const xhrUrls = new WeakMap();
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        xhrUrls.set(this, url);
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        const xhr = this;
        const url = xhrUrls.get(this) || '';
        if (targetPaths.some(p => url.includes(p))) {
          const origHandler = xhr.onreadystatechange;
          xhr.onreadystatechange = function() {
            if (xhr.readyState === 4 && xhr.status === 200) {
              try { captured.push(JSON.parse(xhr.responseText)); } catch {}
            }
            if (origHandler) origHandler.apply(this, arguments);
          };
          xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
              try { captured.push(JSON.parse(xhr.responseText)); } catch {}
            }
          });
        }
        return origXHRSend.apply(this, args);
      };

      // ── Resolve secUid and uniqueId for navigation ────────────────────────
      let secUid = '', uniqueId = '';
      try {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const m = s.textContent.match(/"secUid"\s*:\s*"([^"]+)"/);
          if (m) { secUid = m[1]; break; }
        }
      } catch {}
      if (!secUid) {
        try {
          const res = await origFetch('https://www.tiktok.com/api/user/detail/', { credentials: 'include' });
          const data = await res.json();
          secUid = data?.userInfo?.user?.secUid || '';
          uniqueId = data?.userInfo?.user?.uniqueId || '';
        } catch {}
      }
      if (!secUid) {
        try {
          const res = await origFetch('https://www.tiktok.com/passport/web/account/info/', { credentials: 'include' });
          const data = await res.json();
          secUid = data?.data?.sec_uid || '';
          uniqueId = data?.data?.username || '';
        } catch {}
      }

      // ── Navigate to profile likes/bookmarks tab to trigger API call ───────
      // We need to figure out the username for navigation
      if (!uniqueId) {
        try {
          // Try to get username from the profile link in the page
          const profileLink = document.querySelector('a[href*="/@"]');
          if (profileLink) {
            const m = profileLink.href.match(/@([^/?]+)/);
            if (m) uniqueId = m[1];
          }
        } catch {}
      }
      if (!uniqueId) {
        try {
          // Try /@me redirect
          const res = await origFetch('https://www.tiktok.com/@me', { credentials: 'include', redirect: 'follow' });
          const m = res.url.match(/@([^/?]+)/);
          if (m) uniqueId = m[1];
        } catch {}
      }

      // Navigate using SPA navigation by updating the URL
      const tabPath = type === 'likes' ? 'liked' : 'saved';
      const targetUrl = uniqueId
        ? `https://www.tiktok.com/@${uniqueId}?tab=${tabPath}`
        : null;

      if (targetUrl) {
        // Use history.pushState + popstate to trigger SPA navigation
        const currentUrl = location.href;
        window.location.href = targetUrl;

        // Wait for the API response to be captured
        const maxWait = 15000;
        const start = Date.now();
        while (captured.length === 0 && Date.now() - start < maxWait) {
          await sleep(500);
        }

        // Navigate back to where we were
        await sleep(1000);
        window.location.href = currentUrl;
      } else {
        // Can't navigate — restore and return error
        window.fetch = origFetch;
        XMLHttpRequest.prototype.open = origXHROpen;
        XMLHttpRequest.prototype.send = origXHRSend;
        return { error: 'could not resolve username for navigation', secUid, videos: [] };
      }

      // Wait a bit more for any additional captures
      await sleep(2000);

      // Restore original fetch/XHR
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origXHROpen;
      XMLHttpRequest.prototype.send = origXHRSend;

      // ── Parse captured responses ──────────────────────────────────────────
      const videos = [];
      for (const data of captured) {
        const items = data.itemList || data.item_list || [];
        for (const item of items) {
          const vid = item.video || {};
          let videoUrl = '';

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
      }

      return {
        videos,
        secUid,
        uniqueId,
        capturedResponses: captured.length,
        navigatedTo: targetUrl,
      };
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
        likes: { count: likes.length, error: likesResult.error, probes: likesResult.probes, endpoint: likesResult.endpoint, secUid: likesResult.secUid },
        bookmarks: { count: bookmarks.length, error: bookmarksResult.error, probes: bookmarksResult.probes, endpoint: bookmarksResult.endpoint, secUid: bookmarksResult.secUid },
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
