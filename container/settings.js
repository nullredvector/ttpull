// User-changeable settings, saved in STATE_DIR so they survive restarts and updates.
//
// Check interval (minutes between routine syncs):
//   a value saved through POST /settings  >  the SYNC_INTERVAL_MINUTES environment variable  >  30
//   0 means paused. Anything else must be a whole number from SYNC_MIN to SYNC_MAX.

import fs from 'fs/promises';
import path from 'path';
import { STATE_DIR } from './state.js';

export const SYNC_MIN = 10;      // below this the traffic is not worth it
export const SYNC_MAX = 1440;    // once a day
export const SYNC_DEFAULT = 30;

const FILE = path.join(STATE_DIR, 'settings.json');

let saved = {};
try { saved = JSON.parse(await fs.readFile(FILE, 'utf8')) || {}; } catch { /* nothing saved yet */ }

// → { ok: true, value } or { ok: false, error }
export function validateInterval(input) {
  if (input === '' || input === null || input === undefined || typeof input === 'boolean') {
    return { ok: false, error: 'syncIntervalMinutes is required' };
  }
  const n = typeof input === 'string' && /^\s*\d+\s*$/.test(input) ? Number(input) : input;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    return { ok: false, error: 'syncIntervalMinutes must be a whole number of minutes' };
  }
  if (n === 0) return { ok: true, value: 0 };
  if (n < SYNC_MIN || n > SYNC_MAX) {
    return { ok: false, error: `syncIntervalMinutes must be 0 (paused) or between ${SYNC_MIN} and ${SYNC_MAX}` };
  }
  return { ok: true, value: n };
}

// → { minutes, source: 'saved' | 'env' | 'default' }
export function syncInterval() {
  const s = validateInterval(saved.syncIntervalMinutes);
  if (s.ok) return { minutes: s.value, source: 'saved' };
  const e = validateInterval(process.env.SYNC_INTERVAL_MINUTES);
  if (e.ok) return { minutes: e.value, source: 'env' };
  return { minutes: SYNC_DEFAULT, source: 'default' };
}

export async function setSyncInterval(input) {
  const v = validateInterval(input);
  if (!v.ok) throw new Error(v.error);
  saved = { ...saved, syncIntervalMinutes: v.value };
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(saved, null, 2));
  await fs.rename(tmp, FILE);
  return v.value;
}

// How long to wait before the next routine sync: the full interval since the last one started,
// but never less than minDelayMs (so a restart or a change doesn't fire instantly).
export function nextDelayMs({ minutes, lastStart, now, minDelayMs }) {
  const due = (lastStart || 0) + minutes * 60_000;
  return Math.max(minDelayMs, due - now);
}

export function describeSettings(nextRunAt = null) {
  const { minutes, source } = syncInterval();
  return {
    syncIntervalMinutes: minutes,
    paused: minutes === 0,
    source,
    min: SYNC_MIN,
    max: SYNC_MAX,
    default: SYNC_DEFAULT,
    nextRunAt: minutes === 0 ? null : nextRunAt,
  };
}
