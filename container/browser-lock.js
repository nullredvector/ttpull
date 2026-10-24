// One browser at a time. The saved login lives in a single browser profile, and two Chromium
// processes cannot use the same profile at once, so the sync, verify, probe and scout take turns.
//
// The scout is a background user: it never makes anyone wait. Everyone else asks the holder to wrap
// up (shouldYield() turns true, and the scout checks it between videos) and waits briefly for it.

const sleep = ms => new Promise(r => setTimeout(r, ms));

let holder = null;
let yieldRequested = false;

export const lockHolder = () => holder;
export const shouldYield = () => yieldRequested;

export async function acquireBrowser(name, { waitMs = 0, pollMs = 500 } = {}) {
  const started = Date.now();
  while (holder) {
    if (name !== 'scout') yieldRequested = true;
    if (Date.now() - started >= waitMs) return false;
    await sleep(pollMs);
  }
  holder = name;
  yieldRequested = false;
  return true;
}

export function releaseBrowser(name) {
  if (holder === name) { holder = null; yieldRequested = false; }
}
