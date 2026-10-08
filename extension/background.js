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
// Runs in the page's own JS context and calls the page's (signing) window.fetch
// with the same parameter set the site uses, then pages with cursor/hasMore.
// No navigation or interception is needed: the page's fetch adds the
// anti-bot signatures to any request it makes to its own API.

async function fetchVideoListInBrowser(tab, type, limit) {
  const exec = chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (type, limit) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const diag = { pages: [] };

      // ── App context (device id, region, user) ─────────────────────────────
      const readCtx = async () => {
        try {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
          const c = el && JSON.parse(el.textContent)?.__DEFAULT_SCOPE__?.['webapp.app-context'];
          if (c?.wid || c?.$wid) return { src: 'state', c };
        } catch {}
        try {
          const r = await fetch('/node-webapp/api/app-context');
          const c = await r.json();
          if (c?.statusCode === 0 || c?.$wid || c?.wid) return { src: 'api', c };
        } catch {}
        return null;
      };
      const got = await readCtx();
      if (!got) return { error: 'no app context', diag, videos: [] };
      const c = got.c;
      // Normalise both shapes ($wid style and plain style)
      const ctx = {
        wid:    c.$wid || c.wid,
        region: c.$region || c.region,
        os:     c.$os || c.os,
        lang:   c.$language || c.language,
        user:   c.$user || c.user || {},
        mApi:   (c.$domains || c.domains || {}).mTApi,
      };
      diag.ctx = {
        src: got.src, hasWid: !!ctx.wid, region: ctx.region, os: ctx.os, lang: ctx.lang,
        userKeys: Object.keys(ctx.user), mApi: ctx.mApi || null,
      };
      if (!ctx.user.secUid) return { error: 'no secUid in app context', diag, videos: [] };

      // ── Build the same parameter set the site uses ────────────────────────
      const base = (ctx.mApi && ctx.mApi.startsWith('https://')) ? ctx.mApi : 'https://m.tiktok.com';
      const common = () => ({
        aid: '1988', app_name: 'tiktok_web', channel: 'tiktok_web', device_platform: 'web_pc',
        referer: document.referrer, cookie_enabled: navigator.cookieEnabled,
        screen_width: screen.width, screen_height: screen.height,
        browser_language: navigator.language, browser_platform: navigator.platform,
        browser_name: navigator.appCodeName, browser_version: navigator.appVersion,
        browser_online: navigator.onLine,
        verifyFp: (document.cookie.match(/s_v_web_id=(\w+)/) || [])[1],
        is_page_visible: true, focus_state: true,
        is_fullscreen: window.matchMedia('(display-mode: fullscreen)').matches,
        history_len: window.history.length, battery_info: 1,
        tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
        device_id: ctx.wid, region: ctx.region,
        priority_region: ctx.user.region, os: ctx.os,
        app_language: ctx.lang, webcast_language: ctx.lang,
        from_page: 'user', secUid: ctx.user.secUid, language: ctx.lang,
      });
      const buildUrl = (path, extra) => {
        const u = new URL(base + path);
        for (const [k, v] of Object.entries({ ...common(), ...extra })) {
          u.searchParams.set(k, v == null ? '' : String(v));
        }
        return u.toString();
      };

      // ── Endpoints to try, in order ────────────────────────────────────────
      const variants = type === 'likes'
        ? [{ name: 'favorite', path: '/api/favorite/item_list/', extra: {} }]
        : [
            { name: 'collect', path: '/api/user/collect/item_list/', extra: { sourceType: 113 } },
            { name: 'collect-plain', path: '/api/user/collect/item_list/', extra: {} },
          ];

      const pageFetch = async (v, cursor) => {
        const r = await window.fetch(buildUrl(v.path, { ...v.extra, cursor, count: 30 }), { credentials: 'include' });
        const text = await r.text();
        let j = null;
        try { j = JSON.parse(text); } catch {}
        return { http: r.status, j, len: text.length };
      };

      const items = [];
      let usedVariant = null;
      for (const v of variants) {
        let cursor = '0', hasMore = true, firstPage = true, seenCursors = new Set(), bad = 0;
        const got = [];
        while (hasMore && (limit === 0 || got.length < limit)) {
          await sleep(1200);
          let res;
          try { res = await pageFetch(v, cursor); } catch (e) { diag.pages.push({ v: v.name, err: String(e) }); break; }
          const j = res.j;
          diag.pages.push({
            v: v.name, cursor, http: res.http, len: res.len,
            status: j?.statusCode ?? j?.status_code ?? null, msg: j?.status_msg || j?.message || null,
            n: (j?.itemList || j?.item_list || []).length, hasMore: j?.hasMore ?? null,
          });
          if (!j || (j.statusCode ?? j.status_code ?? 0) !== 0) {
            if (++bad > 2) break;
            continue;
          }
          bad = 0;
          const list = j.itemList || j.item_list || [];
          got.push(...list);
          hasMore = !!j.hasMore;
          const next = String(j.cursor ?? '');
          if (!next || next === '0' || next === '-1' || seenCursors.has(next)) break;
          seenCursors.add(next);
          cursor = next;
          firstPage = false;
          if (diag.pages.length > 400) break;
        }
        if (got.length) { items.push(...got); usedVariant = v.name; break; }
      }
      diag.usedVariant = usedVariant;

      // ── Parse (best quality available) ────────────────────────────────────
      const videos = [];
      const seenIds = new Set();
      for (const item of items) {
        if (!item?.id || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
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

      return { videos, uniqueId: ctx.user.uniqueId || '', secUid: ctx.user.secUid, diag };
    },
    args: [type, limit],
  });

  const timeoutMs = limit > 0 ? 120000 : 30 * 60 * 1000;
  let result;
  try {
    [result] = await Promise.race([
      exec,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
  } catch (err) {
    return { error: `script failed: ${err.message}`, videos: [] };
  }

  return result?.result || { error: 'script execution failed', videos: [] };
}

// Send the tab to a neutral page and wait for it, so every list starts from
// the same place regardless of where the previous one ended up.
async function resetTab(tab) {
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
  await new Promise(r => setTimeout(r, 2500));
  return chrome.tabs.get(tab.id);
}

function trimDiag(d) {
  if (!d?.pages) return d;
  return { ...d, pages: d.pages.length > 12 ? [...d.pages.slice(0, 6), ...d.pages.slice(-6)] : d.pages, pageCount: d.pages.length };
}

// ── Run full sync (fetch lists in browser → send to container for download) ──

async function runFullSync({ testMode = false } = {}) {
  // Extension API calls reset the worker's idle timer; without this Chrome
  // can stop the worker partway through a long browser step.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    await runFullSyncInner({ testMode });
  } catch (err) {
    await saveSettings({ lastStatus: `sync failed: ${err.message}` });
  } finally {
    clearInterval(keepAlive);
  }
}

async function runFullSyncInner({ testMode = false } = {}) {
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

  if (/tiktok\.com\/(404|error)/.test(tab.url || '')) tab = await resetTab(tab);

  await saveSettings({ lastStatus: 'fetching liked videos…' });

  // Fetch likes from browser
  const likesResult = await fetchVideoListInBrowser(tab, 'likes', limit);
  if (likesResult.error) {
    console.warn('[ttpull] likes fetch error:', likesResult.error);
  }
  const likes = likesResult.videos || [];

  await saveSettings({ lastStatus: `got ${likes.length} likes, fetching bookmarks…` });

  // Fetch bookmarks from browser
  await saveSettings({ lastStatus: 'fetching bookmarks…' });
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
        likes:     { count: likes.length,     error: likesResult.error,     uniqueId: likesResult.uniqueId,     diag: trimDiag(likesResult.diag) },
        bookmarks: { count: bookmarks.length, error: bookmarksResult.error, uniqueId: bookmarksResult.uniqueId, diag: trimDiag(bookmarksResult.diag) },
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
