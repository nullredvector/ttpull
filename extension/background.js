// ttpull background service worker
// Wakes on alarm, collects session via content script, pushes to container.
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

// ── Find a tab ────────────────────────────────────────────────────────────────

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
// Patches the page's fetch/XHR, then uses SPA navigation (Next.js router or
// history API) to navigate to the likes/saved tab WITHOUT a full page reload.
// This keeps the injected script alive so it can capture the API responses
// that the site makes with its own anti-bot signatures.

async function fetchVideoListInBrowser(tab, type, limit) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (type, limit) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // ── Intercept API responses ───────────────────────────────────────────
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

      // Patch XHR
      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      const xhrUrls = new WeakMap();
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        xhrUrls.set(this, String(url));
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        const url = xhrUrls.get(this) || '';
        if (targetPaths.some(p => url.includes(p))) {
          this.addEventListener('load', () => {
            if (this.status === 200) {
              try { captured.push(JSON.parse(this.responseText)); } catch {}
            }
          });
        }
        return origXHRSend.apply(this, args);
      };

      const restore = () => {
        window.fetch = origFetch;
        XMLHttpRequest.prototype.open = origXHROpen;
        XMLHttpRequest.prototype.send = origXHRSend;
      };

      // ── Resolve secUid and uniqueId ───────────────────────────────────────
      let secUid = '', uniqueId = '';

      const bad = u => !u || /^(somevalue|undefined|null)$/i.test(u);

      // 1. Sidebar profile link (logged-in user's own profile)
      try {
        const link = document.querySelector('[data-e2e="nav-profile"], a[data-e2e="profile-icon"]');
        const m = link?.getAttribute('href')?.match(/@([^/?&#]+)/);
        if (m) uniqueId = decodeURIComponent(m[1]);
      } catch {}

      // 2. Passport account info
      if (bad(uniqueId)) {
        uniqueId = '';
        try {
          const res = await origFetch('/passport/web/account/info/', { credentials: 'include' });
          const data = await res.json();
          secUid   = secUid   || data?.data?.sec_uid  || '';
          uniqueId = data?.data?.username || '';
        } catch {}
      }

      // 3. Own-profile link elsewhere in the DOM
      if (bad(uniqueId)) {
        uniqueId = '';
        try {
          for (const a of document.querySelectorAll('a[href*="/@"]')) {
            const m = a.getAttribute('href').match(/^\/@([^/?&#]+)\/?$/);
            if (m && !bad(m[1])) { uniqueId = decodeURIComponent(m[1]); break; }
          }
        } catch {}
      }

      // 4. Embedded app state JSON (logged-in user lives under app-context)
      if (bad(uniqueId)) {
        uniqueId = '';
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          const st = el ? JSON.parse(el.textContent) : null;
          const ctx = st?.__DEFAULT_SCOPE__?.['webapp.app-context'];
          const u = ctx?.user || ctx?.currentUser || {};
          uniqueId = u.uniqueId || '';
          secUid   = secUid || u.secUid || '';
        } catch {}
      }

      // 5. Any link whose text/aria says Profile
      if (bad(uniqueId)) {
        uniqueId = '';
        try {
          for (const a of document.querySelectorAll('a[href^="/@"]')) {
            const label = (a.getAttribute('aria-label') || a.textContent || '').toLowerCase();
            const m = a.getAttribute('href').match(/^\/@([^/?&#]+)/);
            if (m && label.includes('profile') && !bad(m[1])) { uniqueId = decodeURIComponent(m[1]); break; }
          }
        } catch {}
      }

      if (!uniqueId) {
        restore();
        return {
          error: 'could not resolve username', secUid, videos: [],
          diag: {
            url: location.href,
            hasState: !!document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__'),
            navProfile: document.querySelector('[data-e2e="nav-profile"]')?.outerHTML?.slice(0, 200) || null,
            atLinks: [...document.querySelectorAll('a[href^="/@"]')].slice(0, 8)
              .map(a => `${a.getAttribute('href')} | ${(a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30)}`),
          },
        };
      }

      const currentUrl = location.href;
      const tabParam = type === 'likes' ? 'liked' : 'favorites';
      const targetPath = `/@${uniqueId}?tab=${tabParam}`;

      // ── SPA navigation — keeps this script alive ──────────────────────────
      // Use the site's own client-side router so no full page reload occurs.
      // Full page reloads destroy the patched fetch/XHR and this execution context.
      let navigated = false;

      // Method 1: Next.js router (most reliable for Next.js apps)
      try {
        const router = window.next?.router;
        if (router?.push) {
          router.push(targetPath);
          navigated = true;
        }
      } catch {}

      // Method 2: history.pushState + synthetic popstate
      // React Router and Next.js both listen to popstate for SPA navigation.
      if (!navigated) {
        try {
          history.pushState({}, '', targetPath);
          window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
          navigated = true;
        } catch {}
      }

      if (!navigated) {
        restore();
        return { error: 'could not trigger SPA navigation', secUid, videos: [] };
      }

      // ── Wait for API calls ────────────────────────────────────────────────
      const start = Date.now();
      while (captured.length === 0 && Date.now() - start < 15000) {
        await sleep(500);
      }

      // ── Scroll to trigger pagination ──────────────────────────────────────
      const countItems = () => captured.reduce(
        (n, d) => n + (d.itemList?.length || d.item_list?.length || 0), 0
      );
      const maxScrolls = limit > 0 ? 3 : 12;
      for (let i = 0; i < maxScrolls; i++) {
        if (limit > 0 && countItems() >= limit) break;
        window.scrollBy({ top: 3000, behavior: 'smooth' });
        await sleep(2500);
      }
      await sleep(1000);

      // ── Navigate back ─────────────────────────────────────────────────────
      try {
        const router = window.next?.router;
        if (router?.push) {
          router.push(currentUrl);
        } else {
          history.pushState({}, '', currentUrl);
          window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
        }
      } catch {}

      restore();

      // ── Parse captured responses ──────────────────────────────────────────
      const videos = [];
      for (const data of captured) {
        const items = data.itemList || data.item_list || [];
        for (const item of items) {
          const vid = item.video || {};
          let videoUrl = '';

          if (vid.bitrateInfo?.length > 0) {
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
          if (limit > 0 && videos.length >= limit) break;
        }
        if (limit > 0 && videos.length >= limit) break;
      }

      return {
        videos,
        secUid,
        uniqueId,
        capturedResponses: captured.length,
        navigatedTo: targetPath,
      };
    },
    args: [type, limit],
  });

  return result?.result || { error: 'script execution failed', videos: [] };
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

  let tab = await findTikTokTab();
  if (!tab) {
    await saveSettings({ lastStatus: 'no open tab — open the site first' });
    return;
  }

  // A tab stranded on an error page has no profile data — reset it first.
  if (/tiktok\.com\/(404|error)/.test(tab.url || '')) {
    await chrome.tabs.update(tab.id, { url: 'https://www.tiktok.com/foryou' });
    await new Promise(resolve => {
      const onUpdated = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 20000);
    });
    await new Promise(r => setTimeout(r, 2000));
    tab = await chrome.tabs.get(tab.id);
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

  // Send debug info to container
  try {
    await fetch(`${serverUrl}/debug/fetch-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        likes:     { count: likes.length,     error: likesResult.error,     diag: likesResult.diag,     secUid: likesResult.secUid,     uniqueId: likesResult.uniqueId,     capturedResponses: likesResult.capturedResponses,     navigatedTo: likesResult.navigatedTo },
        bookmarks: { count: bookmarks.length, error: bookmarksResult.error, diag: bookmarksResult.diag, secUid: bookmarksResult.secUid, uniqueId: bookmarksResult.uniqueId, capturedResponses: bookmarksResult.capturedResponses, navigatedTo: bookmarksResult.navigatedTo },
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
