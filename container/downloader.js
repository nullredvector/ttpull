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
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const wait = 10000 * (i + 1);
        console.log(`[fetch] rate limited, waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
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

// ── Likes API ─────────────────────────────────────────────────────────────────
// GET https://m.tiktok.com/api/favorite/item_list/
// Paginates via cursor. Returns all liked video metadata.

async function fetchLikedVideos(cookies, ctx) {
  const headers = buildHeaders(cookies, ctx);
  const videos  = [];
  let cursor    = '0';
  let hasMore   = true;
  let page      = 0;

  while (hasMore) {
    const params = baseParams(cookies, ctx);
    params.set('count',   '30');
    params.set('cursor',  cursor);
    params.set('secUid',  ctx.secUid || '');

    const url  = `https://m.tiktok.com/api/favorite/item_list/?${params}`;
    console.log(`[likes] page ${++page} cursor=${cursor}`);

    const data = await fetchJson(url, headers);

    if (data.statusCode !== 0 && data.status_code !== 0) {
      throw new Error(`Likes API error: ${data.statusMsg || data.status_msg || data.statusCode}`);
    }

    const items = data.itemList || data.item_list || [];
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
    }

    hasMore = data.hasMore ?? false;
    cursor  = String(data.cursor || 0);

    // Adaptive rate limiting
    await sleep(800 + Math.random() * 400);
  }

  return videos;
}

// ── Bookmarks/Collect API ─────────────────────────────────────────────────────
// GET https://www.tiktok.com/api/user/collect/item_list/
// Same pagination pattern as likes.

async function fetchBookmarkedVideos(cookies, ctx) {
  const headers = buildHeaders(cookies, ctx);
  const videos  = [];
  let cursor    = '0';
  let hasMore   = true;
  let page      = 0;

  while (hasMore) {
    const params = baseParams(cookies, ctx);
    params.set('count',  '30');
    params.set('cursor', cursor);

    const url  = `https://www.tiktok.com/api/user/collect/item_list/?${params}`;
    console.log(`[bookmarks] page ${++page} cursor=${cursor}`);

    const data = await fetchJson(url, headers);

    if (data.statusCode !== 0 && data.status_code !== 0) {
      // Bookmarks may be private — log and bail gracefully
      console.warn(`[bookmarks] API returned ${data.statusCode}: ${data.statusMsg}`);
      break;
    }

    const items = data.itemList || data.item_list || [];
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

export async function runJob(session) {
  if (jobState.running) return;
  const { cookies, ctx } = session;
  const headers = buildHeaders(cookies, ctx);

  jobState = { running: true, phase: 'starting', progress: null, lastRun: null, lastError: null, counts: { likes: 0, bookmarks: 0, skipped: 0 } };

  try {
    // ── Likes ────────────────────────────────────────────────────────────────
    jobState.phase = 'fetching likes list';
    console.log('[job] fetching liked videos list…');
    const liked = await fetchLikedVideos(cookies, ctx);
    console.log(`[job] found ${liked.length} liked videos`);

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
    console.log('[job] fetching bookmarked videos list…');
    const bookmarked = await fetchBookmarkedVideos(cookies, ctx);
    console.log(`[job] found ${bookmarked.length} bookmarked videos`);

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
