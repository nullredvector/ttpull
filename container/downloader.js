// ttpull downloader
// Uses TikTok's internal API endpoints (same ones the browser uses) with the
// session cookies supplied by the extension. No browser required.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, 'archive');

// ── Job state (shared with server.js via getJobState) ────────────────────────

let jobState = {
  running:   false,
  phase:     null,
  progress:  null,
  lastRun:   null,
  lastError: null,
  counts:    { likes: 0, bookmarks: 0, skipped: 0 },
};

export function getJobState() { return { ...jobState }; }

// ── Cookie helpers ────────────────────────────────────────────────────────────

function buildCookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function getCookieValue(cookies, name) {
  return cookies.find(c => c.name === name)?.value || '';
}

// verifyFp is derived from s_v_web_id cookie — same logic as s.js
function getVerifyFp(cookies) {
  const raw = getCookieValue(cookies, 's_v_web_id');
  const m = raw.match(/verify_([a-f0-9]+)_([a-f0-9]+)/);
  return m ? `verify_${m[1]}_${m[2]}` : raw;
}

// ── Base request headers (mimics the browser's requests from s.js) ────────────

function buildHeaders(cookies, ctx) {
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': ctx.browserInfo?.language || 'en-US,en;q=0.9',
    'cookie': buildCookieHeader(cookies),
    'referer': 'https://www.tiktok.com/',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
  };
}

// ── Common API query params (mirrors s.js logic) ──────────────────────────────

function baseParams(cookies, ctx) {
  const deviceId = ctx.deviceId || String(Math.floor(Math.random() * 9e18) + 1e18);
  return new URLSearchParams({
    aid:             '1988',
    app_language:    ctx.browserInfo?.language?.split('-')[0] || 'en',
    app_name:        'tiktok_web',
    browser_language: ctx.browserInfo?.language || 'en-US',
    browser_name:    'Mozilla',
    browser_online:  'true',
    browser_platform: ctx.browserInfo?.platform || 'MacIntel',
    browser_version: '5.0',
    channel:         'tiktok_web',
    cookie_enabled:  'true',
    device_id:       deviceId,
    device_platform: 'web_pc',
    focus_state:     'true',
    from_page:       'user',
    history_len:     '2',
    is_fullscreen:   'false',
    is_page_visible: 'true',
    os:              'mac',
    priority_region: ctx.region || 'US',
    referer:         '',
    region:          ctx.region || 'US',
    screen_height:   String(ctx.browserInfo?.screenHeight || 1080),
    screen_width:    String(ctx.browserInfo?.screenWidth  || 1920),
    tz_name:         ctx.browserInfo?.timezone || 'America/New_York',
    verifyFp:        getVerifyFp(cookies),
    webcast_language: ctx.browserInfo?.language?.split('-')[0] || 'en',
    msToken:         getCookieValue(cookies, 'msToken'),
  });
}

// ── Fetch with retry ──────────────────────────────────────────────────────────

async function fetchJson(url, headers, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 429) {
        const wait = 10000 * (i + 1);
        console.log(`[fetch] rate limited, waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        // Not JSON — likely a CAPTCHA or login page
        console.error(`[fetch] non-JSON response (${text.length} chars): ${text.slice(0, 200)}`);
        throw new Error('non-JSON response (possible CAPTCHA or auth redirect)');
      }
    } catch (e) {
      console.log(`[fetch] attempt ${i + 1}/${retries} failed: ${e.message}`);
      if (i === retries - 1) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

async function fetchBinary(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Resolve secUid if missing ─────────────────────────────────────────────────
// TikTok no longer exposes __NEXT_DATA__ / SIGI_STATE on the page, so the
// extension may only have uid from cookies. We call the user detail API to
// get secUid which is required for the likes endpoint.

async function resolveSecUid(cookies, ctx) {
  if (ctx.secUid) return ctx.secUid;
  console.log(`[resolve] uid=${ctx.uid || '(none)'}, attempting to resolve secUid…`);
  if (!ctx.uid) return '';

  const headers = buildHeaders(cookies, ctx);
  const params = baseParams(cookies, ctx);
  params.set('from_page', 'user');

  // Try the passport/web/account/info endpoint first (returns logged-in user info)
  try {
    const url = `https://www.tiktok.com/passport/web/account/info/?${params}`;
    const data = await fetchJson(url, headers);
    const secUid = data?.data?.user_id_str ? '' : (data?.data?.sec_uid || '');
    if (secUid) {
      console.log(`[resolve] got secUid from passport API`);
      return secUid;
    }
  } catch (e) {
    console.log(`[resolve] passport API failed: ${e.message}`);
  }

  // Fallback: scrape the profile page for secUid in the HTML
  try {
    const profileUrl = 'https://www.tiktok.com/@me';
    const res = await fetch(profileUrl, { headers: { ...headers, 'accept': 'text/html' }, redirect: 'follow' });
    const html = await res.text();
    const m = html.match(/"secUid"\s*:\s*"([^"]+)"/);
    if (m) {
      console.log(`[resolve] got secUid from profile page`);
      return m[1];
    }
  } catch (e) {
    console.log(`[resolve] profile scrape failed: ${e.message}`);
  }

  console.warn('[resolve] could not resolve secUid — likes API may fail');
  return '';
}

// ── Likes API ─────────────────────────────────────────────────────────────────
// GET https://m.tiktok.com/api/favorite/item_list/
// Paginates via cursor. Returns all liked video metadata.

async function fetchLikedVideos(cookies, ctx, limit = 0) {
  const headers = buildHeaders(cookies, ctx);
  const videos  = [];
  let cursor    = '0';
  let hasMore   = true;
  let page      = 0;
  const fetchCount = limit ? Math.min(limit, 30) : 30;

  while (hasMore) {
    const params = baseParams(cookies, ctx);
    params.set('count',   String(fetchCount));
    params.set('cursor',  cursor);
    params.set('secUid',  ctx.secUid || '');

    const url  = `https://m.tiktok.com/api/favorite/item_list/?${params}`;
    console.log(`[likes] page ${++page} cursor=${cursor}`);

    const data = await fetchJson(url, headers);

    if (!data || (data.statusCode !== 0 && data.status_code !== 0)) {
      const msg = data?.statusMsg || data?.status_msg || data?.statusCode || 'unknown';
      throw new Error(`Likes API error: ${msg}`);
    }

    const items = data.itemList || data.item_list || [];
    if (items.length === 0) {
      console.log('[likes] no items returned — stopping');
      break;
    }

    for (const item of items) {
      videos.push({
        id:         item.id,
        desc:       item.desc || '',
        authorId:   item.author?.id || '',
        authorName: item.author?.uniqueId || '',
        coverUrl:   item.video?.cover || item.video?.originCover || '',
        videoUrl:   item.video?.playAddr || item.video?.downloadAddr || '',
        duration:   item.video?.duration || 0,
        createTime: item.createTime || 0,
      });
      if (limit && videos.length >= limit) break;
    }

    if (limit && videos.length >= limit) {
      console.log(`[likes] reached test mode limit (${limit})`);
      break;
    }

    hasMore = data.hasMore ?? false;
    cursor  = String(data.cursor || 0);

    // Adaptive rate limiting
    await sleep(800 + Math.random() * 400);
  }

  return videos;
}

// ── Bookmarks/Saves/Favorites API ────────────────────────────────────────────
// TikTok has used multiple endpoint paths for this feature across versions.
// We try each in order and use the first one that returns a non-error response.
//
// Known candidates:
//   /api/user/collect/item_list/    — "Favorites" (current web, 2024+)
//   /api/item/bookmark/item_list/   — older "Bookmarks" endpoint
//   /api/user/saves/item_list/      — "Saves" branding seen in some regions

const BOOKMARK_ENDPOINTS = [
  'https://www.tiktok.com/api/user/collect/item_list/',
  'https://www.tiktok.com/api/item/bookmark/item_list/',
  'https://www.tiktok.com/api/user/saves/item_list/',
  'https://m.tiktok.com/api/user/collect/item_list/',
];

async function probeBookmarkEndpoint(cookies, ctx) {
  const headers = buildHeaders(cookies, ctx);
  for (const base of BOOKMARK_ENDPOINTS) {
    const params = baseParams(cookies, ctx);
    params.set('count', '1');
    params.set('cursor', '0');
    try {
      const data = await fetchJson(`${base}?${params}`, headers);
      const ok = data.statusCode === 0 || data.status_code === 0;
      if (ok) {
        console.log(`[bookmarks] using endpoint: ${base}`);
        return base;
      }
      console.log(`[bookmarks] ${base} → statusCode ${data.statusCode ?? data.status_code}, trying next`);
    } catch (e) {
      console.log(`[bookmarks] ${base} → ${e.message}, trying next`);
    }
    await sleep(500);
  }
  return null;
}

async function fetchBookmarkedVideos(cookies, ctx, limit = 0) {
  const headers  = buildHeaders(cookies, ctx);
  const endpoint = await probeBookmarkEndpoint(cookies, ctx);

  if (!endpoint) {
    console.warn('[bookmarks] no working endpoint found — collection may be private or feature unavailable');
    return [];
  }

  const videos = [];
  let cursor   = '0';
  let hasMore  = true;
  let page     = 0;
  const fetchCount = limit ? Math.min(limit, 30) : 30;

  while (hasMore) {
    const params = baseParams(cookies, ctx);
    params.set('count',  String(fetchCount));
    params.set('cursor', cursor);

    console.log(`[bookmarks] page ${++page} cursor=${cursor}`);
    const data = await fetchJson(`${endpoint}?${params}`, headers);

    if (!data || (data.statusCode !== 0 && data.status_code !== 0)) {
      console.warn(`[bookmarks] API returned ${data?.statusCode ?? data?.status_code}: ${data?.statusMsg ?? data?.status_msg}`);
      break;
    }

    const items = data.itemList || data.item_list || [];
    if (items.length === 0) {
      console.log('[bookmarks] no items returned — stopping');
      break;
    }

    for (const item of items) {
      videos.push({
        id:         item.id,
        desc:       item.desc || '',
        authorId:   item.author?.id || '',
        authorName: item.author?.uniqueId || '',
        coverUrl:   item.video?.cover || item.video?.originCover || '',
        videoUrl:   item.video?.playAddr || item.video?.downloadAddr || '',
        duration:   item.video?.duration || 0,
        createTime: item.createTime || 0,
      });
      if (limit && videos.length >= limit) break;
    }

    if (limit && videos.length >= limit) {
      console.log(`[bookmarks] reached test mode limit (${limit})`);
      break;
    }

    hasMore = data.hasMore ?? false;
    cursor  = String(data.cursor || 0);

    await sleep(800 + Math.random() * 400);
  }

  return videos;
}

// ── File download ─────────────────────────────────────────────────────────────

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB — matches s.js limit

async function downloadFile(url, destPath, headers) {
  // HEAD first to check size
  try {
    const head = await fetch(url, { method: 'HEAD', headers });
    const size = parseInt(head.headers.get('content-length') || '0');
    if (size > MAX_VIDEO_BYTES) {
      console.log(`[skip] ${path.basename(destPath)} too large (${Math.round(size / 1e6)}MB)`);
      return false;
    }
  } catch { /* HEAD not supported, proceed anyway */ }

  const buf = await fetchBinary(url, headers);
  if (buf.length > MAX_VIDEO_BYTES) {
    console.log(`[skip] ${path.basename(destPath)} too large (${Math.round(buf.length / 1e6)}MB)`);
    return false;
  }

  await fs.writeFile(destPath, buf);
  return true;
}

// ── Main download job ─────────────────────────────────────────────────────────

export async function runJob(session, opts = {}) {
  if (jobState.running) return;
  const { cookies, ctx } = session;
  const headers = buildHeaders(cookies, ctx);
  const limit = opts.limit || 0; // 0 = no limit

  jobState = { running: true, phase: 'starting', progress: null, lastRun: null, lastError: null, counts: { likes: 0, bookmarks: 0, skipped: 0 } };

  try {
    // ── Resolve secUid if needed ──────────────────────────────────────────────
    if (!ctx.secUid) {
      jobState.phase = 'resolving secUid';
      ctx.secUid = await resolveSecUid(cookies, ctx);
    }

    // ── Likes ────────────────────────────────────────────────────────────────
    jobState.phase = 'fetching likes list';
    console.log(`[job] fetching liked videos list…${limit ? ` (test mode: limit ${limit})` : ''}`);
    const liked = await fetchLikedVideos(cookies, ctx, limit);
    console.log(`[job] processing ${liked.length} liked videos`);

    const likesDir   = path.join(ARCHIVE_DIR, 'data', 'Likes');
    const coversDir  = path.join(likesDir, 'covers');
    const videosDir  = path.join(likesDir, 'videos');
    await fs.mkdir(coversDir, { recursive: true });
    await fs.mkdir(videosDir, { recursive: true });

    jobState.phase = 'downloading likes';
    for (let i = 0; i < liked.length; i++) {
      const v = liked[i];
      jobState.progress = `${i + 1} / ${liked.length}`;

      const videoPath = path.join(videosDir, `${v.id}.mp4`);
      const coverPath = path.join(coversDir, `${v.id}.jpg`);

      // Skip already downloaded
      const [videoExists, coverExists] = await Promise.all([
        fs.access(videoPath).then(() => true).catch(() => false),
        fs.access(coverPath).then(() => true).catch(() => false),
      ]);

      if (!videoExists && v.videoUrl) {
        console.log(`[likes] ${i + 1}/${liked.length} downloading ${v.id}`);
        const ok = await downloadFile(v.videoUrl, videoPath, headers).catch(() => false);
        if (ok) jobState.counts.likes++; else jobState.counts.skipped++;
        await sleep(300 + Math.random() * 200);
      }

      if (!coverExists && v.coverUrl) {
        const buf = await fetchBinary(v.coverUrl, headers).catch(() => null);
        if (buf) await fs.writeFile(coverPath, buf);
      }
    }

    // Write manifest
    await fs.writeFile(
      path.join(likesDir, 'manifest.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), count: liked.length, videos: liked }, null, 2),
    );

    // ── Bookmarks ────────────────────────────────────────────────────────────
    jobState.phase = 'fetching bookmarks list';
    console.log(`[job] fetching bookmarked videos list…${limit ? ` (test mode: limit ${limit})` : ''}`);
    const bookmarked = await fetchBookmarkedVideos(cookies, ctx, limit);
    console.log(`[job] processing ${bookmarked.length} bookmarked videos`);

    if (bookmarked.length > 0) {
      const bmDir     = path.join(ARCHIVE_DIR, 'data', 'Bookmarks');
      const bmCovers  = path.join(bmDir, 'covers');
      const bmVideos  = path.join(bmDir, 'videos');
      await fs.mkdir(bmCovers, { recursive: true });
      await fs.mkdir(bmVideos, { recursive: true });

      jobState.phase = 'downloading bookmarks';
      for (let i = 0; i < bookmarked.length; i++) {
        const v = bookmarked[i];
        jobState.progress = `${i + 1} / ${bookmarked.length}`;

        const videoPath = path.join(bmVideos, `${v.id}.mp4`);
        const coverPath = path.join(bmCovers, `${v.id}.jpg`);

        const [videoExists, coverExists] = await Promise.all([
          fs.access(videoPath).then(() => true).catch(() => false),
          fs.access(coverPath).then(() => true).catch(() => false),
        ]);

        if (!videoExists && v.videoUrl) {
          console.log(`[bookmarks] ${i + 1}/${bookmarked.length} downloading ${v.id}`);
          const ok = await downloadFile(v.videoUrl, videoPath, headers).catch(() => false);
          if (ok) jobState.counts.bookmarks++; else jobState.counts.skipped++;
          await sleep(300 + Math.random() * 200);
        }

        if (!coverExists && v.coverUrl) {
          const buf = await fetchBinary(v.coverUrl, headers).catch(() => null);
          if (buf) await fs.writeFile(coverPath, buf);
        }
      }

      await fs.writeFile(
        path.join(bmDir, 'manifest.json'),
        JSON.stringify({ updatedAt: new Date().toISOString(), count: bookmarked.length, videos: bookmarked }, null, 2),
      );
    }

    jobState.lastRun = new Date().toISOString();
    console.log(`[job] done — likes: ${jobState.counts.likes}, bookmarks: ${jobState.counts.bookmarks}, skipped: ${jobState.counts.skipped}`);
  } catch (e) {
    jobState.lastError = e.message;
    console.error('[job] error:', e);
  } finally {
    jobState.running  = false;
    jobState.phase    = null;
    jobState.progress = null;
  }
}

// ── Download from pre-fetched metadata ────────────────────────────────────────
// Called when the extension has already fetched the video lists in-browser
// (where anti-bot signatures are handled) and sent us the metadata.
// We just need to download the actual files from CDN URLs.

export async function downloadVideos(session, { likes = [], bookmarks = [] }) {
  if (jobState.running) return;
  const { cookies, ctx } = session;
  const headers = buildHeaders(cookies, ctx);

  jobState = { running: true, phase: 'starting', progress: null, lastRun: null, lastError: null, counts: { likes: 0, bookmarks: 0, skipped: 0 } };

  try {
    // ── Likes ──────────────────────────────────────────────────────────────
    if (likes.length > 0) {
      console.log(`[dl] downloading ${likes.length} liked videos`);
      const likesDir  = path.join(ARCHIVE_DIR, 'data', 'Likes');
      const coversDir = path.join(likesDir, 'covers');
      const videosDir = path.join(likesDir, 'videos');
      await fs.mkdir(coversDir, { recursive: true });
      await fs.mkdir(videosDir, { recursive: true });

      jobState.phase = 'downloading likes';
      for (let i = 0; i < likes.length; i++) {
        const v = likes[i];
        jobState.progress = `${i + 1} / ${likes.length}`;

        const videoPath = path.join(videosDir, `${v.id}.mp4`);
        const coverPath = path.join(coversDir, `${v.id}.jpg`);

        const [videoExists, coverExists] = await Promise.all([
          fs.access(videoPath).then(() => true).catch(() => false),
          fs.access(coverPath).then(() => true).catch(() => false),
        ]);

        if (!videoExists && v.videoUrl) {
          console.log(`[dl:likes] ${i + 1}/${likes.length} downloading ${v.id}`);
          const ok = await downloadFile(v.videoUrl, videoPath, headers).catch(() => false);
          if (ok) jobState.counts.likes++; else jobState.counts.skipped++;
          await sleep(300 + Math.random() * 200);
        }

        if (!coverExists && v.coverUrl) {
          const buf = await fetchBinary(v.coverUrl, headers).catch(() => null);
          if (buf) await fs.writeFile(coverPath, buf);
        }
      }

      await fs.writeFile(
        path.join(likesDir, 'manifest.json'),
        JSON.stringify({ updatedAt: new Date().toISOString(), count: likes.length, videos: likes }, null, 2),
      );
    }

    // ── Bookmarks ────────────────────────────────────────────────────────────
    if (bookmarks.length > 0) {
      console.log(`[dl] downloading ${bookmarks.length} bookmarked videos`);
      const bmDir    = path.join(ARCHIVE_DIR, 'data', 'Bookmarks');
      const bmCovers = path.join(bmDir, 'covers');
      const bmVideos = path.join(bmDir, 'videos');
      await fs.mkdir(bmCovers, { recursive: true });
      await fs.mkdir(bmVideos, { recursive: true });

      jobState.phase = 'downloading bookmarks';
      for (let i = 0; i < bookmarks.length; i++) {
        const v = bookmarks[i];
        jobState.progress = `${i + 1} / ${bookmarks.length}`;

        const videoPath = path.join(bmVideos, `${v.id}.mp4`);
        const coverPath = path.join(bmCovers, `${v.id}.jpg`);

        const [videoExists, coverExists] = await Promise.all([
          fs.access(videoPath).then(() => true).catch(() => false),
          fs.access(coverPath).then(() => true).catch(() => false),
        ]);

        if (!videoExists && v.videoUrl) {
          console.log(`[dl:bookmarks] ${i + 1}/${bookmarks.length} downloading ${v.id}`);
          const ok = await downloadFile(v.videoUrl, videoPath, headers).catch(() => false);
          if (ok) jobState.counts.bookmarks++; else jobState.counts.skipped++;
          await sleep(300 + Math.random() * 200);
        }

        if (!coverExists && v.coverUrl) {
          const buf = await fetchBinary(v.coverUrl, headers).catch(() => null);
          if (buf) await fs.writeFile(coverPath, buf);
        }
      }

      await fs.writeFile(
        path.join(bmDir, 'manifest.json'),
        JSON.stringify({ updatedAt: new Date().toISOString(), count: bookmarks.length, videos: bookmarks }, null, 2),
      );
    }

    jobState.lastRun = new Date().toISOString();
    console.log(`[dl] done — likes: ${jobState.counts.likes}, bookmarks: ${jobState.counts.bookmarks}, skipped: ${jobState.counts.skipped}`);
  } catch (e) {
    jobState.lastError = e.message;
    console.error('[dl] error:', e);
  } finally {
    jobState.running  = false;
    jobState.phase    = null;
    jobState.progress = null;
  }
}
