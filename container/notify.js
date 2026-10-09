// Push notifications via ntfy (https://ntfy.sh — iPhone app available).
// Works with ntfy.sh or a self-hosted server. Off unless NTFY_URL is set.
//
//   NTFY_URL       e.g. https://ntfy.sh/ttpull-<long-random-string>
//   NTFY_TOKEN     optional access token (self-hosted with auth)
//   NOTIFY_EVENTS  comma list: login,failure,new,catchup,verify,gaveup,db
//   HEALTHCHECK_URL optional dead-man's-switch URL, pinged after each good sync

const NTFY_URL  = process.env.NTFY_URL || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const EVENTS = new Set((process.env.NOTIFY_EVENTS || 'login,failure,new,catchup,verify,gaveup,db')
  .split(',').map(s => s.trim()).filter(Boolean));

const recent = new Map();

export const notificationsEnabled = () => !!NTFY_URL;

// event: one of the names above ('test' always sends).
export async function notify(event, title, message, { priority = 3, tags = [], dedupeKey, dedupeMs = 0 } = {}) {
  if (!NTFY_URL || (event !== 'test' && !EVENTS.has(event))) return false;
  if (dedupeKey) {
    const last = recent.get(dedupeKey) || 0;
    if (Date.now() - last < dedupeMs) return false;
    recent.set(dedupeKey, Date.now());
  }
  try {
    const u = new URL(NTFY_URL);
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!topic) throw new Error('NTFY_URL needs a topic, e.g. https://ntfy.sh/my-topic');
    const res = await fetch(u.origin + '/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
      },
      body: JSON.stringify({ topic, title, message, priority, tags }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error(`[notify] could not send "${title}": ${e.message}`);
    return false;
  }
}

export async function heartbeat() {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) return;
  try { await fetch(url, { signal: AbortSignal.timeout(10000) }); }
  catch (e) { console.error(`[notify] heartbeat failed: ${e.message}`); }
}
