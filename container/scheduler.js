// ttpull scheduler — runs the browser sync on a cron schedule

import cron from 'node-cron';
import { runJob } from './downloader.js';
import { runBrowserSync, runVerify } from './browser-sync.js';

const SCHEDULE = process.env.CRON_SCHEDULE || '*/10 * * * *'; // default: every 10 minutes
const JITTER_S = Number(process.env.SYNC_JITTER_SECONDS ?? 45);

export function scheduleJobs(getSession) {
  if (!cron.validate(SCHEDULE)) {
    console.error(`[scheduler] invalid CRON_SCHEDULE: "${SCHEDULE}"`);
    return;
  }

  cron.schedule(SCHEDULE, async () => {
    // Small random delay so requests don't land on an exact clock pattern.
    if (JITTER_S > 0) await new Promise(r => setTimeout(r, Math.random() * JITTER_S * 1000));
    console.log(`[scheduler] sync starting at ${new Date().toISOString()}`);
    await runBrowserSync(getSession);
  });

  console.log(`[scheduler] browser sync scheduled: "${SCHEDULE}"`);

  // Daily: refresh the viewer's official lists so videos TikTok removed show as "disappeared".
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
