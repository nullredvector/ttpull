// ttpull container — Express API
// Receives session from extension, exposes status, triggers download jobs

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { scheduleJobs, runNow } from './scheduler.js';
import { getJobState } from './downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'session.json');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Allow extension (chrome-extension://*) and localhost origins
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── Session ───────────────────────────────────────────────────────────────────

// Load persisted session on startup
export let session = null;
try {
  const raw = await fs.readFile(SESSION_FILE, 'utf8');
  session = JSON.parse(raw);
  console.log(`[server] loaded session for @${session.ctx?.uniqueId || 'unknown'} (pushed ${new Date(session.pushedAt).toLocaleString()})`);
} catch { /* no session yet */ }

// POST /session — extension pushes cookies + page context here
app.post('/session', async (req, res) => {
  const { cookies, ctx, pushedAt } = req.body;

  if (!Array.isArray(cookies) || !cookies.length) {
    return res.status(400).json({ error: 'cookies required' });
  }
  if (!ctx?.uid && !ctx?.secUid) {
    return res.status(400).json({ error: 'ctx.uid or ctx.secUid required' });
  }

  session = { cookies, ctx, pushedAt };

  try {
    await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch (e) {
    console.error('[server] could not persist session:', e.message);
  }

  console.log(`[server] session updated for @${ctx.uniqueId || ctx.uid} at ${new Date(pushedAt).toLocaleString()}`);
  res.json({ ok: true, user: ctx.uniqueId || ctx.uid });
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  const job = getJobState();
  res.json({
    hasSession: !!session,
    sessionUser: session?.ctx?.uniqueId || null,
    sessionAge: session ? Math.round((Date.now() - session.pushedAt) / 1000 / 60) + 'm ago' : null,
    ...job,
  });
});

// ── Manual trigger (legacy — container fetches lists itself) ─────────────────

app.post('/run', async (req, res) => {
  if (!session) return res.status(400).json({ error: 'no session — push from extension first' });
  const job = getJobState();
  if (job.running) return res.status(409).json({ error: 'job already running' });

  const limit = req.body?.testMode ? 2 : 0;
  runNow(session, { limit }).catch(e => console.error('[run] error:', e));
  res.json({ message: limit ? `test mode — pulling ${limit} items` : 'job started' });
});

// ── Receive pre-fetched video metadata from extension ───────────────────────
// The extension fetches liked/bookmarked video lists from the browser context
// (where anti-bot signatures are auto-applied) and sends them here.
// The container then downloads the actual video/cover files from CDN URLs.

app.post('/videos', async (req, res) => {
  if (!session) return res.status(400).json({ error: 'no session — push from extension first' });
  const job = getJobState();
  if (job.running) return res.status(409).json({ error: 'job already running' });

  const { likes, bookmarks } = req.body;
  if (!Array.isArray(likes) && !Array.isArray(bookmarks)) {
    return res.status(400).json({ error: 'likes and/or bookmarks arrays required' });
  }

  const { downloadVideos } = await import('./downloader.js');
  downloadVideos(session, { likes: likes || [], bookmarks: bookmarks || [] })
    .catch(e => console.error('[videos] error:', e));

  res.json({
    message: `downloading ${(likes || []).length} likes + ${(bookmarks || []).length} bookmarks`,
  });
});

// ── Logs (ring buffer) ───────────────────────────────────────────────────────

const LOG_MAX = 200;
const logBuffer = [];
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;

function capture(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
}

console.log  = (...args) => { capture('info', args);  origLog(...args); };
console.error = (...args) => { capture('error', args); origErr(...args); };
console.warn  = (...args) => { capture('warn', args);  origWarn(...args); };

app.get('/logs', (req, res) => {
  res.type('text/plain').send(logBuffer.join('\n'));
});

// ── Debug session ────────────────────────────────────────────────────────────

let lastFetchResult = null;
app.post('/debug/fetch-result', (req, res) => {
  lastFetchResult = req.body;
  console.log('[debug] fetch result:', JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.get('/debug/fetch-result', (req, res) => {
  res.json(lastFetchResult || { none: true });
});

app.get('/debug/session', (req, res) => {
  if (!session) return res.json({ hasSession: false });
  res.json({
    hasSession: true,
    uid: session.ctx?.uid || null,
    secUid: session.ctx?.secUid ? `${session.ctx.secUid.slice(0, 20)}…` : null,
    cookieCount: session.cookies?.length || 0,
    cookieNames: session.cookies?.map(c => c.name) || [],
    pushedAt: session.pushedAt,
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3847;
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  scheduleJobs(() => session);
});
