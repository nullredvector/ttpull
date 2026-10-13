// Tests for the check-interval setting. Synthetic only. Run with:  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'ttpull-settings-'));
process.env.STATE_DIR = SCRATCH;
delete process.env.SYNC_INTERVAL_MINUTES;

const S = await import('../settings.js');

test('defaults to 30 minutes when nothing is set', () => {
  assert.deepEqual(S.syncInterval(), { minutes: 30, source: 'default' });
  assert.equal(S.SYNC_DEFAULT, 30);
});

test('validation accepts 0 (paused) and 10 to 1440 whole minutes', () => {
  for (const ok of [0, 10, 30, 45, 1440, '30', ' 60 ', '0']) {
    assert.equal(S.validateInterval(ok).ok, true, `should accept ${JSON.stringify(ok)}`);
  }
  assert.equal(S.validateInterval('45').value, 45);
  assert.equal(S.validateInterval(0).value, 0);
});

test('validation rejects everything else', () => {
  for (const bad of [1, 5, 9, 1441, 99999, -10, 12.5, NaN, Infinity, '', null, undefined, true, 'abc', '12.5', '-5', [30], { a: 1 }]) {
    const r = S.validateInterval(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.error);
  }
});

test('the environment variable is used when nothing is saved, and ignored if invalid', () => {
  process.env.SYNC_INTERVAL_MINUTES = '20';
  assert.deepEqual(S.syncInterval(), { minutes: 20, source: 'env' });
  process.env.SYNC_INTERVAL_MINUTES = '3';
  assert.deepEqual(S.syncInterval(), { minutes: 30, source: 'default' });
  process.env.SYNC_INTERVAL_MINUTES = 'soon';
  assert.deepEqual(S.syncInterval(), { minutes: 30, source: 'default' });
  process.env.SYNC_INTERVAL_MINUTES = '0';
  assert.deepEqual(S.syncInterval(), { minutes: 0, source: 'env' });
  process.env.SYNC_INTERVAL_MINUTES = '20';
});

test('a saved value beats the environment variable and is written to disk', async () => {
  assert.equal(await S.setSyncInterval(15), 15);
  assert.deepEqual(S.syncInterval(), { minutes: 15, source: 'saved' });
  const onDisk = JSON.parse(await fs.readFile(path.join(SCRATCH, 'settings.json'), 'utf8'));
  assert.equal(onDisk.syncIntervalMinutes, 15);
  assert.deepEqual((await fs.readdir(SCRATCH)).filter(f => f.endsWith('.tmp')), [], 'no temp file left behind');
});

test('saving an invalid value throws and changes nothing', async () => {
  await assert.rejects(() => S.setSyncInterval(5), /between 10 and 1440/);
  await assert.rejects(() => S.setSyncInterval('lots'), /whole number/);
  assert.deepEqual(S.syncInterval(), { minutes: 15, source: 'saved' });
  assert.equal(JSON.parse(await fs.readFile(path.join(SCRATCH, 'settings.json'), 'utf8')).syncIntervalMinutes, 15);
});

test('0 saves as paused', async () => {
  await S.setSyncInterval(0);
  assert.deepEqual(S.syncInterval(), { minutes: 0, source: 'saved' });
  const d = S.describeSettings('2026-01-01T00:00:00.000Z');
  assert.equal(d.paused, true);
  assert.equal(d.nextRunAt, null, 'no next run while paused');
  await S.setSyncInterval(30);
});

test('describeSettings reports the limits and the next run', () => {
  const d = S.describeSettings('2026-01-01T00:30:00.000Z');
  assert.deepEqual(Object.keys(d).sort(), ['default', 'max', 'min', 'nextRunAt', 'paused', 'source', 'syncIntervalMinutes']);
  assert.equal(d.syncIntervalMinutes, 30);
  assert.equal(d.min, 10); assert.equal(d.max, 1440); assert.equal(d.default, 30);
  assert.equal(d.nextRunAt, '2026-01-01T00:30:00.000Z');
});

test('the next-run delay: full interval after the last start, never under the minimum', () => {
  const now = 1_000_000_000_000, min = 30_000;
  // last run started 10 minutes ago, every 30 → wait the remaining 20 minutes
  assert.equal(S.nextDelayMs({ minutes: 30, lastStart: now - 10 * 60_000, now, minDelayMs: min }), 20 * 60_000);
  // overdue (last run 2 hours ago) → the minimum, not instantly
  assert.equal(S.nextDelayMs({ minutes: 30, lastStart: now - 120 * 60_000, now, minDelayMs: min }), min);
  // never ran → the minimum
  assert.equal(S.nextDelayMs({ minutes: 30, lastStart: 0, now, minDelayMs: min }), min);
  // lowering the interval makes a run due sooner
  assert.equal(S.nextDelayMs({ minutes: 10, lastStart: now - 9 * 60_000, now, minDelayMs: min }), 60_000);
  // a run just started → the whole interval
  assert.equal(S.nextDelayMs({ minutes: 45, lastStart: now, now, minDelayMs: min }), 45 * 60_000);
});

test('cleanup', async () => { await fs.rm(SCRATCH, { recursive: true, force: true }); });
