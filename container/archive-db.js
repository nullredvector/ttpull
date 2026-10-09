// Registers downloaded videos in the archive viewer's database files.
//
// Each file in data/.appdata is `window.<name>_base64="<base64(gzip(JSON))>";`.
//   db_likes.js      db_base64   { schemaVersion, user, likes: { officialList, downloaded, ... } }
//   db_bookmarked.js dbb_base64  { officialList, downloaded, ... }
//   db_videos.js     dbv_base64  { [videoId]: { authorId, createTime, itemMute, diggCount, playCount, size } }
//   db_authors.js    dba_base64  { [authorId]: { uniqueIds[], nicknames[], followerCount, heartCount, videoCount } }
//   db_texts.js      dbvd_base64 { [videoId]: description }
//
// DB_UPDATE=off   never touch the database
// DB_UPDATE=dry   (default) decode, verify the round trip and log what would change
// DB_UPDATE=write back up the files, then write the changes

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

const MODE = (process.env.DB_UPDATE || 'dry').toLowerCase();
const KEEP_BACKUPS = 10;

const FILES = {
  videos:     { file: 'db_videos.js',     name: 'dbv_base64'  },
  authors:    { file: 'db_authors.js',    name: 'dba_base64'  },
  texts:      { file: 'db_texts.js',      name: 'dbvd_base64' },
  likes:      { file: 'db_likes.js',      name: 'db_base64'   },
  bookmarked: { file: 'db_bookmarked.js', name: 'dbb_base64'  },
};

const WRAPPER = /^([\s\S]*?="\s*)([A-Za-z0-9+/=\s]*)("\s*;?\s*)$/;

async function readDb(dir, key) {
  const raw = await fs.readFile(path.join(dir, FILES[key].file), 'utf8');
  const m = raw.match(WRAPPER);
  if (!m) throw new Error(`${FILES[key].file}: unrecognised wrapper`);
  const json = zlib.gunzipSync(Buffer.from(m[2].replace(/\s+/g, ''), 'base64')).toString('utf8');
  return { raw, prefix: m[1], suffix: m[3], json, data: JSON.parse(json) };
}

function encode(db, data) {
  const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8')).toString('base64');
  return db.prefix + b64 + db.suffix;
}

async function writeAtomic(file, content) {
  const st = await fs.stat(file);
  const tmp = `${file}.ttpull-tmp`;
  await fs.writeFile(tmp, content);
  await fs.chmod(tmp, st.mode & 0o7777).catch(() => {});
  await fs.chown(tmp, st.uid, st.gid).catch(() => {});
  await fs.rename(tmp, file);
}

async function backup(dir, keys) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = path.join(dir, 'backups');
  const dest = path.join(root, `ttpull-${stamp}`);
  await fs.mkdir(dest, { recursive: true });
  for (const k of keys) await fs.copyFile(path.join(dir, FILES[k].file), path.join(dest, FILES[k].file));
  const old = (await fs.readdir(root)).filter(n => n.startsWith('ttpull-')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) {
    await fs.rm(path.join(root, n), { recursive: true, force: true });
  }
  return dest;
}

const toStr = v => (v == null ? '' : String(v));
const uniq = arr => [...new Set(arr.filter(Boolean))];

// kind: 'likes' | 'bookmarked'.  videos: newest first, each already on disk.
//   { id, desc, authorId, authorName, nickname, createTime, itemMute,
//     diggCount, playCount, size, followerCount, heartCount, videoCount }
export async function registerVideos(archiveDir, kind, videos, log = console.log) {
  if (MODE === 'off' || !videos.length) return { mode: MODE, added: 0 };
  const dir = path.join(archiveDir, 'data', '.appdata');

  try {
    await fs.access(path.join(dir, FILES.videos.file));
  } catch {
    log(`[db] no database in ${dir} — skipping`);
    return { mode: MODE, added: 0, skipped: 'no database' };
  }

  const keys = ['videos', 'authors', 'texts', kind];
  const dbs = {};
  for (const k of keys) dbs[k] = await readDb(dir, k);

  // Safety: our encoder must reproduce the data it just read, or we don't touch anything.
  for (const k of keys) {
    const back = zlib.gunzipSync(Buffer.from(encode(dbs[k], dbs[k].data).match(WRAPPER)[2], 'base64')).toString('utf8');
    if (JSON.stringify(JSON.parse(back)) !== JSON.stringify(dbs[k].data)) {
      throw new Error(`${FILES[k].file}: round-trip mismatch — refusing to touch the database`);
    }
  }

  const vids = dbs.videos.data, auths = dbs.authors.data, texts = dbs.texts.data;
  const list = kind === 'likes' ? dbs.likes.data.likes : dbs.bookmarked.data;
  if (!list || typeof list !== 'object') throw new Error(`${FILES[kind].file}: list object not found`);
  list.officialList = Array.isArray(list.officialList) ? list.officialList : [];
  list.downloaded   = Array.isArray(list.downloaded)   ? list.downloaded   : [];

  const inOfficial   = new Set(list.officialList);
  const inDownloaded = new Set(list.downloaded);
  const stats = { newVideos: 0, newAuthors: 0, newInList: 0, newDownloaded: 0 };
  const frontOfList = [];

  for (const v of videos) {
    const id = toStr(v.id), aid = toStr(v.authorId);
    if (!id || !aid) continue;

    if (!vids[id]) {
      vids[id] = {
        authorId: aid,
        createTime: Number(v.createTime) || 0,
        itemMute: !!v.itemMute,
        diggCount: Number(v.diggCount) || 0,
        playCount: Number(v.playCount) || 0,
        size: Number(v.size) || 0,
      };
      stats.newVideos++;
    }
    if (texts[id] === undefined) texts[id] = toStr(v.desc);

    const a = auths[aid];
    if (!a) {
      auths[aid] = {
        uniqueIds: uniq([v.authorName]),
        nicknames: uniq([v.nickname]),
        followerCount: Number(v.followerCount) || 0,
        heartCount: Number(v.heartCount) || 0,
        videoCount: Number(v.videoCount) || 0,
      };
      stats.newAuthors++;
    } else {
      a.uniqueIds = uniq([v.authorName, ...(a.uniqueIds || [])]);
      a.nicknames = uniq([v.nickname, ...(a.nicknames || [])]);
      if (v.followerCount) a.followerCount = Number(v.followerCount);
      if (v.heartCount)    a.heartCount    = Number(v.heartCount);
      if (v.videoCount)    a.videoCount    = Number(v.videoCount);
    }

    if (!inOfficial.has(id))   { frontOfList.push(id); inOfficial.add(id); stats.newInList++; }
    if (!inDownloaded.has(id)) { list.downloaded.push(id); inDownloaded.add(id); stats.newDownloaded++; }
  }
  list.officialList = [...frontOfList, ...list.officialList];

  const changed = stats.newVideos + stats.newAuthors + stats.newInList + stats.newDownloaded;
  if (!changed) {
    log(`[db] ${kind}: already registered (${videos.length} checked)`);
    return { mode: MODE, added: 0, ...stats };
  }

  if (MODE !== 'write') {
    log(`[db] DRY RUN ${kind}: would add ${stats.newVideos} videos, ${stats.newAuthors} authors, ` +
        `${stats.newInList} to list, ${stats.newDownloaded} to downloaded (set DB_UPDATE=write to apply)`);
    return { mode: MODE, added: 0, ...stats };
  }

  const where = await backup(dir, keys);
  // Records first, list last: if anything fails midway the viewer never sees an id without data.
  for (const k of ['videos', 'authors', 'texts', kind]) {
    await writeAtomic(path.join(dir, FILES[k].file), encode(dbs[k], dbs[k].data));
  }
  log(`[db] ${kind}: added ${stats.newVideos} videos, ${stats.newAuthors} authors, ` +
      `${stats.newInList} to list, ${stats.newDownloaded} to downloaded (backup: ${path.basename(where)})`);
  return { mode: MODE, added: stats.newDownloaded, ...stats };
}

// Ids already registered as downloaded. Falls back to files on disk when the
// archive has no database. `kind`: 'likes' | 'bookmarked'.
export async function readKnownIds(archiveDir, kind) {
  const dir = path.join(archiveDir, 'data', '.appdata');
  try {
    const db = await readDb(dir, kind);
    const list = kind === 'likes' ? db.data.likes : db.data;
    return new Set((list?.downloaded || []).map(String));
  } catch { /* no database — use disk */ }
  const ids = new Set();
  const sub = kind === 'likes' ? 'Likes' : 'Favorites';
  try {
    for (const f of await fs.readdir(path.join(archiveDir, 'data', sub, 'videos'))) {
      if (f.endsWith('.mp4')) ids.add(f.slice(0, -4));
    }
  } catch { /* none yet */ }
  return ids;
}

// Read-only audit of a list of ids against the database. `kind`: 'likes' | 'bookmarked'.
// Returns what the viewer would NOT show, and why.
export async function auditIds(archiveDir, kind, ids) {
  const dir = path.join(archiveDir, 'data', '.appdata');
  const list = await readDb(dir, kind);
  const l = kind === 'likes' ? list.data.likes : list.data;
  const downloaded = new Set((l.downloaded || []).map(String));
  const official   = new Set((l.officialList || []).map(String));
  const videos  = (await readDb(dir, 'videos')).data;
  const authors = (await readDb(dir, 'authors')).data;

  const out = { notDownloaded: [], notOfficial: [], noVideoRecord: [], noAuthorRecord: [] };
  for (const raw of ids) {
    const id = String(raw);
    if (!downloaded.has(id)) out.notDownloaded.push(id);
    if (!official.has(id)) out.notOfficial.push(id);
    const v = videos[id];
    if (!v) out.noVideoRecord.push(id);
    else if (!authors[v.authorId]) out.noAuthorRecord.push(id);
  }
  return out;
}

// Replace the official list with TikTok's current one (in TikTok's order) and
// recompute what the viewer shows as "disappeared" (downloaded but no longer listed).
// Refuses if the new list is suspiciously smaller than the old one.
export async function refreshOfficialList(archiveDir, kind, ids, log = console.log) {
  if (MODE === 'off') return { applied: false, reason: 'DB_UPDATE=off' };
  const dir = path.join(archiveDir, 'data', '.appdata');
  const db = await readDb(dir, kind);
  const back = zlib.gunzipSync(Buffer.from(encode(db, db.data).match(WRAPPER)[2], 'base64')).toString('utf8');
  if (JSON.stringify(JSON.parse(back)) !== JSON.stringify(db.data)) {
    throw new Error(`${FILES[kind].file}: round-trip mismatch — refusing to touch the database`);
  }

  const list = kind === 'likes' ? db.data.likes : db.data;
  const oldList = (list.officialList || []).map(String);
  const oldSet = new Set(oldList);
  const newList = ids.map(String);
  const newSet = new Set(newList);
  const downloaded = new Set((list.downloaded || []).map(String));

  if (oldList.length >= 20 && newList.length < oldList.length * 0.5) {
    return { applied: false, reason: `new list (${newList.length}) is less than half the old one (${oldList.length})` };
  }

  const disappearedNow = [...downloaded].filter(id => !newSet.has(id)).length;
  const disappearedBefore = [...downloaded].filter(id => !oldSet.has(id)).length;
  const summary = {
    before: oldList.length,
    after: newList.length,
    removedFromList: oldList.filter(id => !newSet.has(id)).length,
    addedToList: newList.filter(id => !oldSet.has(id)).length,
    disappearedBefore,
    disappearedNow,
    newlyDisappeared: Math.max(0, disappearedNow - disappearedBefore),
  };
  const orderChanged = oldList.length === newList.length && oldList.some((id, i) => id !== newList[i]);
  summary.changed = !!(summary.removedFromList || summary.addedToList || orderChanged ||
                       list.numDisappeared !== disappearedNow);

  if (!summary.changed) { log(`[db] ${kind}: official list unchanged (${newList.length})`); return { applied: false, reason: 'unchanged', ...summary }; }
  if (MODE !== 'write') {
    log(`[db] DRY RUN ${kind}: official list ${summary.before} → ${summary.after}, disappeared ${disappearedBefore} → ${disappearedNow} (set DB_UPDATE=write to apply)`);
    return { applied: false, reason: 'dry run', ...summary };
  }

  const where = await backup(dir, [kind]);
  const now = Date.now();
  list.officialList = newList;
  list.numDisappeared = disappearedNow;
  list.total = newList.length + disappearedNow;
  list.lastRun = { ...(list.lastRun || {}), start: now, finish: now };
  await writeAtomic(path.join(dir, FILES[kind].file), encode(db, db.data));
  log(`[db] ${kind}: official list ${summary.before} → ${summary.after}, disappeared ${disappearedBefore} → ${disappearedNow} (backup: ${path.basename(where)})`);
  return { applied: true, ...summary };
}
