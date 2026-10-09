// Scheduled sync: drive a real browser (persistent profile) to the site, fetch
// the newest likes/bookmarks with the page's own signed requests, then hand the
// new videos to the downloader (which also registers them in the archive DB).

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { STATE_DIR, givenUp } from './state.js';
import { readKnownIds } from './archive-db.js';
import { downloadVideos, getJobState } from './downloader.js';
import { listInPage, envInPage } from './page-fetch.js';

const ARCHIVE_DIR  = process.env.ARCHIVE_DIR || './archive';
const PROFILE_DIR  = path.join(STATE_DIR, 'profile');
const SHOT_FILE    = path.join(STATE_DIR, 'last.png');
const HOME_URL     = 'https://www.tiktok.com/foryou';
const MAX_PAGES    = Number(process.env.MAX_PAGES || 400);
const HEADLESS     = process.env.HEADLESS === '1';
const BLOCK_MEDIA  = process.env.BLOCK_MEDIA !== '0';

export const syncState = {
  running: false,
  phase: null,
  lastRun: null,
  lastError: null,
  lastSummary: null,
  lastDiag: null,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function toPlaywrightCookie(c) {
  const sameSite = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[c.sameSite];
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: c.secure ?? true,
    httpOnly: !!c.httpOnly,
  };
  if (sameSite) out.sameSite = sameSite;
  if (c.expirationDate) out.expires = Math.floor(c.expirationDate);
  return out;
}

async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.tiktok.com');
  return cookies.some(c => c.name === 'sessionid' && c.value);
}

async function openHome(page) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // The signing code and app context are ready shortly after the document is.
  await page.waitForFunction(
    () => !!document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__'),
    null, { timeout: 30000 },
  ).catch(() => {});
  await sleep(4000);
}

async function readPage(page, args) {
  return page.evaluate(listInPage, args);
}


// Light, human-looking activity so the site's scripts finish initialising.
async function humanize(page, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.mouse.move(200 + Math.random() * 800, 150 + Math.random() * 500, { steps: 8 }).catch(() => {});
    await page.mouse.wheel(0, 120 + Math.random() * 200).catch(() => {});
    await sleep(700 + Math.random() * 500);
  }
}

async function launchContext() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  if (BLOCK_MEDIA) {
    await context.route('**/*', route => {
      const t = route.request().resourceType();
      return (t === 'media' || t === 'image' || t === 'font') ? route.abort() : route.continue();
    });
  }
  return context;
}

// A first page with no items is not a real result (a library with likes always
// has some) — it means the request wasn't accepted. Wait, move around, retry.
async function listWithRetry(page, args, label) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await readPage(page, args);
    if (r.loggedOut || (r.error && !r.diag?.pages?.length)) return r;
    const first = r.diag.pages?.[0];
    const ok = r.diag.pagesFetched > 0 && first && first.n > 0;
    if (ok) return r;
    console.log(`[sync] ${label}: first page empty/failed (attempt ${attempt + 1}/3): ${JSON.stringify(first || {})}`);
    await humanize(page, 8000 * (attempt + 1));
  }
  return r;
}

// Diagnostics: environment + the same request at several delays, via fetch and XHR.
export async function runProbe(getSession) {
  const out = { steps: [] };
  let context;
  try {
    context = await launchContext();
    const page = context.pages()[0] || await context.newPage();
    const session = getSession();
    if (!(await isLoggedIn(context)) && session?.cookies?.length) {
      await context.addCookies(session.cookies.map(toPlaywrightCookie)).catch(() => {});
    }
    await openHome(page);
    const cookies = await context.cookies('https://www.tiktok.com');
    out.cookieNames = cookies.map(c => c.name);
    out.env = await page.evaluate(envInPage);
    const none = { limit: 1, known: [], stopOnKnown: false, maxPages: 1 };
    for (const [label, wait] of [['t+0', 0], ['t+10s active', 10000], ['t+25s active', 15000]]) {
      if (wait) await humanize(page, wait);
      for (const via of ['fetch', 'xhr']) {
        const r = await page.evaluate(listInPage, { type: 'likes', ...none, via });
        out.steps.push({ label, via, error: r.error || null, pages: r.diag?.pages, videos: r.videos?.length });
      }
    }
    await page.screenshot({ path: SHOT_FILE }).catch(() => {});
  } catch (e) {
    out.error = e.message;
  } finally {
    await context?.close().catch(() => {});
  }
  return out;
}

// opts: { test, full }   test → only the 2 newest new videos per list
//                        full → don't stop at the first page of known videos
export async function runBrowserSync(getSession, opts = {}) {
  if (syncState.running || getJobState().running) {
    console.log('[sync] already running — skipping');
    return { skipped: true };
  }
  syncState.running = true;
  syncState.lastError = null;
  syncState.phase = 'starting browser';
  const started = Date.now();
  let context;

  try {
    context = await launchContext();

    const page = context.pages()[0] || await context.newPage();

    // Seed the login from the extension's pushed cookies if the profile has none.
    const session = getSession();
    if (!(await isLoggedIn(context)) && session?.cookies?.length) {
      console.log('[sync] profile has no login — seeding cookies from the pushed session');
      await context.addCookies(session.cookies.map(toPlaywrightCookie)).catch(e =>
        console.error('[sync] could not add cookies:', e.message));
    }

    syncState.phase = 'loading site';
    await openHome(page);

    const limit = opts.test ? 2 : 0;
    const common = { limit, stopOnKnown: !opts.full, maxPages: MAX_PAGES };

    const results = {};
    let seeded = false;
    for (const [kind, type] of [['likes', 'likes'], ['bookmarked', 'bookmarks']]) {
      syncState.phase = `fetching ${type}`;
      const known = await readKnownIds(ARCHIVE_DIR, kind);
      for (const id of givenUp(kind)) known.add(id);

      let r = await listWithRetry(page, { type, known: [...known], ...common }, type);

      // Logged out: retry once after seeding the pushed cookies.
      if (r.loggedOut && session?.cookies?.length && !seeded) {
        seeded = true;
        console.log('[sync] not logged in — re-seeding pushed cookies and reloading');
        await context.addCookies(session.cookies.map(toPlaywrightCookie)).catch(() => {});
        await openHome(page);
        r = await listWithRetry(page, { type, known: [...known], ...common }, type);
      }

      if (r.loggedOut) {
        throw new Error('login required — open the site in your browser and push the session from the extension');
      }
      syncState.lastDiag = { ...(syncState.lastDiag || {}), [type]: r.diag };
      if (r.error) throw new Error(`${type}: ${r.error}`);
      results[kind] = r;
      console.log(`[sync] ${type}: ${r.videos.length} new (${r.diag.pagesFetched || 0} page(s), known ${known.size})`);
      const first = r.diag.pages?.[0];
      if (!r.diag.pagesFetched || !(first?.n > 0)) {
        console.error(`[sync] ${type} returned no items:`, JSON.stringify(r.diag.pages?.slice(0, 4)));
        throw new Error(`${type}: list came back empty or failed (http ${first?.http ?? '?'}, status ${first?.status ?? '?'}, ${first?.msg || first?.err || first?.snippet || 'no message'})`);
      }
    }

    const likes = results.likes.videos;
    const bookmarks = results.bookmarked.videos;

    if (likes.length || bookmarks.length) {
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const language = await page.evaluate(() => navigator.language);
      const cookies = await context.cookies('https://www.tiktok.com');
      syncState.phase = 'downloading';
      await downloadVideos({ cookies, ctx: { userAgent, browserInfo: { language } } }, { likes, bookmarks });
    } else {
      console.log('[sync] nothing new');
    }

    await page.screenshot({ path: SHOT_FILE }).catch(() => {});

    syncState.lastSummary = {
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      newLikes: likes.length,
      newBookmarks: bookmarks.length,
      user: results.likes.uniqueId || null,
    };
    syncState.lastRun = syncState.lastSummary.at;
  } catch (e) {
    syncState.lastError = e.message;
    console.error('[sync] failed:', e.message);
    try { await context?.pages()?.[0]?.screenshot({ path: SHOT_FILE }); } catch {}
  } finally {
    syncState.running = false;
    syncState.phase = null;
    await context?.close().catch(() => {});
  }
  return syncState.lastSummary;
}

export const screenshotPath = SHOT_FILE;
