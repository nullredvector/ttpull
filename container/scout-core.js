// The scout: looks through the site's For You feed at a human pace, read-only, scores each cover with the
// scorer (autotagTT) and writes the best matches to the shared archive folder as SUGGESTIONS.
//
//   It never likes, unlikes, follows, comments, shares, saves or posts. There is no auto-like mode.
//   It never tries to get past a verification screen: it stops, says so, and stays stopped.
//
// This file is the logic only (settings, limits, stop rules, files). The browser lives in scout-feed.js and
// is passed in, so every rule here can be tested with a fake feed, a fake scorer and a fake clock.
//
// Files (all inside the archive's data/.appdata/):
//   scout/candidates.jsonl   one suggestion per line, appended (cover written first, line second)
//   scout/covers/<id>.jpg    the cover image only, never the video
//   scout/status.json        what the scout is doing (atomic write)
//   settings.json            read every loop: scoutEnabled, scoutDaily, scoutMin, scoutFrom, scoutTo
//   scout_feedback.json      the user's decisions (written by kashibox, only read here)
// The scout's own memory (videos already seen, today's counters, a stop) lives in STATE_DIR/scout/, not in the archive.

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

export const DEFAULTS = { scoutEnabled: false, scoutDaily: 100, scoutMin: 60, scoutFrom: 0, scoutTo: 23 };

export const LIMITS = {
  PENDING_MAX: 200,                 // this many unanswered suggestions and the scout stops collecting
  SESSION_S: [900, 1200],           // a session lasts 15-20 minutes
  REST_S: [1800, 5400],             // then it rests 30-90 minutes
  PAUSE_MS: [3000, 12000],          // between videos
  LONG_PAUSE_CHANCE: 0.1,           // now and then a longer pause
  LONG_PAUSE_MS: [15000, 40000],
  STOP_MS: 6 * 3600 * 1000,         // after a challenge, a login prompt or an error it stays stopped this long
  COVER_MAX_BYTES: 1_000_000,
  KEEP_CANDIDATES: 5000,
  TRIM_AT: 5500,
  MAX_CONSECUTIVE_ERRORS: 5,
  FEED_FAILS: 3,                    // the feed failing to load this many times in a row stops the run
  SCORER_TRIES: 4,
  SCORER_WAIT_MS: [5000, 10000, 20000],
  STATUS_EVERY_MS: 3 * 60 * 1000,
  SEEN_KEEP: 100000,
};

// Thrown by the feed (or the core) to stop the whole run: state is 'challenge', 'login' or 'error'.
export class ScoutStop extends Error {
  constructor(state, message) { super(message); this.state = state; }
}
// One failed feed load. Three in a row stop the run.
export class FeedHiccup extends Error {}
// The scorer is not answering. Never guess a score.
export class ScorerDown extends Error {}

// ── settings ─────────────────────────────────────────────────────────────────

export function clampInt(v, dflt, lo, hi) {
  const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

export async function readScoutSettings(archiveDir) {
  let raw = {};
  try { raw = JSON.parse(await fs.readFile(path.join(archiveDir, 'data', '.appdata', 'settings.json'), 'utf8')) || {}; } catch { /* defaults */ }
  return {
    enabled: raw.scoutEnabled === true,
    daily: clampInt(raw.scoutDaily, DEFAULTS.scoutDaily, 0, 5000),
    min: clampInt(raw.scoutMin, DEFAULTS.scoutMin, 0, 100),
    from: clampInt(raw.scoutFrom, DEFAULTS.scoutFrom, 0, 23),
    to: clampInt(raw.scoutTo, DEFAULTS.scoutTo, 0, 23),
  };
}

// Both ends inclusive. from > to wraps past midnight. 0 and 23 means any time.
export function inWindow(hour, from, to) {
  if (from === 0 && to === 23) return true;
  return from <= to ? (hour >= from && hour <= to) : (hour >= from || hour <= to);
}

export const localDate = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── reading the archive (never writing it) ───────────────────────────────────

async function readDbJson(appdata, file) {
  const raw = await fs.readFile(path.join(appdata, file), 'utf8');
  const m = raw.match(/="([A-Za-z0-9+/=\s]+)"/);
  if (!m) throw new Error(`${file}: unrecognised`);
  return JSON.parse(zlib.gunzipSync(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).toString('utf8'));
}

const mtimeOf = (p) => fs.stat(p).then(s => s.mtimeMs, () => -1);
const idsCache = new Map();

// { have: every id in Likes, Favorites and Following, likes: the Likes ids }. Re-read only when the files change.
export async function archiveIds(archiveDir) {
  const appdata = path.join(archiveDir, 'data', '.appdata');
  const files = ['db_likes.js', 'db_bookmarked.js', 'db_following.js'];
  const stamp = (await Promise.all(files.map(f => mtimeOf(path.join(appdata, f))))).join('|');
  const hit = idsCache.get(archiveDir);
  if (hit && hit.stamp === stamp) return hit.value;
  const likes = new Set(), have = new Set();
  const grab = async (file, pick) => { try { for (const id of pick(await readDbJson(appdata, file)) || []) { have.add(String(id)); if (file === 'db_likes.js') likes.add(String(id)); } } catch { /* optional */ } };
  await grab('db_likes.js', d => (d.likes || d).downloaded);
  await grab('db_bookmarked.js', d => d.downloaded);
  await grab('db_following.js', d => Object.values(d.authorItems || {}).flatMap(it => [...(it.inFolder || []), ...(it.disappeared || [])]));
  const value = { have, likes };
  idsCache.set(archiveDir, { stamp, value });
  return value;
}

export async function readCandidates(archiveDir) {
  const out = new Map();
  let lines = 0;
  try {
    const text = await fs.readFile(path.join(archiveDir, 'data', '.appdata', 'scout', 'candidates.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      try { const c = JSON.parse(line); if (c && /^\d{5,25}$/.test(String(c.id))) out.set(String(c.id), c); } catch { /* a half-written last line */ }
    }
  } catch { /* none yet */ }
  return { map: out, lines };
}

export async function readFeedback(archiveDir) {
  try {
    const d = JSON.parse(await fs.readFile(path.join(archiveDir, 'data', '.appdata', 'scout_feedback.json'), 'utf8'));
    return d && typeof d.decisions === 'object' && d.decisions ? d.decisions : {};
  } catch { return {}; }
}

// Suggestions the user has not answered: no decision recorded and not in the archive's Likes list.
export async function pendingCount(archiveDir) {
  const [{ map }, decisions, { likes }] = await Promise.all([readCandidates(archiveDir), readFeedback(archiveDir), archiveIds(archiveDir)]);
  let n = 0;
  for (const id of map.keys()) if (!(id in decisions) && !likes.has(id)) n++;
  return n;
}

// ── writing: only the scout folder, and only through here ────────────────────

export function makeStore(archiveDir, { dry = false } = {}) {
  const appdata = path.join(archiveDir, 'data', '.appdata');
  const scoutDir = path.join(appdata, 'scout');
  const candidates = path.join(scoutDir, 'candidates.jsonl');
  const ensure = () => fs.mkdir(path.join(scoutDir, 'covers'), { recursive: true });
  const appdataExists = () => fs.stat(appdata).then(s => s.isDirectory(), () => false);
  const atomic = async (file, data) => { const tmp = `${file}.tmp`; await fs.writeFile(tmp, data); await fs.rename(tmp, file); };
  return {
    coverPath: id => path.join(scoutDir, 'covers', `${id}.jpg`),
    async writeStatus(obj, { onlyIfExists = false } = {}) {
      if (dry || !(await appdataExists())) return;
      const file = path.join(scoutDir, 'status.json');
      if (onlyIfExists && !(await fs.stat(file).then(() => true, () => false))) return;   // nothing to update
      await ensure();
      await atomic(file, JSON.stringify(obj));
    },
    async writeCover(id, bytes) {
      if (dry) return;
      await ensure();
      await atomic(path.join(scoutDir, 'covers', `${id}.jpg`), bytes);
    },
    // one write call, ending with a newline
    async appendCandidate(line) {
      if (dry) return;
      await ensure();
      const fh = await fs.open(candidates, 'a');
      try { await fh.write(line + '\n'); } finally { await fh.close(); }
    },
    async trimCandidates(keep = LIMITS.KEEP_CANDIDATES) {
      if (dry) return;
      let text;
      try { text = await fs.readFile(candidates, 'utf8'); } catch { return; }
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length <= LIMITS.TRIM_AT) return;
      await atomic(candidates, lines.slice(-keep).join('\n') + '\n');
    },
  };
}

// ── the scout ────────────────────────────────────────────────────────────────

const clean = (s, max, re) => String(s ?? '').replace(re, '').slice(0, max);

export function createScout(deps) {
  const { archiveDir, stateDir } = deps;
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const random = deps.random || Math.random;
  const log = deps.log || (m => console.log('[scout] ' + m));
  const notify = deps.notify || (async () => {});
  const dry = String(env.SCOUT_DRY || '') === '1';
  const store = deps.store || makeStore(archiveDir, { dry });
  const lock = deps.lock || { acquire: async () => true, release: () => {}, shouldYield: () => false };
  const isSyncRunning = deps.isSyncRunning || (() => false);
  const myDir = path.join(stateDir, 'scout');
  const rand = ([lo, hi]) => lo + random() * (hi - lo);

  let st = null;               // persistent: today's counters, when to start next, a stop
  let seen = null;             // Set of ids already looked at (not in the archive)
  let lastStatus = null, lastStatusAt = 0;

  const atomic = async (file, data) => { const tmp = `${file}.tmp`; await fs.writeFile(tmp, data); await fs.rename(tmp, file); };

  async function load() {
    if (st) return;
    await fs.mkdir(myDir, { recursive: true });
    try { st = JSON.parse(await fs.readFile(path.join(myDir, 'state.json'), 'utf8')); } catch { st = null; }
    st = { today: { date: localDate(now()), viewed: 0, collected: 0 }, nextSessionAt: 0, stopped: null, ...(st || {}) };
    try { seen = new Set(JSON.parse(await fs.readFile(path.join(myDir, 'seen.json'), 'utf8'))); } catch { seen = new Set(); }
  }
  async function save() {
    await fs.mkdir(myDir, { recursive: true });
    await atomic(path.join(myDir, 'state.json'), JSON.stringify(st));
    const ids = [...seen];
    await atomic(path.join(myDir, 'seen.json'), JSON.stringify(ids.length > LIMITS.SEEN_KEEP ? ids.slice(-LIMITS.SEEN_KEEP) : ids));
  }

  function rollDay() {
    const d = localDate(now());
    if (st.today.date !== d) st.today = { date: d, viewed: 0, collected: 0 };
  }

  async function setStatus(state, message = '', force = false, onlyIfExists = false) {
    const t = now();
    const same = lastStatus && lastStatus.state === state && lastStatus.message === message;
    if (same && !force && (state === 'off' || t - lastStatusAt < LIMITS.STATUS_EVERY_MS)) return;
    lastStatus = { state, updated: t, message, today: { date: st.today.date, viewed: st.today.viewed, collected: st.today.collected } };
    lastStatusAt = t;
    if (dry) { log(`(dry run) status: ${state}${message ? ' — ' + message : ''}`); return; }
    try { await store.writeStatus(lastStatus, { onlyIfExists }); } catch (e) { log(`could not write status.json: ${e.message}`); }
  }

  async function stop(state, message) {
    st.stopped = { until: now() + LIMITS.STOP_MS, state, message };
    st.nextSessionAt = 0;
    log(`stopped (${state}): ${message}`);
    await setStatus(state, message, true);
    await save();
    try {
      if (state === 'login') await notify('login', 'ttpull: the scout needs you to log in', 'The site shows a log-in prompt, so the scout stopped. Push a fresh session from the extension.', { priority: 4, tags: ['key'], dedupeKey: 'scout-login', dedupeMs: LIMITS.STOP_MS });
      else await notify('scout', state === 'challenge' ? 'ttpull: the scout stopped (verification screen)' : 'ttpull: the scout stopped', `${message} It will stay stopped for 6 hours. Nothing was clicked or liked.`, { priority: 4, tags: ['stop_sign'], dedupeKey: 'scout-stop', dedupeMs: LIMITS.STOP_MS });
    } catch { /* a notification problem must not matter */ }
  }

  const allowed = async () => {
    const s = await readScoutSettings(archiveDir);
    return { s, on: String(env.SCOUT || 'off').toLowerCase() === 'on' && s.enabled };
  };

  // One pass of the loop. Returns what it decided (the loop and the tests use it).
  async function cycle() {
    await load();
    rollDay();
    const { s, on } = await allowed();

    if (!on) {
      if (st.stopped) { st.stopped = null; await save(); }   // switching it off clears a stop: off, then on, starts fresh
      // with the SCOUT variable off (the default) an archive is left exactly as it is
      await setStatus('off', '', false, String(env.SCOUT || 'off').toLowerCase() !== 'on');
      return 'off';
    }
    if (st.stopped) {
      if (now() < st.stopped.until) { await setStatus(st.stopped.state, st.stopped.message); return 'stopped'; }
      st.stopped = null; await save();
    }
    if (!inWindow(new Date(now()).getHours(), s.from, s.to)) { await setStatus('paused', 'Outside the hours you set.'); return 'outside-hours'; }
    if (s.daily === 0 || st.today.viewed >= s.daily) { await setStatus('paused', 'Today\'s limit is reached.'); return 'daily-limit'; }
    if (isSyncRunning()) { await setStatus('idle', 'Waiting for the likes sync to finish.'); return 'waiting-sync'; }
    if ((await pendingCount(archiveDir)) >= LIMITS.PENDING_MAX) { await setStatus('paused', 'Waiting for you to go through the picks.'); return 'backpressure'; }
    if (now() < st.nextSessionAt) { await setStatus('idle', 'Resting between sessions.'); return 'resting'; }

    if (!(await lock.acquire('scout'))) { await setStatus('idle', 'The browser is busy.'); return 'busy'; }
    try {
      await session();
    } finally {
      lock.release('scout');
    }
    return 'session';
  }

  async function session() {
    const endAt = now() + rand(LIMITS.SESSION_S) * 1000;
    let feed = null;
    let errorsInRow = 0, feedFails = 0, collectedBefore = st.today.collected, sinceSave = 0;
    let known = await archiveIds(archiveDir);
    let { map: cands } = await readCandidates(archiveDir);
    let decisions = await readFeedback(archiveDir);
    await setStatus('running', '', true);
    log(`session started${dry ? ' (dry run)' : ''}`);
    try {
      feed = await deps.feed.open();
      while (now() < endAt) {
        if (lock.shouldYield()) { log('the browser is needed elsewhere — ending the session'); break; }
        const { s, on } = await allowed();                       // a change in Settings applies within a video or two
        if (!on) { await setStatus('off'); break; }
        if (!inWindow(new Date(now()).getHours(), s.from, s.to)) { await setStatus('paused', 'Outside the hours you set.'); break; }
        rollDay();
        if (st.today.viewed >= s.daily) { await setStatus('paused', 'Today\'s limit is reached.'); break; }
        if (isSyncRunning()) { await setStatus('idle', 'Waiting for the likes sync to finish.'); break; }
        if (sinceSave % 20 === 19 && (await pendingCount(archiveDir)) >= LIMITS.PENDING_MAX) { await setStatus('paused', 'Waiting for you to go through the picks.'); break; }

        let item;
        try {
          item = await feed.next();
          feedFails = 0;
        } catch (e) {
          if (e instanceof ScoutStop) throw e;
          if (e instanceof FeedHiccup) {
            if (++feedFails >= LIMITS.FEED_FAILS) throw new ScoutStop('error', 'The feed would not load three times in a row.');
            await sleep(rand([4000, 9000]));
            continue;
          }
          throw e;
        }
        st.today.viewed++;
        sinceSave++;

        try {
          await handle(item, s, known, cands, decisions);
          errorsInRow = 0;
        } catch (e) {
          if (e instanceof ScoutStop || e instanceof ScorerDown) throw e;
          errorsInRow++;
          log(`one video could not be handled (${String(e.message || e).slice(0, 80)})`);
          if (errorsInRow > LIMITS.MAX_CONSECUTIVE_ERRORS) throw new ScoutStop('error', 'Too many errors in a row.');
        }
        if (sinceSave % 10 === 0) { await save(); await setStatus('running'); }

        let pause = rand(LIMITS.PAUSE_MS);
        if (random() < LIMITS.LONG_PAUSE_CHANCE) pause += rand(LIMITS.LONG_PAUSE_MS);
        await sleep(pause);
      }
      st.nextSessionAt = now() + rand(LIMITS.REST_S) * 1000;
      if (lastStatus && lastStatus.state === 'running') await setStatus('idle', 'Resting between sessions.', true);
    } catch (e) {
      if (e instanceof ScoutStop) await stop(e.state, e.message);
      else if (e instanceof ScorerDown) await stop('error', 'The scorer is not answering.');
      else await stop('error', `Something went wrong: ${String(e.message || e).slice(0, 120)}`);
    } finally {
      try { await feed?.close(); } catch { /* ignore */ }
      try { await store.trimCandidates(); } catch { /* ignore */ }
      await save();
      log(`session ended: ${st.today.collected - collectedBefore} collected, ${st.today.viewed} looked at today`);
    }
  }

  async function handle(item, s, known, cands, decisions) {
    const id = String(item.id || '');
    if (!/^\d{5,25}$/.test(id)) return;
    if (known.have.has(id) || cands.has(id) || id in decisions || seen.has(id)) return;
    seen.add(id);
    if (!item.coverUrl) return;

    let bytes;
    try { bytes = await deps.fetchCover(item.coverUrl); }
    catch (e) { if (e && e.code === 'TOO_BIG') return; throw e; }
    if (!bytes || !bytes.length || bytes.length > LIMITS.COVER_MAX_BYTES) return;

    const r = await scoreWithRetry(id, bytes);
    const score = Math.max(0, Math.min(1, Number(r.score)));
    if (!Number.isFinite(score)) throw new Error('the scorer sent no score');
    if (Math.round(score * 100) < s.min) return;

    const line = JSON.stringify({
      id,
      author: clean(item.author, 64, /[^A-Za-z0-9_.-]/g),
      desc: clean(item.desc, 300, new RegExp('[\\u0000-\\u001f\\u2028\\u2029]', 'g')),
      score: Math.round(score * 10000) / 10000,
      tags: (Array.isArray(r.tags) ? r.tags : []).filter(t => Array.isArray(t) && typeof t[0] === 'string' && Number.isFinite(Number(t[1]))).slice(0, 3)
        .map(t => [t[0].slice(0, 60), Math.max(0, Math.min(1, Number(t[1])))]),
      found: now(),
    });
    if (dry) { log(`(dry run) would collect one pick, score ${Math.round(score * 100)}%`); st.today.collected++; cands.set(id, {}); return; }
    await store.writeCover(id, bytes);          // the cover first,
    await store.appendCandidate(line);          // the line second
    cands.set(id, {});
    st.today.collected++;
  }

  async function scoreWithRetry(id, bytes) {
    let last;
    for (let i = 0; i < LIMITS.SCORER_TRIES; i++) {
      try { return await deps.scorer.score(id, bytes); }
      catch (e) {
        last = e;
        if (!(e && e.retry)) throw e;                      // a bad request is not worth retrying
        if (i < LIMITS.SCORER_TRIES - 1) await sleep(LIMITS.SCORER_WAIT_MS[Math.min(i, LIMITS.SCORER_WAIT_MS.length - 1)]);
      }
    }
    throw new ScorerDown(String(last && last.message || 'unavailable'));
  }

  // The loop the server runs: every minute, and cleanly stoppable.
  let running = false, timer = null;
  async function run() {
    running = true;
    while (running) {
      try { await cycle(); } catch (e) { log(`loop error: ${String(e.message || e).slice(0, 100)}`); }
      await new Promise(r => { timer = setTimeout(r, 60000); });
    }
  }
  function halt() { running = false; clearTimeout(timer); }

  return { cycle, run, halt, state: () => st, status: () => lastStatus, setStatus, isDry: dry };
}
