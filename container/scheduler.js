// ttpull scheduler — runs the download job on a cron schedule

import cron from 'node-cron';
import { runJob } from './downloader.js';

const SCHEDULE = process.env.CRON_SCHEDULE || '0 3 * * *'; // default: 3am daily

export function scheduleJobs(getSession) {
  if (!cron.validate(SCHEDULE)) {
    console.error(`[scheduler] invalid CRON_SCHEDULE: "${SCHEDULE}"`);
    return;
  }

  cron.schedule(SCHEDULE, async () => {
    const session = getSession();
    if (!session) {
      console.log('[scheduler] skipping — no session available (push from extension first)');
      return;
    }
    console.log(`[scheduler] running scheduled download job at ${new Date().toISOString()}`);
    await runJob(session);
  });

  console.log(`[scheduler] download job scheduled: "${SCHEDULE}"`);
}

export async function runNow(session) {
  console.log(`[scheduler] manual run triggered at ${new Date().toISOString()}`);
  await runJob(session);
}
