// The scout's eyes: reads the site's For You feed in the logged-in browser, read-only.
//
// It only LISTENS to the requests the page makes for its own feed, and moves through the feed with the arrow
// key, like someone paging through it. It never clicks anything, so it cannot like, follow, comment or share.
// As a safety net it also asks the browser to refuse the site's write endpoints, and stops if one is ever attempted.
//
// It never tries to get past a verification screen: if one appears (or a log-in prompt, or any dialog nobody
// expected) it throws and the scout stops. No stealth, no fingerprint changes.

import { ScoutStop, FeedHiccup } from './scout-core.js';

export const FEED_URL = 'https://www.tiktok.com/foryou';
export const FEED_API = '/api/recommend/item_list';

// Endpoints that change something on the site. Blocked in the browser, and a request to one stops the scout.
export const WRITE_BLOCKS = [
  '*/api/commit/*', '*/aweme/v1/commit/*', '*/api/comment/publish*', '*/api/item/digg*',
  '*/api/user/follow*', '*/commit/follow/*', '*/api/repost/*',
];
const WRITE_RE = /\/(commit|digg|follow|unfollow|publish|repost)(\/|$|\?)/i;

export const isWriteRequest = (method, pathname) => method !== 'GET' && method !== 'HEAD' && WRITE_RE.test(pathname);

// The site's own answer saying "verify first"
export function looksLikeChallenge(body) {
  if (!body || typeof body !== 'object') return false;
  if (String(body.code) === '10000' && body.type === 'verify') return true;
  if (body.verify_event || body.verifyEvent) return true;
  return false;
}

// A picture post (a slideshow of photos) rather than a video: the feed marks it with an image list, and its video has no length or stream.
export function isPicturePost(it) {
  if (!it || typeof it !== 'object') return false;
  const imgs = it.imagePost || it.image_post_info || it.imagePostInfo;
  if (imgs && typeof imgs === 'object') return true;
  if (Array.isArray(it.images) && it.images.length) return true;
  const v = it.video;
  if (v && typeof v === 'object' && Number(v.duration) === 0 && !v.playAddr && !v.downloadAddr) return true;
  return false;
}

export function parseItem(it) {
  if (!it || it.id == null) return null;
  const v = it.video || {};
  const a = it.author;
  return {
    ...(isPicturePost(it) ? { photo: true } : {}),
    id: String(it.id),
    author: (a && typeof a === 'object' ? (a.uniqueId || a.unique_id || '') : (typeof a === 'string' ? a : '')),
    desc: typeof it.desc === 'string' ? it.desc : '',
    coverUrl: v.originCover || v.cover || v.dynamicCover || '',
  };
}

// Runs in the page: is something in the way? Looks at elements only, never clicks.
function inspectPage() {
  const q = s => document.querySelector(s);
  const visible = el => !!el && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
  const anyVisible = sels => sels.some(s => [...document.querySelectorAll(s)].some(visible));

  const loggedOutButton = [...document.querySelectorAll('button, a')].some(e => visible(e) && /^log in$/i.test((e.textContent || '').trim()));
  if (loggedOutButton || anyVisible(['[data-e2e*="login-modal"]', '[data-e2e="login-modal"]', '[class*="login-modal"]', '#login-modal'])) {
    return { kind: 'login', msg: 'The site shows a log-in prompt.' };
  }
  const captcha = anyVisible(['#captcha_container', '[id*="captcha"]', '[class*="captcha"]', 'iframe[src*="captcha"]', 'iframe[src*="verify"]']);
  if (captcha) return { kind: 'challenge', msg: 'A verification screen appeared.' };
  if (anyVisible(['[role="dialog"]', 'dialog[open]', '[aria-modal="true"]']) && !q('[data-e2e="cookie-banner"]')) {
    return { kind: 'challenge', msg: 'An unexpected dialog appeared.' };
  }
  return null;
}

// page: a Playwright page already logged in. opts.url / opts.feedApi let the tests point at a fake site.
export async function createFeedReader(page, opts = {}) {
  const url = opts.url || FEED_URL;
  const feedApi = opts.feedApi || FEED_API;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const queue = [];
  let problem = null;
  let started = false;

  const context = page.context();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: opts.writeBlocks || WRITE_BLOCKS }).catch(() => {});

  context.on('request', req => {
    let p; try { p = new URL(req.url()).pathname; } catch { return; }
    if (isWriteRequest(req.method(), p)) problem = problem || new ScoutStop('error', 'The page tried to send something to the site. It was blocked and the scout stopped.');
  });

  page.on('response', async resp => {
    let u; try { u = new URL(resp.url()); } catch { return; }
    if (!u.pathname.startsWith(feedApi)) return;
    const status = resp.status();
    if (status === 403 || status === 429) { problem = problem || new ScoutStop('error', `The site answered HTTP ${status}. The scout stopped.`); return; }
    if (status >= 400) return;                       // counted as a failed load when nothing arrives
    let body;
    try { body = await resp.json(); } catch { return; }
    if (looksLikeChallenge(body)) { problem = problem || new ScoutStop('challenge', 'The site asked for a verification. The scout stopped.'); return; }
    for (const it of (body.itemList || body.item_list || [])) {
      const item = parseItem(it);
      if (item) queue.push(item);
    }
  });

  async function look() {
    const found = await page.evaluate(inspectPage).catch(() => null);
    if (found) throw new ScoutStop(found.kind, found.msg);
  }

  async function start() {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      throw new FeedHiccup(`the feed page did not load (${String(e.message || e).slice(0, 60)})`);
    }
    await sleep(opts.settleMs ?? 4000);
    started = true;
  }

  // The next video the feed shows. Throws ScoutStop (challenge, login, error) or FeedHiccup (one failed load).
  async function next() {
    if (!started) await start();
    const deadline = Date.now() + (opts.waitMs ?? 15000);
    for (;;) {
      if (problem) throw problem;
      await look();
      if (queue.length) {
        const item = queue.shift();
        // page on, like a viewer would, so the page asks for more videos when it needs to (no clicks, just the key)
        await page.keyboard.press('ArrowDown').catch(() => {});
        return item;
      }
      if (Date.now() > deadline) throw new FeedHiccup('the feed showed no new videos');
      await page.keyboard.press('ArrowDown').catch(() => {});
      await sleep(1200);
    }
  }

  return { next };
}
