<p align="center">
  <img src="assets/kashibox-icon.svg" alt="kashibox logo" width="120">
</p>

<h1 align="center">ttpull</h1>

<p align="center">The downloader that keeps your <b>kashibox</b> archive topped up, unattended.</p>

ttpull watches your liked and bookmarked videos and, every half hour, downloads anything new at the highest quality the site offers. It writes everything into a plain folder, and [kashibox](https://github.com/nullredvector/kashibox) (the player) reads that same folder.

> Everything stays on your server. ttpull talks to the site you save videos on and to nothing else, apart from the optional notification and monitoring URLs you choose to set.

## Highlights

- **Hands-off:** a real Chromium with a saved login runs inside the container and checks for new likes and bookmarks every 30 minutes by default. You change how often from kashibox's Settings page.
- **Best quality:** picks the highest-bitrate file for every video, with no size limit. Downloads are streamed to disk and only kept if they are a valid video.
- **Quick checks:** a routine run only looks at your newest videos and stops as soon as it reaches ones you already have, so most runs take seconds.
- **Safe database writes:** every change to the archive's database is backed up first, checked, and written atomically. Creating a new archive never overwrites an existing file.
- **Starts from nothing:** point it at an empty folder and it creates the archive for you.
- **Catches up and double-checks:** one command downloads your whole history, another compares the archive against the site's lists and reports anything missing.
- **Notifications on your phone:** quiet, privacy-minded push messages through [ntfy](https://ntfy.sh), only when something needs you.
- **Notices removals:** a daily refresh marks videos the site has taken down as *disappeared*, so you keep a record of what used to be there.

## How it works

```
 Your browser                          Your server
 ┌──────────────────┐   session    ┌──────────────────────────────────────────┐
 │ ttpull extension │ ───────────► │ ttpull container                          │
 │ (Push Session)   │   (cookies)  │   Chromium + saved login   every 30 min   │
 └──────────────────┘              │        │                                  │
                                   │        ▼  lists + downloads the new ones   │
                                   │   ┌──────────────────────────────┐        │
                                   │   │ archive folder (shared)      │ ◄──────┼── kashibox reads it
                                   │   │   data/.appdata/db_*.js      │        │
                                   │   │   data/Likes, data/Favorites │        │
                                   │   └──────────────────────────────┘        │
                                   └──────────────────────────────────────────┘
```

1. You sign in to the site in your normal browser and click **Push Session Now** in the extension. That copies your login cookies to the container, once. The extension does nothing else: it never reads, changes or runs anything in the pages you visit, and it never talks to the site itself. **Run Now** in its popup just pushes the session and asks the container to sync.
2. The container's browser keeps that login in its own saved profile, so it survives restarts and updates.
3. On a schedule the container asks the site for your newest likes and bookmarks (using the page's own signed requests), downloads what is new, and records it in the database files.

## Quick start

You need Docker, and an archive folder (it can be empty).

```yaml
services:
  ttpull:
    image: ghcr.io/nullredvector/ttpull:latest
    restart: unless-stopped
    ports:
      - "3847:3847"
    shm_size: 1gb                         # Chromium needs more than Docker's 64 MB default
    environment:
      - ARCHIVE_DIR=/app/archive
      - DB_UPDATE=write                   # see "Safety" below
      - TZ=America/New_York
    volumes:
      - /path/to/archive:/app/archive     # shared with kashibox
      - /path/to/state:/data              # browser login, session and retry state
    labels:
      - com.centurylinklabs.watchtower.enable=true
```

```bash
docker compose up -d
```

Then, once:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the `extension/` folder.
2. Sign in to the site in that browser, click the ttpull icon, set **Container URL** to `http://your-server:3847`, and press **Push Session Now**.
3. Check it worked with `curl http://your-server:3847/status`. `hasSession` should be `true`.
4. Try a small run: `curl -X POST "http://your-server:3847/sync?test=1"` downloads your 2 newest videos from each list.
5. Download your history: `curl -X POST "http://your-server:3847/sync?full=1"`. This can take hours for a big library. It works in chunks, so progress is saved as it goes.

After that it checks on its own (every 30 minutes unless you change it). The `/data` volume matters: without it the saved login is lost every time the container is recreated.

## The archive folder

ttpull and kashibox mount the **same folder**. ttpull creates and updates it; kashibox only needs to read it, and needs no viewer files.

```
archive/
  data/
    .appdata/
      db_videos.js      { [videoId]: { authorId, createTime, itemMute, diggCount, playCount, size } }
      db_authors.js     { [authorId]: { uniqueIds[], nicknames[], followerCount, heartCount, videoCount } }
      db_texts.js       { [videoId]: description }
      db_likes.js       { schemaVersion, user, likes: { officialList[], downloaded[], total, numDisappeared, lastRun } }
      db_bookmarked.js  { officialList[], downloaded[], total, numDisappeared, lastRun }
      backups/ttpull-<timestamp>/    copies of any file ttpull is about to change (last 10 kept)
    Likes/{covers,videos}/<id>.jpg | <id>.mp4
    Favorites/{covers,videos}/<id>.jpg | <id>.mp4
```

kashibox keeps its own files in `data/.appdata/` next to these (`stars.json`, `sessions.json`, `settings.json`, `watch.json`). ttpull never reads, writes or backs up those. ttpull also doesn't download or track the *Following* collection, so no `db_following.js` or `Following/` folder is created; kashibox treats them as optional.

Each database file is `window.<name>_base64="<base64(gzip(JSON))>";` using the variable names `dbv_base64`, `dba_base64`, `dbvd_base64`, `db_base64` (likes) and `dbb_base64` (bookmarks). The format is the one the myfaveTT viewer uses, so existing archives keep working.

- `officialList` is the site's current list, newest first. `downloaded` is what is in your archive.
- A video that is in `downloaded` but no longer in `officialList` has **disappeared** from the site.
- `lastRun` is `{ start, finish }` in milliseconds and is stamped after every successful sync.

### Starting from an empty folder

With `DB_UPDATE=write`, a folder with no database files is set up automatically on start: the five database files (empty) and the four media folders. It never overwrites an existing file, does nothing if the archive is already set up, and if only *some* database files exist it creates nothing and logs a warning so you can take a look.

### `GET /archive/status`

Lets a player show a "nothing downloaded yet" page instead of a blank one. Counts only, never ids, names or captions.

```json
{
  "initialized": true,
  "likes":     { "downloaded": 0, "official": 0 },
  "bookmarks": { "downloaded": 0, "official": 0 },
  "lastWrite": "2026-10-10T21:36:37.000Z"
}
```

Before the archive exists it returns `initialized: false`, zero counts and `lastWrite: null`.

## Safety

`DB_UPDATE` controls writes to the **database files** only. Videos and covers are downloaded either way.

| Value | What happens |
| --- | --- |
| `dry` (default) | Reads and checks everything, logs what would change, writes and creates nothing. |
| `write` | Creates a missing archive, backs up each file it is about to change, then writes it. |
| `off` | Never touches the database. |

Before changing a file, ttpull must be able to decode it and re-encode it to identical data. If it can't, it refuses and logs an error. Writes go to a temporary file and are renamed into place. Records are written before the lists that point at them, so a player never sees a video without its data. A new archive needs `DB_UPDATE=write`.

## Verify and catch up

| Command | What it does |
| --- | --- |
| `POST /sync?test=1` | Downloads only the 2 newest new videos per list. Handy for a first try. |
| `POST /sync?full=1` | Pages through your whole history in chunks of 100 and downloads whatever is missing. |
| `POST /verify` | Read-only. Compares every video the site lists with your files and database, and reports what is missing or hidden. `GET /verify` shows the result. |
| `POST /verify?refresh=1` | The same, and also replaces the database's official lists with the site's current ones (needs `DB_UPDATE=write`). |

A daily run at 04:00 does the refresh for you and only notifies you if something has changed.

## Check interval

How often ttpull looks for new videos is a setting, not a deployment option. Change it from **kashibox's Settings page** (Downloader), or directly:

```bash
curl -X POST http://your-server:3847/settings -H 'Content-Type: application/json' -d '{"syncIntervalMinutes": 45}'
```

- **Default:** 30 minutes. **Allowed:** a whole number from 10 to 1440 (once a day), or `0` to pause the routine checks.
- It takes effect straight away and is remembered across restarts and updates (it is stored in the `/data` volume).
- A value you save beats `SYNC_INTERVAL_MINUTES`, which only supplies the starting value.
- The next check always waits the full interval since the last one started, so restarting the container or changing the setting doesn't trigger a burst of checks.
- Longer is gentler on your account: each check opens a browser and makes some requests (see *Traffic* below). The daily list refresh at 04:00 and manual runs (`POST /sync`) are separate and unaffected.
- `GET /settings` and `GET /status` (under `schedule`) show the current interval and when the next check is due.

## The scout (For You picks)

An optional extra that is **off unless you switch it on**. The scout looks through the site's For You feed at a human pace, sends each video's cover to the scorer (autotagTT), and writes the best matches into the archive as *suggestions*. You open and like them yourself in kashibox (Review → For You picks).

**It only looks.** It never likes, unlikes, follows, comments, shares, saves or posts. It has no auto-like mode, and the browser refuses the site's write endpoints as a safety net. It never tries to get past a verification screen: if one appears (or a log-in prompt, an error, or any unexpected dialog) it stops, tells you, and stays stopped for at least 6 hours, or until you switch it off and on again. There are no stealth tools of any kind.

**Two switches, both needed.** `SCOUT=on` in the container's environment (a hard kill switch, off by default) *and* **Settings → For You picks** in kashibox (it writes `scoutEnabled` into `settings.json`). With `SCOUT` off, an archive is left exactly as it is.

| Setting (in kashibox's Settings) | Default | Meaning |
| --- | --- | --- |
| `scoutEnabled` | off | the scout does nothing unless this is on |
| `scoutDaily` | 100 | most videos it may look at per day (0 pauses it) |
| `scoutMin` | 60 | lowest score, in percent, worth suggesting |
| `scoutFrom`, `scoutTo` | 0, 23 | only look in these local hours (inclusive; from > to wraps past midnight) |

It reads these every minute, so changes apply within a minute. It works in sessions of about 15 to 20 minutes with 1 to 10 minutes of rest between them, pauses 3 to 12 seconds between videos, never runs at the same time as the likes sync (the sync always wins; they share one browser), and stops collecting while 200 or more picks are waiting for you.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCOUT` | `off` | `on` allows it (the hard switch) |
| `SCOUT_DRY` | | `1`: runs the whole loop and logs what it *would* do, writes nothing to the archive, and still obeys every limit |
| `SCORER_URL` | `http://autotagtt:8090` | the scorer (`POST /score?id=<id>` with the cover) |

**Try it safely first:** `SCOUT=on` with `SCOUT_DRY=1`, switch it on in kashibox's Settings, and read the `[scout]` lines in `GET /logs`.

What it writes, all under `data/.appdata/scout/` (it writes nowhere else in the archive and never touches the database files): `candidates.jsonl`, `covers/<id>.jpg` (the cover image only, never the video; written before its line) and `status.json`. Its own memory (videos already seen, today's counters, a stop) is kept in the state folder, not the archive. Logs and notifications never contain ids, names, captions, addresses or tag names. `GET /status` shows its state under `scout`. A stop sends a notification (event `scout`, or `login` for a log-in prompt).

## Notifications

Set `NTFY_URL` to a topic on [ntfy](https://ntfy.sh) (or your own server) and install the ntfy app on your phone.

```
NTFY_URL=https://ntfy.sh/pick-a-long-random-topic-name
```

On the public server, the topic name works like a password, so make it long and random. `POST /notify/test` sends a test message.

| Event | When |
| --- | --- |
| `login` | The saved login stopped working and needs a fresh push (sent once, with a "restored" notice later). |
| `failure` | Two syncs in a row failed (sent once, with a "recovered" notice later). |
| `new` | A routine run downloaded something. Counts only. |
| `catchup` | A full catch-up finished. |
| `verify` | A verify or the daily refresh found something. |
| `gaveup` | A video failed to download three times and is being skipped. |
| `scout` | The scout stopped (verification screen, error). A log-in prompt uses `login`. |
| `db` | A database update failed. |

Messages carry counts, never usernames or captions (the one exception is a skipped-video alert, which names the video by its numeric id). Pick events with `NOTIFY_EVENTS` (comma-separated). `HEALTHCHECK_URL` is pinged after each good sync, which pairs with a dead-man's-switch service to tell you if the container itself stops.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCHIVE_DIR` | `./archive` | the archive folder (set to `/app/archive` in the container) |
| `STATE_DIR` | `/data` (in the image) | browser profile, saved session, retry state |
| `DB_UPDATE` | `dry` | `dry`, `write` or `off` (see Safety) |
| `SYNC_INTERVAL_MINUTES` | `30` | the starting check interval in minutes, used only until you save one from kashibox's Settings page (`0` pauses). The old `CRON_SCHEDULE` is no longer used |
| `REFRESH_SCHEDULE` | `0 4 * * *` | daily list refresh; `off` disables it |
| `SYNC_JITTER_SECONDS` | `45` | random delay before each run |
| `MAX_PER_RUN` | `60` | most new videos per list on a routine run |
| `FULL_CHUNK` | `100` | videos per pass in a full catch-up |
| `FULL_MAX_PASSES` | `500` | safety limit on catch-up passes |
| `MAX_PAGES` | `400` | most list pages fetched in one pass |
| `NTFY_URL` / `NTFY_TOKEN` | empty | notifications (token only for a private server) |
| `NOTIFY_EVENTS` | all of them | which events send a notification |
| `SCOUT`, `SCOUT_DRY`, `SCORER_URL` | `off`, empty, autotagTT | the optional scout (see above) |
| `HEALTHCHECK_URL` | empty | dead-man's-switch ping after each good sync |
| `BLOCK_MEDIA` | on | the browser skips pictures, autoplay and sound (done with browser flags, so its cache keeps working); `0` turns it off |
| `HEADLESS` | off | `1` runs the browser headless (headed under a virtual display is the default) |
| `PORT` | `3847` | HTTP port |
| `TZ` | | your timezone |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /status` | session, run state, the last sync summary and the schedule |
| `GET /logs` | the latest log lines |
| `GET /archive/status` | counts and last write time (see above) |
| `GET /settings`, `POST /settings` | the check interval (see below) |
| `POST /sync[?test=1\|full=1]` | run a sync now |
| `POST /verify[?refresh=1]`, `GET /verify` | check the archive against the site's lists |
| `POST /session` | used by the extension to push your login |
| `POST /notify/test` | send a test notification |
| `GET /debug/screenshot`, `GET /debug/probe`, `GET /debug/files` | troubleshooting |

## Good to know

- **Login:** ttpull seeds the container's browser from the cookies your extension pushes. If the site asks the container's browser to verify itself, or the login expires, you get a `login` notification, and `GET /debug/screenshot` shows what the browser sees. Push the session again to fix it.
- **Traffic:** each routine run opens the site's home page in a browser, which is most of the traffic, then fetches your two lists (2 requests). Measured over 10 runs, a run averages about 80 requests and 1.7 MB (typically about 40 requests and 0.3 MB, but about one load in three is heavier, up to roughly 200 requests and 6 MB). At every 30 minutes that is about 4,000 requests and 80 MB a day, plus the daily refresh (about 270 requests) and the downloads themselves. Those figures were measured logged out, so a real run may be somewhat higher. Every run logs its exact numbers (`[sync] network: …`) and `GET /status` shows the latest under `sync.network`. It is still automation on your own account, so use it at your own discretion, and set a longer check interval on kashibox's Settings page if you want it lighter.
- **Disappeared** means "downloaded but no longer on your list". That includes videos you unliked yourself, not only ones a creator deleted.
- **Updates:** with the Watchtower label, new images are picked up automatically. A restart during a run is safe: finished downloads are kept and registered on the next run.

## Development

```bash
cd container
npm install
npm test        # synthetic data only: invented ids, generated bytes, a local fake server
```

The tests cover creating an archive from nothing, never overwriting files, backups, status counts, and a full download into a fresh archive. They also check that the database code never logs ids, names or captions.

The extension has no build step: load `extension/` unpacked and reload it after changes. `node --test extension/test/background.test.js` runs its logic against a fake browser API that fails if the extension ever touches a page. The container image is rebuilt on every push to `main` and published as `ghcr.io/nullredvector/ttpull:latest`.

## Credits

The archive format and the approach to fetching your lists follow [myfaveTT](https://github.com/taoqili/myfaveTT) by taoqili. ttpull contains none of its code; it reads and writes the same database files so the two can share an archive.
