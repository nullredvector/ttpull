// Runs the extension's background worker against a fake `chrome` API.
// The fake throws if the worker touches anything except cookies, storage, alarms and runtime,
// which proves it never reads or changes a page. Run:  node --test extension/test/background.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = { serverUrl: 'http://box:3847', enabled: true, intervalHours: 6, testMode: false };
const alarms = new Map();
let onAlarm, onMessage;
const cookieJar = [
  { name: 'uid_tt', value: 'fake-uid', domain: '.tiktok.com', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction', expirationDate: 2e9 },
  { name: 'sessionid', value: 'fake-session', domain: '.tiktok.com', path: '/', secure: true, httpOnly: true },
];

const allowed = {
  storage: { local: {
    get: (defaults, cb) => cb({ ...defaults, ...store }),
    set: (patch, cb) => { Object.assign(store, patch); cb && cb(); },
  } },
  alarms: {
    clear: async name => alarms.delete(name),
    create: (name, info) => alarms.set(name, info),
    onAlarm: { addListener: f => { onAlarm = f; } },
  },
  cookies: { getAll: async () => cookieJar },
  runtime: {
    onMessage: { addListener: f => { onMessage = f; } },
    onInstalled: { addListener: f => f() },
    onStartup: { addListener: () => {} },
  },
};
globalThis.chrome = new Proxy(allowed, {
  get(target, prop) {
    if (prop in target) return target[prop];
    throw new Error(`extension touched chrome.${String(prop)} — it should not`);
  },
});

const calls = [];
let respond = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
globalThis.fetch = async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET', body: opts.body }); return respond(url, opts); };

await import('../background.js');
const send = msg => new Promise(resolve => { onMessage(msg, {}, resolve); });

test('pushing the session sends the cookies with their full attributes', async () => {
  calls.length = 0;
  await send({ type: 'push_now' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://box:3847/session');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.ctx.uid, 'fake-uid');
  assert.deepEqual(body.cookies.map(c => c.name), ['uid_tt', 'sessionid']);
  assert.equal(body.cookies[1].httpOnly, true);
  assert.equal(body.cookies[0].sameSite, 'no_restriction');
  assert.match(store.lastStatus, /pushed OK/);
});

test('Run Now pushes the session, then asks the container to sync', async () => {
  calls.length = 0;
  await send({ type: 'run_now', testMode: false });
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['POST http://box:3847/session', 'POST http://box:3847/sync']);
  assert.match(store.lastStatus, /sync started/);
});

test('test mode asks for a test sync', async () => {
  calls.length = 0;
  await send({ type: 'run_now', testMode: true });
  assert.equal(calls[1].url, 'http://box:3847/sync?test=1');
});

test('a sync already running is reported, not treated as an error', async () => {
  respond = url => url.includes('/sync')
    ? { ok: false, status: 409, json: async () => ({ error: 'sync already running' }) }
    : { ok: true, status: 200, json: async () => ({}) };
  await send({ type: 'run_now', testMode: false });
  assert.match(store.lastStatus, /already running/);
  respond = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
});

test('an unreachable container is reported and no sync is attempted', async () => {
  calls.length = 0;
  respond = () => { throw new Error('ECONNREFUSED'); };
  await send({ type: 'run_now', testMode: false });
  assert.match(store.lastStatus, /connection failed/);
  assert.equal(calls.filter(c => c.url.endsWith('/sync')).length, 0);
  respond = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
});

test('with no cookies it says to sign in and sends nothing', async () => {
  const saved = cookieJar.splice(0);
  calls.length = 0;
  await send({ type: 'push_now' });
  assert.equal(calls.length, 0);
  assert.match(store.lastStatus, /sign in/);
  cookieJar.push(...saved);
});

test('the timer only pushes the session (and only when enabled)', async () => {
  calls.length = 0;
  onAlarm({ name: 'ttpull-session-push' });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(calls.map(c => c.url), ['http://box:3847/session']);

  store.enabled = false;
  calls.length = 0;
  onAlarm({ name: 'ttpull-session-push' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 0);
  store.enabled = true;
});

test('the timer is scheduled from the settings', async () => {
  await send({ type: 'schedule_changed' });
  assert.deepEqual(alarms.get('ttpull-session-push'), { periodInMinutes: 360, delayInMinutes: 1 });
  store.enabled = false;
  await send({ type: 'schedule_changed' });
  assert.equal(alarms.has('ttpull-session-push'), false);
});
