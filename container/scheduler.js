// ttpull scheduler — runs the browser sync every N minutes (a user setting) and the daily list refresh

import cron from 'node-cron';
import { getFlag, setFlag } from './state.js';
import { syncInterval, nextDelayMs } from './settings.js';
import { runJob } from './downloader.js';
import { runBrowserSync, runVerify } from './browser-sync.js';

const JITTER_S = Number(process.env.SYNC_JITTER_SECONDS ?? 45);
const MIN_DELAY_MS = 30_000;   // first run after a start or a settings change waits at least this long

let timer = null, nextRunAt = null, ticking = false, sessionGetter = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const getNextRunAt = () => nextRunAt;

// (Re)start the routine-sync timer from the current setting. Safe to call at any time.
export function rescheduleSync() {
  if (ticking) return;                       // the running tick reschedules itself when it finishes
  clearTimeout(timer); timer = null; nextRunAt = null;
  const { minutes } = syncInterval();
  if (!minutes) { console.log('[scheduler] routine syncs are paused'); return; }
  const delay = nextDelayMs({ minutes, lastStart: getFlag('lastSyncStart') || 0, now: Date.now(), minDelayMs: MIN_DELAY_MS });
  nextRunAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(tick, delay);
  console.log(`[scheduler] checking every ${minutes} min — next check in ${(delay / 60000).toFixed(1)} min`);
}

async function tick() {
  timer = null; nextRunAt = null; ticking = true;
  try {
    // Small random delay so requests don't land on an exact clock pattern.
    if (JITTER_S > 0) await sleep(Math.random() * JITTER_S * 1000);
    await setFlag('lastSyncStart', Date.now());
    console.log(`[scheduler] sync starting at ${new Date().toISOString()}`);
    await runBrowserSync(sessionGetter);
  } catch (e) {
    console.error('[scheduler] sync error:', e.message);
  } finally {
    ticking = false;
    rescheduleSync();
  }
}

export function scheduleJobs(getSession) {
  sessionGetter = getSession;
  if (process.env.CRON_SCHEDULE) {
    console.warn("[scheduler] CRON_SCHEDULE is no longer used. Set the check interval on kashibox's Settings page, with POST /settings, or with SYNC_INTERVAL_MINUTES.");
  }
  rescheduleSync();

  // Daily: refresh the viewer's official lists so videos the site removed show as "disappeared".
  const REFRESH = process.env.REFRESH_SCHEDULE ?? '0 4 * * *';
  if (REFRESH && REFRESH !== 'off' && cron.validate(REFRESH)) {
    cron.schedule(REFRESH, async () => {
      await new Promise(r => setTimeout(r, Math.random() * JITTER_S * 1000));
      console.log('[scheduler] daily list refresh starting');
      await runVerify(getSession, { refresh: true, scheduled: true });
    });
    console.log(`[scheduler] list refresh scheduled: "${REFRESH}"`);
  }
}

// Legacy: container-side list fetching (kept for the old /run endpoint).
export async function runNow(session, opts = {}) {
  console.log(`[scheduler] manual run triggered at ${new Date().toISOString()}${opts.limit ? ` (test mode, limit=${opts.limit})` : ''}`);
  await runJob(session, opts);
}
