// Tests for the scout's rules, with a fake feed, a fake scorer, a fake cover download and a fake clock.
// Everything is invented: made-up ids, names and captions. No account, no network, no browser.
// Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  createScout, makeStore, readScoutSettings, inWindow, localDate, LIMITS,
  ScoutStop, FeedHiccup, pendingCount, DEFAULTS,
} from '../scout-core.js';

const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'ttpull-scout-'));
let counter = 0;

// ── helpers ──────────────────────────────────────────────────────────────────

const at = (h, m = 0, day = 24) => new Date(2026, 9, day, h, m, 0).getTime();   // local time, 24 Oct 2026

function seeded(seed = 7) {                       // a small repeatable random generator
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

async function writeDb(appdata, file, varName, obj) {
  const b64 = zlib.gzipSync(JSON.stringify(obj)).toString('base64');
  await fs.writeFile(path.join(appdata, file), `window.${varName}="${b64}";`);
}

const idOf = i => String(70000000000000 + i);
const defaultItem = i => ({ id: idOf(i), author: `user_${i}`, desc: `a made-up caption ${i}`, coverUrl: `https://cdn.invalid/cover/${i}` });

function fakeFeed(source = defaultItem) {
  const f = { opened: 0, closed: 0, served: 0 };
  f.open = async () => {
    f.opened++;
    let i = 0;
    return {
      next: async () => {
        const v = typeof source === 'function' ? source(i++) : source[i++];
        if (v instanceof Error) throw v;
        if (v === undefined) throw new FeedHiccup('end of the fake feed');
        f.served++;
        return v;
      },
      close: async () => { f.closed++; },
    };
  };
  return f;
}

async function setup({ settings, env = { SCOUT: 'on' }, feed, score = () => 0.9, tags, scorerError, files = {}, start = at(12), random, appdata = true } = {}) {
  const archive = path.join(SCRATCH, `a${++counter}`);
  const stateDir = path.join(SCRATCH, `s${counter}`);
  const ad = path.join(archive, 'data', '.appdata');
  if (appdata) await fs.mkdir(ad, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  if (settings && appdata) await fs.writeFile(path.join(ad, 'settings.json'), JSON.stringify(settings));
  for (const [name, fn] of Object.entries(files)) await fn(ad);

  const clock = { t: start };
  const calls = { cover: [], score: [], sleeps: [] };
  const notices = [];
  const logs = [];
  const f = feed || fakeFeed();
  const store = makeStore(archive, { dry: String(env.SCOUT_DRY || '') === '1' });
  const scout = createScout({
    archiveDir: archive, stateDir, env, store,
    now: () => clock.t,
    sleep: async ms => { calls.sleeps.push(ms); clock.t += ms; },
    random: random || seeded(3),
    log: m => logs.push(m),
    notify: async (event, title, message) => { notices.push({ event, title, message }); },
    feed: f,
    fetchCover: async url => { calls.cover.push(url); return Buffer.from(`jpeg-bytes-${url}`); },
    scorer: {
      score: async (id, bytes) => {
        calls.score.push(id);
        if (scorerError) throw scorerError();
        return { score: typeof score === 'function' ? score(id, calls.score.length - 1) : score, tags: tags || [['alpha', 0.91], ['beta', 0.74], ['gamma', 0.5], ['delta', 0.4]] };
      },
    },
  });
  return { archive, ad, stateDir, clock, calls, notices, logs, feed: f, scout, store };
}

const readStatus = async ctx => JSON.parse(await fs.readFile(path.join(ctx.ad, 'scout', 'status.json'), 'utf8'));
const readLines = async ctx => (await fs.readFile(path.join(ctx.ad, 'scout', 'candidates.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const exists = p => fs.stat(p).then(() => true, () => false);
const ON = { scoutEnabled: true };

// ── off by default ───────────────────────────────────────────────────────────

test('it does nothing and writes nothing when the SCOUT variable is not on (the default)', async () => {
  const c = await setup({ env: {}, settings: ON });
  assert.equal(await c.scout.cycle(), 'off');
  assert.equal(c.feed.opened, 0);
  assert.deepEqual(c.calls.cover, []);
  assert.deepEqual(c.calls.score, []);
  assert.equal(await exists(path.join(c.ad, 'scout')), false, 'the archive is left exactly as it was');
});

test('with the variable off it only updates a status.json that already exists', async () => {
  const c = await setup({ env: {}, settings: ON });
  await fs.mkdir(path.join(c.ad, 'scout'), { recursive: true });
  await fs.writeFile(path.join(c.ad, 'scout', 'status.json'), JSON.stringify({ state: 'running' }));
  await c.scout.cycle();
  assert.equal((await readStatus(c)).state, 'off');
});

test('the variable off beats the Settings switch', async () => {
  const c = await setup({ env: { SCOUT: 'off' }, settings: ON });
  assert.equal(await c.scout.cycle(), 'off');
  assert.equal(c.feed.opened, 0);
});

test('the Settings switch off (or missing) keeps it off, and says so', async () => {
  for (const settings of [undefined, { scoutEnabled: false }, { scoutEnabled: 'true' }, { scoutEnabled: 1 }]) {
    const c = await setup({ settings });
    assert.equal(await c.scout.cycle(), 'off', JSON.stringify(settings));
    assert.equal(c.feed.opened, 0);
    assert.equal((await readStatus(c)).state, 'off');
  }
});

// ── settings and the hour window ─────────────────────────────────────────────

test('missing or odd settings fall back to the defaults', async () => {
  const c = await setup({ settings: { scoutEnabled: true, scoutDaily: 'lots', scoutMin: 500, scoutFrom: -4, scoutTo: 99 } });
  assert.deepEqual(await readScoutSettings(c.archive), { enabled: true, daily: DEFAULTS.scoutDaily, min: 100, from: 0, to: 23 });
  const d = await setup({});
  assert.deepEqual(await readScoutSettings(d.archive), { enabled: false, daily: 100, min: 60, from: 0, to: 23 });
});

test('the hour window: normal, wrapping past midnight, and "any time"', () => {
  assert.equal(inWindow(12, 9, 17), true);
  assert.equal(inWindow(9, 9, 17), true);
  assert.equal(inWindow(17, 9, 17), true);
  assert.equal(inWindow(18, 9, 17), false);
  assert.equal(inWindow(8, 9, 17), false);
  assert.equal(inWindow(23, 22, 6), true);
  assert.equal(inWindow(3, 22, 6), true);
  assert.equal(inWindow(6, 22, 6), true);
  assert.equal(inWindow(12, 22, 6), false);
  assert.equal(inWindow(3, 0, 23), true);
  assert.equal(inWindow(12, 12, 12), true);
  assert.equal(inWindow(13, 12, 12), false);
});

test('outside the hours it pauses and does not look', async () => {
  const c = await setup({ settings: { ...ON, scoutFrom: 9, scoutTo: 17 }, start: at(20) });
  assert.equal(await c.scout.cycle(), 'outside-hours');
  assert.equal(c.feed.opened, 0);
  assert.equal((await readStatus(c)).state, 'paused');
});

test('inside the hours it looks', async () => {
  const c = await setup({ settings: { ...ON, scoutFrom: 9, scoutTo: 17 }, start: at(10) });
  assert.equal(await c.scout.cycle(), 'session');
  assert.equal(c.feed.opened, 1);
});

test('a window that wraps past midnight works at night and not at noon', async () => {
  const night = await setup({ settings: { ...ON, scoutFrom: 22, scoutTo: 6 }, start: at(2) });
  assert.equal(await night.scout.cycle(), 'session');
  const noon = await setup({ settings: { ...ON, scoutFrom: 22, scoutTo: 6 }, start: at(12) });
  assert.equal(await noon.scout.cycle(), 'outside-hours');
});

test('leaving the window mid-session ends the session at once', async () => {
  const c = await setup({ settings: { ...ON, scoutFrom: 9, scoutTo: 11 }, start: at(11, 55), random: seeded(2) });
  assert.equal(await c.scout.cycle(), 'session');
  assert.ok(c.clock.t >= at(12, 0), 'it kept going until the hour changed');
  assert.ok(c.clock.t < at(12, 2), 'and stopped within a video of 12:00, not 15 minutes later');
  assert.equal((await readStatus(c)).state, 'paused');
});

// ── the daily limit ──────────────────────────────────────────────────────────

test('it never looks at more than scoutDaily videos in a day, and resets at local midnight', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 5 } });
  assert.equal(await c.scout.cycle(), 'session');
  assert.equal(c.scout.state().today.viewed, 5);
  assert.equal(c.feed.served, 5);
  assert.equal(await c.scout.cycle(), 'daily-limit');
  assert.equal(c.feed.opened, 1, 'no second session');
  assert.equal((await readStatus(c)).state, 'paused');
  c.clock.t = at(0, 5, 25);                                                                   // just past midnight
  c.scout.state().nextSessionAt = 0;
  assert.equal(await c.scout.cycle(), 'session');
  assert.equal(c.scout.state().today.date, localDate(at(0, 5, 25)));
  assert.equal(c.scout.state().today.viewed, 5, 'a fresh day, a fresh five');
});

test('scoutDaily 0 pauses it', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 0 } });
  assert.equal(await c.scout.cycle(), 'daily-limit');
  assert.equal(c.feed.opened, 0);
});

test('the counters survive a restart', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 7 } });
  await c.scout.cycle();
  const again = createScout({ archiveDir: c.archive, stateDir: c.stateDir, env: { SCOUT: 'on' }, now: () => c.clock.t, sleep: async () => {}, log: () => {}, feed: fakeFeed(), fetchCover: async () => Buffer.from('x'), scorer: { score: async () => ({ score: 1, tags: [] }) } });
  assert.equal(await again.cycle(), 'daily-limit');
});

// ── never at the same time as the likes sync ────────────────────────────────

test('it waits while the likes sync is running', async () => {
  const c = await setup({ settings: ON });
  let running = true;
  const scout = createScout({ archiveDir: c.archive, stateDir: c.stateDir, env: { SCOUT: 'on' }, now: () => c.clock.t, sleep: async ms => { c.clock.t += ms; }, log: () => {}, isSyncRunning: () => running, feed: c.feed, fetchCover: async () => Buffer.from('x'), scorer: { score: async () => ({ score: 1, tags: [] }) } });
  assert.equal(await scout.cycle(), 'waiting-sync');
  assert.equal(c.feed.opened, 0);
  running = false;
  assert.equal(await scout.cycle(), 'session');
});

test('a sync that starts during a session ends the session', async () => {
  const c = await setup({ settings: ON });
  let running = false;
  const feed = fakeFeed(i => { if (i === 4) running = true; return defaultItem(i); });
  const scout = createScout({ archiveDir: c.archive, stateDir: c.stateDir, env: { SCOUT: 'on' }, now: () => c.clock.t, sleep: async ms => { c.clock.t += ms; }, log: () => {}, isSyncRunning: () => running, feed, fetchCover: async () => Buffer.from('x'), scorer: { score: async () => ({ score: 1, tags: [] }) } });
  await scout.cycle();
  assert.equal(feed.closed, 1, 'the browser was closed');
  assert.ok(scout.state().today.viewed <= 6, `it stopped soon after the sync began (looked at ${scout.state().today.viewed})`);
});

test('the browser lock: busy means it waits, and being asked to yield ends the session', async () => {
  const c = await setup({ settings: ON });
  const busy = createScout({ archiveDir: c.archive, stateDir: c.stateDir, env: { SCOUT: 'on' }, now: () => c.clock.t, sleep: async ms => { c.clock.t += ms; }, log: () => {}, lock: { acquire: async () => false, release: () => {}, shouldYield: () => false }, feed: c.feed, fetchCover: async () => Buffer.from('x'), scorer: { score: async () => ({ score: 1, tags: [] }) } });
  assert.equal(await busy.cycle(), 'busy');
  assert.equal(c.feed.opened, 0);

  let released = 0;
  const yielding = createScout({ archiveDir: c.archive, stateDir: c.stateDir + 'y', env: { SCOUT: 'on' }, now: () => c.clock.t, sleep: async ms => { c.clock.t += ms; }, log: () => {}, lock: { acquire: async () => true, release: () => { released++; }, shouldYield: () => true }, feed: c.feed, fetchCover: async () => Buffer.from('x'), scorer: { score: async () => ({ score: 1, tags: [] }) } });
  await yielding.cycle();
  assert.equal(yielding.state().today.viewed, 0, 'it gave the browser up before looking at anything');
  assert.equal(released, 1, 'and let go of the lock');
});

// ── backpressure ─────────────────────────────────────────────────────────────

async function seedCandidates(ctx, n, from = 0) {
  await fs.mkdir(path.join(ctx.ad, 'scout'), { recursive: true });
  const lines = [];
  for (let i = from; i < from + n; i++) lines.push(JSON.stringify({ id: String(80000000000000 + i), author: 'x', desc: '', score: 0.9, tags: [], found: 1 }));
  await fs.writeFile(path.join(ctx.ad, 'scout', 'candidates.jsonl'), lines.join('\n') + '\n');
}

test('200 unanswered picks stop it collecting; 199 do not', async () => {
  const c = await setup({ settings: ON });
  await seedCandidates(c, 200);
  assert.equal(await pendingCount(c.archive), 200);
  assert.equal(await c.scout.cycle(), 'backpressure');
  assert.equal(c.feed.opened, 0);
  assert.equal((await readStatus(c)).state, 'paused');

  const d = await setup({ settings: ON });
  await seedCandidates(d, 199);
  assert.equal(await d.scout.cycle(), 'session');
});

test('answered picks and picks already in the Likes list do not count as waiting', async () => {
  const c = await setup({ settings: ON, files: { likes: ad => writeDb(ad, 'db_likes.js', 'db_base64', { likes: { downloaded: ['80000000000000', '80000000000001', '80000000000002'] } }) } });
  await seedCandidates(c, 205);
  const decisions = {};
  for (let i = 10; i < 20; i++) decisions[String(80000000000000 + i)] = { d: 'skipped', t: 1 };
  await fs.writeFile(path.join(c.ad, 'scout_feedback.json'), JSON.stringify({ decisions }));
  assert.equal(await pendingCount(c.archive), 205 - 3 - 10);
  assert.equal(await c.scout.cycle(), 'session');
});

test('a session that fills the queue ends and the scout waits', async () => {
  const c = await setup({ settings: ON, score: 0.95 });
  await seedCandidates(c, 190);
  await c.scout.cycle();
  assert.ok((await pendingCount(c.archive)) >= LIMITS.PENDING_MAX, 'it filled the queue');
  assert.equal((await pendingCount(c.archive)) < LIMITS.PENDING_MAX + 25, true, 'and stopped soon after');
  assert.equal(await c.scout.cycle(), 'backpressure');
});

// ── stop conditions ──────────────────────────────────────────────────────────

test('a verification screen stops it, tells you, clicks nothing and stays stopped for 6 hours', async () => {
  const feed = fakeFeed(i => (i === 3 ? new ScoutStop('challenge', 'A verification screen appeared.') : defaultItem(i)));
  const c = await setup({ settings: ON, feed });
  await c.scout.cycle();
  const st = await readStatus(c);
  assert.equal(st.state, 'challenge');
  assert.match(st.message, /verification/i);
  assert.equal(feed.closed, 1, 'the browser was closed');
  assert.equal(c.notices.filter(n => n.event === 'scout').length, 1);
  assert.match(c.notices[0].message, /6 hours/);

  assert.equal(await c.scout.cycle(), 'stopped');
  c.clock.t += 5 * 3600e3 + 59 * 60e3;
  assert.equal(await c.scout.cycle(), 'stopped', 'still stopped after 5 h 59 min');
  assert.equal(feed.opened, 1);
  c.clock.t += 2 * 60e3;
  assert.equal(await c.scout.cycle(), 'session', 'it may try again after 6 hours');
  assert.equal(feed.opened, 2);
});

test('switching the scout off and on again clears a stop at once', async () => {
  const feed = fakeFeed(i => (i === 2 ? new ScoutStop('challenge', 'A verification screen appeared.') : defaultItem(i)));
  const c = await setup({ settings: ON, feed });
  await c.scout.cycle();
  assert.equal(await c.scout.cycle(), 'stopped');
  await fs.writeFile(path.join(c.ad, 'settings.json'), JSON.stringify({ scoutEnabled: false }));
  assert.equal(await c.scout.cycle(), 'off');
  await fs.writeFile(path.join(c.ad, 'settings.json'), JSON.stringify(ON));
  c.scout.state().nextSessionAt = 0;
  assert.equal(await c.scout.cycle(), 'session', 'off then on: no six-hour wait');
});

test('a log-in prompt stops it with the login state and the existing login notification', async () => {
  const feed = fakeFeed(i => (i === 1 ? new ScoutStop('login', 'The site shows a log-in prompt.') : defaultItem(i)));
  const c = await setup({ settings: ON, feed });
  await c.scout.cycle();
  assert.equal((await readStatus(c)).state, 'login');
  assert.deepEqual(c.notices.map(n => n.event), ['login']);
  assert.equal(await c.scout.cycle(), 'stopped');
});

test('being refused (403 or 429) stops it with a plain message', async () => {
  const feed = fakeFeed(i => (i === 2 ? new ScoutStop('error', 'The site answered HTTP 429. The scout stopped.') : defaultItem(i)));
  const c = await setup({ settings: ON, feed });
  await c.scout.cycle();
  const st = await readStatus(c);
  assert.equal(st.state, 'error');
  assert.match(st.message, /429/);
  assert.equal(c.notices.filter(n => n.event === 'scout').length, 1);
});

test('the feed failing to load three times in a row stops it; two failures do not', async () => {
  const three = await setup({ settings: ON, feed: fakeFeed(i => (i >= 2 ? new FeedHiccup('nothing loaded') : defaultItem(i))) });
  await three.scout.cycle();
  const st = await readStatus(three);
  assert.equal(st.state, 'error');
  assert.match(st.message, /three times/);
  assert.match(st.message, /nothing loaded/, 'the reason is part of the message');
  assert.ok(three.logs.some(l => /did not load.*nothing loaded/.test(l)), 'each failed load is logged with its reason');
  assert.match(three.notices.find(n => n.event === 'scout').message, /an hour/);

  // a feed that merely would not load is retried after an hour, not six
  three.clock.t += 59 * 60e3;
  assert.equal(await three.scout.cycle(), 'stopped', 'still stopped after 59 min');
  three.clock.t += 2 * 60e3;
  assert.equal(await three.scout.cycle(), 'session', 'tries again after an hour');

  const two = await setup({ settings: { ...ON, scoutDaily: 12 }, feed: fakeFeed(i => ((i === 3 || i === 4 || i === 9 || i === 10) ? new FeedHiccup('blip') : defaultItem(i))) });
  await two.scout.cycle();
  assert.notEqual((await readStatus(two)).state, 'error', 'a couple of blips in a row, with good loads between, are fine');
});

test('too many errors in a row stop it; a few do not', async () => {
  const bad = await setup({ settings: ON });
  let calls = 0;
  const alwaysFails = createScout({ archiveDir: bad.archive, stateDir: bad.stateDir, env: { SCOUT: 'on' }, store: bad.store, now: () => bad.clock.t, sleep: async ms => { bad.clock.t += ms; }, log: () => {}, notify: async () => {}, feed: fakeFeed(), fetchCover: async () => { calls++; throw new Error('cover server fell over'); }, scorer: { score: async () => ({ score: 1, tags: [] }) } });
  await alwaysFails.cycle();
  assert.equal(calls, LIMITS.MAX_CONSECUTIVE_ERRORS + 1);
  assert.equal((await readStatus(bad)).state, 'error');

  const ok = await setup({ settings: ON });
  let n = 0;
  const flaky = createScout({ archiveDir: ok.archive, stateDir: ok.stateDir, env: { SCOUT: 'on' }, store: ok.store, now: () => ok.clock.t, sleep: async ms => { ok.clock.t += ms; }, log: () => {}, notify: async () => {}, feed: fakeFeed(), fetchCover: async () => { n++; if (n % 3 !== 0) throw new Error('blip'); return Buffer.from('jpg'); }, scorer: { score: async () => ({ score: 1, tags: [] }) } });
  await flaky.cycle();
  assert.notEqual((await readStatus(ok)).state, 'error');
});

// ── what it skips ────────────────────────────────────────────────────────────

test('it skips videos already in Likes, Favorites or Following, already suggested, decided on, or seen before', async () => {
  const mk = async ad => {
    await writeDb(ad, 'db_likes.js', 'db_base64', { likes: { downloaded: [idOf(0)] } });
    await writeDb(ad, 'db_bookmarked.js', 'dbb_base64', { downloaded: [idOf(1)] });
    await writeDb(ad, 'db_following.js', 'dbf_base64', { authorItems: { a1: { inFolder: [idOf(2)], disappeared: [idOf(3)] } } });
    await fs.mkdir(path.join(ad, 'scout'), { recursive: true });
    await fs.writeFile(path.join(ad, 'scout', 'candidates.jsonl'), JSON.stringify({ id: idOf(4), author: 'x', desc: '', score: 0.9, tags: [], found: 1 }) + '\n');
    await fs.writeFile(path.join(ad, 'scout_feedback.json'), JSON.stringify({ decisions: { [idOf(5)]: { d: 'skipped', t: 1 } } }));
  };
  const c = await setup({ settings: { ...ON, scoutDaily: 12 }, files: { all: mk } });
  await fs.mkdir(path.join(c.stateDir, 'scout'), { recursive: true });
  await fs.writeFile(path.join(c.stateDir, 'scout', 'seen.json'), JSON.stringify([idOf(6)]));
  await c.scout.cycle();
  const looked = c.calls.score;
  for (const i of [0, 1, 2, 3, 4, 5, 6]) assert.ok(!looked.includes(idOf(i)), `video ${i} should have been skipped`);
  assert.ok(looked.includes(idOf(7)), 'a new one is scored');
});

test('each video is only looked at once', async () => {
  const feed = fakeFeed(i => defaultItem(Math.floor(i / 2)));          // every video shows up twice
  const c = await setup({ settings: { ...ON, scoutDaily: 10 }, feed });
  await c.scout.cycle();
  assert.equal(new Set(c.calls.score).size, c.calls.score.length);
});

// ── the scorer and the threshold ─────────────────────────────────────────────

test('only picks at or above scoutMin are written', async () => {
  const scores = { 0: 0.59, 1: 0.6, 2: 0.61, 3: 0.2, 4: 0.99 };
  const c = await setup({ settings: { ...ON, scoutDaily: 5, scoutMin: 60 }, score: (id, n) => scores[n] });
  await c.scout.cycle();
  const lines = await readLines(c);
  assert.deepEqual(lines.map(l => l.id), [idOf(1), idOf(2), idOf(4)]);
});

test('the cover is written before the line, one write call, ending with a newline', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 3 } });
  const order = [];
  const real = { cover: c.store.writeCover.bind(c.store), line: c.store.appendCandidate.bind(c.store) };
  c.store.writeCover = async (id, bytes) => { order.push('cover'); return real.cover(id, bytes); };
  c.store.appendCandidate = async line => {
    const id = JSON.parse(line).id;
    order.push(await exists(c.store.coverPath(id)) ? 'line-after-cover' : 'LINE-WITHOUT-COVER');
    assert.ok(!line.includes('\n'), 'one line');
    return real.line(line);
  };
  await c.scout.cycle();
  assert.deepEqual(order, ['cover', 'line-after-cover', 'cover', 'line-after-cover', 'cover', 'line-after-cover']);
  const text = await fs.readFile(path.join(c.ad, 'scout', 'candidates.jsonl'), 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual((await fs.readdir(path.join(c.ad, 'scout', 'covers'))).sort(), [idOf(0), idOf(1), idOf(2)].map(i => `${i}.jpg`));
  assert.deepEqual((await fs.readdir(path.join(c.ad, 'scout', 'covers'))).filter(f => f.includes('.tmp')), []);
});

test('a candidate line has exactly the contract fields, cleaned and clamped', async () => {
  const feed = fakeFeed(i => ({ id: idOf(i), author: 'bad name!@#$', desc: 'line one\nline two\u2028' + 'x'.repeat(400), coverUrl: 'https://cdn.invalid/c' }));
  const c = await setup({ settings: { ...ON, scoutDaily: 1 }, feed, score: 1.4, tags: [['a', 2], ['b', -1], ['c', 0.5], ['d', 0.9], 'junk', ['e']] });
  await c.scout.cycle();
  const [line] = await readLines(c);
  assert.deepEqual(Object.keys(line).sort(), ['author', 'desc', 'found', 'id', 'score', 'tags']);
  assert.match(line.id, /^\d{5,25}$/);
  assert.match(line.author, /^[A-Za-z0-9_.-]{0,64}$/);
  assert.equal(line.author, 'badname');
  assert.ok(line.desc.length <= 300 && !/[\n\u2028]/.test(line.desc));
  assert.ok(line.score >= 0 && line.score <= 1);
  assert.ok(line.tags.length <= 3 && line.tags.every(t => Array.isArray(t) && typeof t[0] === 'string' && t[1] >= 0 && t[1] <= 1));
  assert.ok(line.found >= at(12) && line.found <= c.clock.t, 'found is the time it was found, in ms');
});

test('the scorer being down stops the run with an error and never guesses a score', async () => {
  const err = () => Object.assign(new Error('503'), { retry: true });
  const c = await setup({ settings: ON, scorerError: err });
  await c.scout.cycle();
  assert.equal(c.calls.score.length, LIMITS.SCORER_TRIES, 'it retried a few times');
  assert.deepEqual(await readLines(c), [], 'nothing was suggested');
  const st = await readStatus(c);
  assert.equal(st.state, 'error');
  assert.match(st.message, /scorer/i);
  assert.ok(c.calls.sleeps.some(ms => ms >= 5000), 'it waited between tries');
});

test('a scorer that refuses one cover is not "down"', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 3 }, scorerError: () => new Error('400 bad image') });
  await c.scout.cycle();
  assert.equal(c.calls.score.length, 3, 'no retries for a refusal');
  assert.notEqual((await readStatus(c)).state, 'error');
});

// ── pace, sessions, rest ─────────────────────────────────────────────────────

test('it paces itself: 3 to 12 seconds between videos, never a regular rhythm', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 60 }, random: seeded(11) });
  await c.scout.cycle();
  const pauses = c.calls.sleeps.filter(ms => ms >= LIMITS.PAUSE_MS[0] && ms < 120000);
  assert.ok(pauses.length >= 50);
  assert.ok(pauses.every(ms => ms >= 3000), 'never faster than 3 s');
  assert.ok(new Set(pauses.map(ms => Math.round(ms / 100))).size > 20, 'varied');
  assert.ok(pauses.some(ms => ms > 12000), 'now and then a longer pause');
});

test('a session lasts about 15 to 20 minutes, then it rests 30 to 90 minutes', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 5000 }, random: seeded(5) });
  const t0 = c.clock.t;
  await c.scout.cycle();
  const lasted = (c.clock.t - t0) / 60000;
  assert.ok(lasted >= 15 && lasted <= 21, `session lasted ${lasted.toFixed(1)} min`);
  const rest = (c.scout.state().nextSessionAt - c.clock.t) / 60000;
  assert.ok(rest >= 29 && rest <= 91, `rests ${rest.toFixed(0)} min`);
  assert.equal(await c.scout.cycle(), 'resting');
  assert.equal(c.feed.opened, 1);
  c.clock.t = c.scout.state().nextSessionAt + 1;
  assert.equal(await c.scout.cycle(), 'session');
});

// ── nothing but looking ──────────────────────────────────────────────────────

test('the only things it ever calls are: the feed, a cover download and the scorer', async () => {
  const seen = new Set();
  const spy = o => new Proxy(o, { get: (t, k) => { if (typeof k === 'string') seen.add(k); return t[k]; } });
  const c = await setup({ settings: { ...ON, scoutDaily: 8 } });
  const deps = { feed: spy(c.feed), scorer: spy({ score: async () => ({ score: 1, tags: [] }) }) };
  const covers = [];
  const scout = createScout({ archiveDir: c.archive, stateDir: c.stateDir, env: { SCOUT: 'on' }, store: c.store, now: () => c.clock.t, sleep: async ms => { c.clock.t += ms; }, log: () => {}, notify: async () => {}, feed: deps.feed, fetchCover: async url => { covers.push(url); return Buffer.from('j'); }, scorer: deps.scorer });
  await scout.cycle();
  assert.deepEqual([...seen].sort(), ['open', 'score']);
  assert.ok(covers.every(u => u.startsWith('https://cdn.invalid/cover/')), 'only the cover addresses the feed gave');
});

// ── privacy in the log ───────────────────────────────────────────────────────

test('the log holds no ids, names, captions, addresses or tag names', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 6 }, env: { SCOUT: 'on', SCOUT_DRY: '1' } });
  await c.scout.cycle();
  const feed2 = fakeFeed(i => (i === 2 ? new ScoutStop('challenge', 'A verification screen appeared.') : defaultItem(i)));
  const d = await setup({ settings: ON, feed: feed2 });
  await d.scout.cycle();
  const text = [...c.logs, ...d.logs].join('\n');
  assert.ok(text.length > 0);
  assert.ok(!/700000000000\d\d/.test(text), 'no ids');
  assert.ok(!/user_\d|made-up caption|cdn\.invalid|alpha|beta|gamma|cookie|token/i.test(text), 'no names, captions, addresses, tags or secrets');
  assert.ok(c.logs.every(l => typeof l === 'string'));
});

// ── dry run ──────────────────────────────────────────────────────────────────

test('a dry run writes nothing to the archive, but still obeys the limits', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 4 }, env: { SCOUT: 'on', SCOUT_DRY: '1' } });
  assert.equal(await c.scout.cycle(), 'session');
  assert.equal(c.scout.state().today.viewed, 4, 'the daily limit still applies');
  assert.equal(c.calls.score.length, 4, 'it still scores, to say what it would do');
  assert.equal(await exists(path.join(c.ad, 'scout')), false, 'no scout folder, no status, no covers, no lines in the archive');
  assert.ok(c.logs.some(l => /would collect/.test(l)));
  assert.equal(await c.scout.cycle(), 'daily-limit');
  assert.equal(await exists(path.join(c.stateDir, 'scout', 'state.json')), true, 'its own memory is in its own folder');
});

// ── the status file ──────────────────────────────────────────────────────────

test('status.json has the contract shape, is written atomically, and tracks the day', async () => {
  const c = await setup({ settings: { ...ON, scoutDaily: 6 } });
  await c.scout.cycle();
  const st = await readStatus(c);
  assert.deepEqual(Object.keys(st).sort(), ['message', 'state', 'today', 'updated']);
  assert.deepEqual(Object.keys(st.today).sort(), ['collected', 'date', 'viewed']);
  assert.ok(['off', 'idle', 'running', 'paused', 'challenge', 'login', 'error'].includes(st.state));
  assert.equal(st.today.date, localDate(c.clock.t));
  assert.equal(st.today.viewed, 6);
  assert.ok(Number.isFinite(st.updated));
  assert.deepEqual((await fs.readdir(path.join(c.ad, 'scout'))).filter(f => f.endsWith('.tmp')), []);
});

test('the candidates file is trimmed to the newest 5000 lines with a temp file and a rename', async () => {
  const c = await setup({ settings: ON });
  await fs.mkdir(path.join(c.ad, 'scout'), { recursive: true });
  const lines = Array.from({ length: 5600 }, (_, i) => JSON.stringify({ id: String(90000000000000 + i), author: '', desc: '', score: 0.7, tags: [], found: i }));
  await fs.writeFile(path.join(c.ad, 'scout', 'candidates.jsonl'), lines.join('\n') + '\n');
  await c.store.trimCandidates();
  const kept = (await fs.readFile(path.join(c.ad, 'scout', 'candidates.jsonl'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(kept.length, 5000);
  assert.equal(JSON.parse(kept[0]).found, 600);
  assert.equal(JSON.parse(kept[4999]).found, 5599);
  assert.deepEqual((await fs.readdir(path.join(c.ad, 'scout'))).filter(f => f.endsWith('.tmp')), []);
});

test('it never touches the database files or anything outside its own folder', async () => {
  const mk = async ad => { await writeDb(ad, 'db_likes.js', 'db_base64', { likes: { downloaded: [] } }); await fs.writeFile(path.join(ad, 'stars.json'), '{"stars":{}}'); };
  const c = await setup({ settings: { ...ON, scoutDaily: 10 }, files: { all: mk } });
  const before = {};
  for (const f of await fs.readdir(c.ad)) before[f] = (await fs.stat(path.join(c.ad, f))).mtimeMs;
  await c.scout.cycle();
  const after = (await fs.readdir(c.ad)).filter(f => f !== 'scout').sort();
  assert.deepEqual(after, Object.keys(before).sort(), 'no new files beside its scout folder');
  for (const f of Object.keys(before)) assert.equal((await fs.stat(path.join(c.ad, f))).mtimeMs, before[f], `${f} was not touched`);
});

test('cleanup', async () => { await fs.rm(SCRATCH, { recursive: true, force: true }); });
