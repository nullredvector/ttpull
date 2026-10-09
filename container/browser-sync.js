// Scheduled sync: drive a real browser (persistent profile) to the site, fetch
// the newest likes/bookmarks with the page's own signed requests, then hand the
// new videos to the downloader (which also registers them in the archive DB).

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { STATE_DIR, givenUp, getFlag, setFlag } from './state.js';
import { notify, heartbeat } from './notify.js';
import { readKnownIds, auditIds, refreshOfficialList } from './archive-db.js';
import { downloadVideos, getJobState } from './downloader.js';
import { listInPage, envInPage } from './page-fetch.js';

const ARCHIVE_DIR  = process.env.ARCHIVE_DIR || './archive';
const PROFILE_DIR  = path.join(STATE_DIR, 'profile');
const SHOT_FILE    = path.join(STATE_DIR, 'last.png');
const HOME_URL     = 'https://www.tiktok.com/foryou';
const MAX_PAGES    = Number(process.env.MAX_PAGES || 400);
const HEADLESS     = process.env.HEADLESS === '1';
const BLOCK_MEDIA  = process.env.BLOCK_MEDIA !== '0';
// Scheduled runs download at most this many new videos per list; use ?full=1 to catch up.
const MAX_PER_RUN  = Number(process.env.MAX_PER_RUN || 60);
const FULL_CHUNK       = Number(process.env.FULL_CHUNK || 100);
const FULL_MAX_PASSES  = Number(process.env.FULL_MAX_PASSES || 500);

export const syncState = {
  running: false,
  phase: null,
  lastRun: null,
  lastError: null,
  lastSummary: null,
  lastDiag: null,
  lastVerify: null,
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


// ── Notifications ────────────────────────────────────────────────────────────

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function authorsOf(videos) {
  const names = [...new Set(videos.map(v => v.authorName).filter(Boolean))];
  return names.length ? ` (${names.slice(0, 3).map(n => '@' + n).join(', ')}${names.length > 3 ? ', …' : ''})` : '';
}

async function onSyncSuccess(opts, likes, bookmarks, seconds) {
  if (getFlag('loginAlert')) {
    await setFlag('loginAlert', false);
    await notify('login', 'ttpull: login restored', 'Syncing again.', { tags: ['white_check_mark'] });
  }
  if (getFlag('failures')) {
    await setFlag('failures', false);
    await notify('failure', 'ttpull: sync recovered', 'Syncing normally again.', { tags: ['white_check_mark'] });
  }
  const parts = [];
  if (likes.length) parts.push(`${plural(likes.length, 'like')}${authorsOf(likes)}`);
  if (bookmarks.length) parts.push(`${plural(bookmarks.length, 'bookmark')}${authorsOf(bookmarks)}`);
  if (opts.full && !opts.test) {
    await notify('catchup', 'ttpull: catch-up complete',
      `${parts.join(' and ') || 'Nothing new'} added in ${Math.round(seconds / 60)} min.`, { tags: ['tada'] });
  } else if (parts.length && !opts.test) {
    await notify('new', 'ttpull: new videos', `${parts.join(' and ')} downloaded.`, { priority: 2, tags: ['inbox_tray'] });
  }
  await heartbeat();
}

async function onSyncFailure(message, opts) {
  if (opts.test) return;
  if (/login required/i.test(message)) {
    if (!getFlag('loginAlert')) {
      await setFlag('loginAlert', true);
      await notify('login', 'ttpull: login needed',
        'TikTok is signed out in the container. Open TikTok in your browser and click "Push Session Now" in the extension.',
        { priority: 5, tags: ['warning', 'key'] });
    }
    return;
  }
  const n = (getFlag('failureCount') || 0) + 1;
  await setFlag('failureCount', n);
  if (n >= 2 && !getFlag('failures')) {
    await setFlag('failures', true);
    await notify('failure', 'ttpull: sync is failing', `${n} failed runs in a row. Last error: ${message}`,
      { priority: 4, tags: ['rotating_light'] });
  }
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

    let seeded = false;
    let uniqueId = null;

    // One list-then-download pass. Returns the videos it fetched.
    const pass = async (limit, stopOnKnown) => {
      const common = { limit, stopOnKnown, maxPages: MAX_PAGES };
      const results = {};
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
        uniqueId = r.uniqueId || uniqueId;
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
      return { likes, bookmarks };
    };

    let likes = [], bookmarks = [];
    if (opts.full && !opts.test) {
      // Catch-up: work in chunks so download links are used while still fresh
      // and progress is registered as it goes.
      const seen = new Set();
      for (let i = 1; i <= FULL_MAX_PASSES; i++) {
        console.log(`[sync] full catch-up pass ${i} (chunk ${FULL_CHUNK})`);
        const r = await pass(FULL_CHUNK, false);
        const fresh = [...r.likes, ...r.bookmarks].filter(v => !seen.has(v.id));
        r.likes.forEach(v => seen.add(v.id));
        r.bookmarks.forEach(v => seen.add(v.id));
        likes.push(...r.likes);
        bookmarks.push(...r.bookmarks);
        syncState.phase = `catch-up pass ${i}: ${likes.length} likes, ${bookmarks.length} bookmarks so far`;
        if (!fresh.length) { console.log('[sync] catch-up complete'); break; }
      }
    } else {
      ({ likes, bookmarks } = await pass(opts.test ? 2 : MAX_PER_RUN, true));
    }

    await page.screenshot({ path: SHOT_FILE }).catch(() => {});

    syncState.lastSummary = {
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      newLikes: likes.length,
      newBookmarks: bookmarks.length,
      user: uniqueId,
    };
    syncState.lastRun = syncState.lastSummary.at;
    await setFlag('failureCount', 0);
    await onSyncSuccess(opts, likes, bookmarks, syncState.lastSummary.seconds);
  } catch (e) {
    syncState.lastError = e.message;
    console.error('[sync] failed:', e.message);
    await onSyncFailure(e.message, opts).catch(() => {});
    try { await context?.pages()?.[0]?.screenshot({ path: SHOT_FILE }); } catch {}
  } finally {
    syncState.running = false;
    syncState.phase = null;
    await context?.close().catch(() => {});
  }
  return syncState.lastSummary;
}


// Read-only: compare TikTok's complete lists with the archive (files + database).
// opts: { refresh }  refresh → also replace the database's official lists with TikTok's current ones
//       (what the viewer uses to show videos TikTok has since removed); quiet unless something changed.
export async function runVerify(getSession, opts = {}) {
  if (syncState.running || getJobState().running) return { skipped: true };
  syncState.running = true;
  syncState.phase = 'verifying';
  syncState.lastVerify = { running: true, startedAt: new Date().toISOString() };
  let context;
  try {
    context = await launchContext();
    const page = context.pages()[0] || await context.newPage();
    const session = getSession();
    if (!(await isLoggedIn(context)) && session?.cookies?.length) {
      await context.addCookies(session.cookies.map(toPlaywrightCookie)).catch(() => {});
    }
    await openHome(page);

    const report = { startedAt: syncState.lastVerify.startedAt };
    for (const [kind, type, sub] of [['likes', 'likes', 'Likes'], ['bookmarked', 'bookmarks', 'Favorites']]) {
      syncState.phase = `verifying ${type}`;
      const r = await listWithRetry(page, { type, known: [], limit: 0, stopOnKnown: false, maxPages: MAX_PAGES }, type);
      if (r.loggedOut) throw new Error('login required');
      if (r.error) throw new Error(`${type}: ${r.error}`);
      const ids = r.videos.map(v => String(v.id));

      let refresh = null;
      if (opts.refresh) {
        if (!r.diag.reachedEnd) {
          refresh = { applied: false, reason: 'list was not fetched to the end — left unchanged' };
        } else {
          try { refresh = await refreshOfficialList(ARCHIVE_DIR, kind, ids, m => console.log(m)); }
          catch (e) { refresh = { applied: false, reason: e.message }; }
        }
        if (refresh.reason && !['unchanged', 'dry run'].includes(refresh.reason) && !refresh.applied) {
          console.error(`[verify] ${type}: official list not updated — ${refresh.reason}`);
        }
      }

      const videosDir = path.join(ARCHIVE_DIR, 'data', sub, 'videos');
      const onDisk = new Set();
      try {
        for (const f of await fs.readdir(videosDir)) {
          if (!f.endsWith('.mp4')) continue;
          const st = await fs.stat(path.join(videosDir, f)).catch(() => null);
          if (st && st.size > 10 * 1024) onDisk.add(f.slice(0, -4));
        }
      } catch { /* folder missing */ }

      const missingFile = ids.filter(id => !onDisk.has(id));
      const gaveUp = givenUp(kind);
      const audit = await auditIds(ARCHIVE_DIR, kind, ids);
      const sample = a => ({ count: a.length, sample: a.slice(0, 25) });
      report[type] = {
        onTikTok: ids.length,
        pagesFetched: r.diag.pagesFetched,
        missingFile: sample(missingFile),
        gaveUpAfterFailures: sample(ids.filter(id => gaveUp.has(id))),
        notMarkedDownloaded: sample(audit.notDownloaded),
        notInOfficialList: sample(audit.notOfficial),
        noVideoRecord: sample(audit.noVideoRecord),
        noAuthorRecord: sample(audit.noAuthorRecord),
        ...(refresh ? { officialListRefresh: refresh } : {}),
        complete: !missingFile.length && !audit.notDownloaded.length && !audit.noVideoRecord.length && !audit.noAuthorRecord.length,
      };
      console.log(`[verify] ${type}: ${ids.length} on TikTok, ${missingFile.length} missing file, ${audit.notDownloaded.length} not in database, ${audit.noVideoRecord.length + audit.noAuthorRecord.length} hidden by missing records`);
    }
    report.finishedAt = new Date().toISOString();
    report.allComplete = report.likes.complete && report.bookmarks.complete;
    syncState.lastVerify = report;
    const gaps = n => report[n].missingFile.count + report[n].notMarkedDownloaded.count + report[n].noVideoRecord.count + report[n].noAuthorRecord.count;
    const newlyGone = ['likes', 'bookmarks'].reduce((t, n) => t + (report[n].officialListRefresh?.newlyDisappeared || 0), 0);
    const goneLine = opts.refresh
      ? ` Removed by TikTok since last check: ${newlyGone}.`
      : '';
    // A scheduled refresh stays quiet unless there is news.
    if (!opts.refresh || !opts.scheduled || newlyGone > 0 || !report.allComplete) {
      await notify('verify',
        report.allComplete ? 'ttpull: archive verified' : 'ttpull: archive has gaps',
        `Likes: ${report.likes.onTikTok} on TikTok, ${gaps('likes')} problems. Bookmarks: ${report.bookmarks.onTikTok} on TikTok, ${gaps('bookmarks')} problems.${goneLine}`,
        { priority: report.allComplete ? 3 : 4, tags: [report.allComplete ? 'white_check_mark' : 'warning'] });
    }
  } catch (e) {
    syncState.lastVerify = { error: e.message, at: new Date().toISOString() };
    console.error('[verify] failed:', e.message);
  } finally {
    syncState.running = false;
    syncState.phase = null;
    await context?.close().catch(() => {});
  }
  return syncState.lastVerify;
}

export const screenshotPath = SHOT_FILE;
