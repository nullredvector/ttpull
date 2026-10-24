// Starts the scout inside the container: the real browser feed, the real scorer and the real cover download
// wired into the logic in scout-core.js. It does nothing unless SCOUT=on AND the Settings switch is on.

import path from 'path';
import { STATE_DIR } from './state.js';
import { notify } from './notify.js';
import { syncState, launchContext, isLoggedIn, toPlaywrightCookie } from './browser-sync.js';
import { getJobState } from './downloader.js';
import { acquireBrowser, releaseBrowser, shouldYield } from './browser-lock.js';
import { createScout, LIMITS, ScoutStop } from './scout-core.js';
import { createFeedReader } from './scout-feed.js';

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || './archive';
const SCORER_URL = (process.env.SCORER_URL || 'http://autotagtt:8090').replace(/\/$/, '');

// The scorer: POST the cover, get a score. A scorer that is down or still loading is worth retrying; anything else is not.
export async function scoreCover(id, bytes, base = SCORER_URL) {
  let res;
  try {
    res = await fetch(`${base}/score?id=${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: bytes, signal: AbortSignal.timeout(30000),
    });
  } catch {
    const e = new Error('the scorer did not answer'); e.retry = true; throw e;
  }
  if (res.status >= 500) { const e = new Error(`the scorer answered ${res.status}`); e.retry = true; throw e; }
  if (!res.ok) throw new Error(`the scorer refused a cover (${res.status})`);
  return res.json();
}

// The cover image only, never the video; at most about 1 MB. Nothing about the address is ever logged.
export function makeCoverFetcher(getUserAgent = () => undefined) {
  return async function fetchCover(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not a web address');
    const ua = getUserAgent();
    const res = await fetch(url, { headers: { ...(ua ? { 'user-agent': ua } : {}), referer: 'https://www.tiktok.com/' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`cover answered ${res.status}`);
    const tooBig = () => Object.assign(new Error('cover is too big'), { code: 'TOO_BIG' });
    if (Number(res.headers.get('content-length') || 0) > LIMITS.COVER_MAX_BYTES) throw tooBig();
    const chunks = []; let total = 0;
    for await (const c of res.body) {
      total += c.length;
      if (total > LIMITS.COVER_MAX_BYTES) { try { await res.body.cancel(); } catch { /* ignore */ } throw tooBig(); }
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  };
}

let instance = null;
export const scoutStatus = () => (instance ? instance.status() : null);

export function startScout(getSession) {
  let userAgent;
  const scout = createScout({
    archiveDir: ARCHIVE_DIR,
    stateDir: STATE_DIR,
    notify,
    isSyncRunning: () => syncState.running || getJobState().running,
    lock: { acquire: name => acquireBrowser(name, { waitMs: 0 }), release: releaseBrowser, shouldYield },
    scorer: { score: scoreCover },
    fetchCover: makeCoverFetcher(() => userAgent),
    feed: {
      async open() {
        const context = await launchContext();
        try {
          const session = getSession();
          if (!(await isLoggedIn(context)) && session?.cookies?.length) {
            await context.addCookies(session.cookies.map(toPlaywrightCookie)).catch(() => {});
          }
          if (!(await isLoggedIn(context))) throw new ScoutStop('login', 'The browser is not logged in.');
          const page = context.pages()[0] || await context.newPage();
          userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
          const reader = await createFeedReader(page);
          return { next: reader.next, close: () => context.close() };
        } catch (e) {
          await context.close().catch(() => {});
          throw e;
        }
      },
    },
  });
  instance = scout;
  scout.run();
  return scout;
}

export const scoutStatePath = path.join(STATE_DIR, 'scout');
