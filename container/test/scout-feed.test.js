// Tests for the scout's browser side (scout-feed.js).
//
// Part 1 needs no browser: parsing, spotting a verification answer, spotting a write request, and checking that
// the block list never blocks a read endpoint.
// Part 2 drives a real Chromium against a FAKE local site (no account, no real site). It is skipped where
// Playwright or a browser is not available; in the container image it runs. Elsewhere:
//   PLAYWRIGHT_PATH=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chromium npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  parseItem, isPicturePost, looksLikeChallenge, isWriteRequest, WRITE_BLOCKS, createFeedReader,
} from '../scout-feed.js';
import { ScoutStop, FeedHiccup } from '../scout-core.js';

// ── part 1: no browser ───────────────────────────────────────────────────────

test('parseItem reads the four fields it needs and nothing else', () => {
  const it = { id: 7000000000001, desc: 'made-up caption', author: { uniqueId: 'someone', nickname: 'Not Kept', secUid: 'also-not-kept' },
    video: { originCover: 'https://cdn.invalid/o.jpg', cover: 'https://cdn.invalid/c.jpg', playAddr: 'https://cdn.invalid/video.mp4' }, stats: { diggCount: 1 } };
  assert.deepEqual(parseItem(it), { id: '7000000000001', author: 'someone', desc: 'made-up caption', coverUrl: 'https://cdn.invalid/o.jpg' });
});

test('picture posts are recognised; videos are not', () => {
  assert.equal(isPicturePost({ id: '1', imagePost: { images: [{}] }, video: { duration: 0 } }), true);
  assert.equal(isPicturePost({ id: '1', image_post_info: { images: [] } }), true);
  assert.equal(isPicturePost({ id: '1', images: [{ url: 'x' }] }), true);
  assert.equal(isPicturePost({ id: '1', video: { duration: 0, cover: 'c' } }), true, 'no length and no stream');
  assert.equal(isPicturePost({ id: '1', video: { duration: 12, playAddr: 'https://cdn.invalid/v.mp4' } }), false);
  assert.equal(isPicturePost({ id: '1', video: { duration: 0, playAddr: 'https://cdn.invalid/v.mp4' } }), false, 'a stream means a video');
  assert.equal(isPicturePost({ id: '1' }), false, 'unknown is kept');
  assert.equal(isPicturePost(null), false);
  assert.equal(parseItem({ id: '12345', imagePost: { images: [{}] }, video: { cover: 'c' } }).photo, true);
  assert.equal('photo' in parseItem({ id: '12345', video: { duration: 9, playAddr: 'p', cover: 'c' } }), false);
});

test('parseItem copes with missing or odd fields', () => {
  assert.equal(parseItem(null), null);
  assert.equal(parseItem({}), null);
  assert.equal(parseItem({ desc: 'no id' }), null);
  assert.deepEqual(parseItem({ id: '12345', video: { cover: 'https://cdn.invalid/c.jpg' } }), { id: '12345', author: '', desc: '', coverUrl: 'https://cdn.invalid/c.jpg' });
  assert.deepEqual(parseItem({ id: '12345', author: 'plainname', desc: 5 }), { id: '12345', author: 'plainname', desc: '', coverUrl: '' });
  assert.equal(parseItem({ id: '12345', author: { unique_id: 'snake' } }).author, 'snake');
});

test('a verification answer from the feed is recognised, an ordinary one is not', () => {
  assert.equal(looksLikeChallenge({ code: '10000', type: 'verify' }), true);
  assert.equal(looksLikeChallenge({ code: 10000, type: 'verify' }), true);
  assert.equal(looksLikeChallenge({ verify_event: { x: 1 } }), true);
  assert.equal(looksLikeChallenge({ itemList: [], statusCode: 0, hasMore: true }), false);
  assert.equal(looksLikeChallenge({ code: '10000', type: 'other' }), false);
  assert.equal(looksLikeChallenge(null), false);
  assert.equal(looksLikeChallenge('text'), false);
});

test('write requests are recognised; reads and telemetry are not', () => {
  for (const p of ['/api/commit/item/digg/', '/api/commit/follow/user/', '/api/comment/publish/', '/api/item/digg/', '/aweme/v1/commit/follow/user/', '/api/repost/item/']) {
    assert.equal(isWriteRequest('POST', p), true, `POST ${p}`);
  }
  for (const p of ['/api/recommend/item_list/', '/api/user/collect/item_list/', '/api/favorite/item_list/', '/api/share/settings/', '/aweme/v1/report/inbox/notice', '/mcs/v1/telemetry', '/api/post/item_list/']) {
    assert.equal(isWriteRequest('POST', p), false, `POST ${p}`);
    assert.equal(isWriteRequest('GET', p), false, `GET ${p}`);
  }
  assert.equal(isWriteRequest('GET', '/api/commit/item/digg/'), false, 'a plain read of that address is not a write');
});

// A glob like the browser's block list: * matches anything
const globToRe = g => new RegExp('^' + g.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const blocked = url => WRITE_BLOCKS.some(g => globToRe(g).test(url));

test('the block list stops write endpoints and never a read endpoint', () => {
  const site = 'https://www.example.test';
  for (const p of ['/api/commit/item/digg/?aid=1&x=2', '/api/commit/follow/user/', '/aweme/v1/commit/follow/user/?a=1', '/api/comment/publish/', '/api/item/digg/', '/api/user/follow/']) {
    assert.equal(blocked(site + p), true, `should block ${p}`);
  }
  for (const p of ['/api/recommend/item_list/?aid=1', '/api/user/collect/item_list/', '/api/favorite/item_list/', '/api/user/detail/', '/api/share/settings/', '/node-webapp/api/app-context', '/passport/web/account/info/', '/api/post/item_list/', '/foryou']) {
    assert.equal(blocked(site + p), false, `should NOT block ${p}`);
  }
});

// ── part 2: a real browser against a fake site ──────────────────────────────

let chromium = null;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch { /* not installed here */ }
const noPlaywright = chromium ? false : 'Playwright is not installed here (the container image has it)';

async function launch(t) {
  try {
    return await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    t.skip(`no browser to launch (${String(e.message).split('\n')[0].slice(0, 80)})`);
    return null;
  }
}

// The fake site. It records every request, so a test can see exactly what the scout did.
function fakeSite() {
  const hits = [];
  let server, base;
  const html = mode => `<!doctype html><html><body>
    <h1>For You (fake)</h1>
    <button id="like" onclick="window.__clicks=(window.__clicks||0)+1;fetch('/api/commit/item/digg/',{method:'POST'})">Like</button>
    <button id="follow" onclick="window.__clicks=(window.__clicks||0)+1;fetch('/api/commit/follow/user/',{method:'POST'})">Follow</button>
    ${mode === 'challenge' ? '<div id="captcha_container" style="display:block">Drag the slider</div>' : ''}
    ${mode === 'login' ? '<button>Log in</button>' : ''}
    ${mode === 'dialog' ? '<div role="dialog" style="display:block">Something nobody expected</div>' : ''}
    <script>
      let batch = 0, presses = 0;
      const load = () => fetch('/api/recommend/item_list/?batch=' + (batch++)).catch(() => {});
      load();
      document.addEventListener('keydown', e => { if (e.key === 'ArrowDown' && ++presses % 3 === 0) load(); });
      ${mode === 'tripwire' ? "fetch('/api/commit/item/digg/', { method: 'POST' }).catch(() => {});" : ''}
    </script></body></html>`;
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(`${req.method} ${u.pathname}`);
    const mode = u.searchParams.get('mode') || '';
    if (u.pathname === '/foryou') { res.setHeader('Content-Type', 'text/html'); return res.end(html(mode)); }
    if (u.pathname === '/api/recommend/item_list/') {
      const apiMode = modeOfApi.value;
      if (apiMode === '429') { res.statusCode = 429; return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json');
      if (apiMode === 'verify') return res.end(JSON.stringify({ code: '10000', type: 'verify' }));
      if (apiMode === 'empty') return res.end(JSON.stringify({ itemList: [], statusCode: 0 }));
      const b = Number(u.searchParams.get('batch') || 0);
      return res.end(JSON.stringify({ statusCode: 0, hasMore: true, itemList: Array.from({ length: 5 }, (_, i) => ({
        id: String(7000000000000 + b * 5 + i), desc: `made-up ${b}-${i}`, author: { uniqueId: `fake_${i}` }, video: { originCover: `${base}/cover/${b}-${i}.jpg` },
      })) }));
    }
    res.statusCode = 200; res.end('ok');
  });
  const modeOfApi = { value: '' };
  return {
    hits, modeOfApi,
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(base); })),
    stop: () => new Promise(r => server.close(r)),
  };
}

async function withReader(t, { mode = '', apiMode = '', waitMs = 6000 } = {}, fn) {
  const browser = await launch(t);
  if (!browser) return;
  const site = fakeSite();
  site.modeOfApi.value = apiMode;
  const base = await site.start();
  const page = await (await browser.newContext()).newPage();
  try {
    const reader = await createFeedReader(page, { url: `${base}/foryou?mode=${mode}`, settleMs: 300, waitMs, sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 200))) });
    await fn({ reader, site, page, base });
  } finally {
    await browser.close();
    await site.stop();
  }
}

test('it reads videos in order across several batches of the feed', { skip: noPlaywright }, async t => {
  await withReader(t, {}, async ({ reader }) => {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push((await reader.next()).id);
    assert.equal(new Set(ids).size, 12);
    assert.deepEqual(ids.slice(0, 5), [0, 1, 2, 3, 4].map(i => String(7000000000000 + i)));
  });
});

test('it only reads: no click, no POST, no like or follow request ever reaches the site', { skip: noPlaywright }, async t => {
  await withReader(t, {}, async ({ reader, site, page }) => {
    for (let i = 0; i < 12; i++) await reader.next();
    assert.equal(await page.evaluate(() => window.__clicks || 0), 0, 'the Like and Follow buttons were never clicked');
    assert.deepEqual(site.hits.filter(h => !h.startsWith('GET ')), [], 'no request other than a read');
    assert.deepEqual(site.hits.filter(h => /commit|digg|follow|publish/.test(h)), []);
    assert.ok(site.hits.includes('GET /foryou') && site.hits.includes('GET /api/recommend/item_list/'));
    assert.deepEqual([...new Set(site.hits)].sort(), ['GET /api/recommend/item_list/', 'GET /foryou']);
  });
});

test('a verification screen stops it, and nothing on it is clicked', { skip: noPlaywright }, async t => {
  await withReader(t, { mode: 'challenge' }, async ({ reader, page, site }) => {
    await assert.rejects(() => reader.next(), e => e instanceof ScoutStop && e.state === 'challenge');
    assert.equal(await page.evaluate(() => window.__clicks || 0), 0);
    assert.deepEqual(site.hits.filter(h => h.startsWith('POST')), []);
  });
});

test('a log-in prompt stops it with the login state', { skip: noPlaywright }, async t => {
  await withReader(t, { mode: 'login' }, async ({ reader }) => {
    await assert.rejects(() => reader.next(), e => e instanceof ScoutStop && e.state === 'login');
  });
});

test('an unexpected dialog stops it', { skip: noPlaywright }, async t => {
  await withReader(t, { mode: 'dialog' }, async ({ reader }) => {
    await assert.rejects(() => reader.next(), e => e instanceof ScoutStop && e.state === 'challenge' && /dialog/i.test(e.message));
  });
});

test('HTTP 429 from the feed stops it with an error that says so', { skip: noPlaywright }, async t => {
  await withReader(t, { apiMode: '429' }, async ({ reader }) => {
    await assert.rejects(() => reader.next(), e => e instanceof ScoutStop && e.state === 'error' && /429/.test(e.message));
  });
});

test('the feed answering "verify first" stops it as a challenge', { skip: noPlaywright }, async t => {
  await withReader(t, { apiMode: 'verify' }, async ({ reader }) => {
    await assert.rejects(() => reader.next(), e => e instanceof ScoutStop && e.state === 'challenge');
  });
});

test('a feed that shows nothing is a failed load, not a stop', { skip: noPlaywright }, async t => {
  await withReader(t, { apiMode: 'empty', waitMs: 1500 }, async ({ reader }) => {
    await assert.rejects(() => reader.next(), e => e instanceof FeedHiccup);
  });
});

test('if the page ever tries to like or follow, the browser blocks it and the scout stops', { skip: noPlaywright }, async t => {
  await withReader(t, { mode: 'tripwire' }, async ({ reader, site }) => {
    await assert.rejects(() => reader.next(), e => e instanceof ScoutStop && e.state === 'error' && /blocked/i.test(e.message));
    assert.deepEqual(site.hits.filter(h => /digg|follow|commit/.test(h)), [], 'the request never reached the site');
  });
});
