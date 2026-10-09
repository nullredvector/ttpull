// Runs INSIDE the browser page (via page.evaluate), so it must be fully
// self-contained — no imports, no references to outer scope.
//
// Calls the page's own signing window.fetch with the same parameter set the
// site uses, then pages with cursor/hasMore. Returns only videos whose ids are
// not in `known`, and (when stopOnKnown) stops at the first page that has
// nothing new.
//
// args: { type: 'likes'|'bookmarks', limit, known: string[], stopOnKnown, maxPages }

export async function listInPage({ type, limit, known, stopOnKnown, maxPages }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const knownSet = new Set(known);
  const diag = { pages: [] };

  // ── App context (device id, region, user) ───────────────────────────────
  const readCtx = async () => {
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      const c = el && JSON.parse(el.textContent)?.__DEFAULT_SCOPE__?.['webapp.app-context'];
      if (c?.wid || c?.$wid) return c;
    } catch {}
    try {
      const r = await fetch('/node-webapp/api/app-context');
      const c = await r.json();
      if (c?.$wid || c?.wid) return c;
    } catch {}
    return null;
  };
  const c = await readCtx();
  if (!c) return { error: 'no app context', diag, videos: [] };

  const ctx = {
    wid:    c.$wid || c.wid,
    region: c.$region || c.region,
    os:     c.$os || c.os,
    lang:   c.$language || c.language,
    user:   c.$user || c.user || {},
    mApi:   (c.$domains || c.domains || {}).mTApi,
  };
  if (!ctx.user.secUid) return { loggedOut: true, error: 'not logged in', diag, videos: [] };

  // ── Build the same parameter set the site uses ──────────────────────────
  const base = (ctx.mApi && ctx.mApi.startsWith('https://')) ? ctx.mApi : 'https://m.tiktok.com';
  const common = () => ({
    aid: '1988', app_name: 'tiktok_web', channel: 'tiktok_web', device_platform: 'web_pc',
    referer: document.referrer, cookie_enabled: navigator.cookieEnabled,
    screen_width: screen.width, screen_height: screen.height,
    browser_language: navigator.language, browser_platform: navigator.platform,
    browser_name: navigator.appCodeName, browser_version: navigator.appVersion,
    browser_online: navigator.onLine,
    verifyFp: (document.cookie.match(/s_v_web_id=(\w+)/) || [])[1],
    is_page_visible: true, focus_state: true,
    is_fullscreen: window.matchMedia('(display-mode: fullscreen)').matches,
    history_len: window.history.length, battery_info: 1,
    tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
    device_id: ctx.wid, region: ctx.region,
    priority_region: ctx.user.region, os: ctx.os,
    app_language: ctx.lang, webcast_language: ctx.lang,
    from_page: 'user', secUid: ctx.user.secUid, language: ctx.lang,
  });
  const buildUrl = (path, extra) => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries({ ...common(), ...extra })) {
      u.searchParams.set(k, v == null ? '' : String(v));
    }
    return u.toString();
  };

  const variants = type === 'likes'
    ? [{ name: 'favorite', path: '/api/favorite/item_list/', extra: {} }]
    : [
        { name: 'collect', path: '/api/user/collect/item_list/', extra: { sourceType: 113 } },
        { name: 'collect-plain', path: '/api/user/collect/item_list/', extra: {} },
      ];

  const pageFetch = async (v, cursor) => {
    const r = await window.fetch(buildUrl(v.path, { ...v.extra, cursor, count: 30 }), { credentials: 'include', cache: 'no-store' });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { http: r.status, j, len: text.length };
  };

  const fresh = [];
  let usedVariant = null;
  for (const v of variants) {
    let cursor = '0', hasMore = true, bad = 0, sawItems = false;
    const seenCursors = new Set();
    let pages = 0;
    while (hasMore && pages < maxPages && (limit === 0 || fresh.length < limit)) {
      await sleep(pages === 0 ? 300 : 1200);
      let res;
      try { res = await pageFetch(v, cursor); } catch (e) { diag.pages.push({ v: v.name, err: String(e) }); break; }
      const j = res.j;
      const status = j?.statusCode ?? j?.status_code ?? null;
      const list = j?.itemList || j?.item_list || [];
      diag.pages.push({ v: v.name, cursor, http: res.http, status, msg: j?.status_msg || j?.message || null, n: list.length, hasMore: j?.hasMore ?? null });
      if (!j || (status ?? 0) !== 0) {
        if (++bad > 2) break;
        continue;
      }
      bad = 0;
      pages++;
      if (list.length) sawItems = true;

      const newOnes = list.filter(i => i?.id && !knownSet.has(String(i.id)));
      fresh.push(...newOnes);

      if (stopOnKnown && newOnes.length === 0) break;

      hasMore = !!j.hasMore;
      const next = String(j.cursor ?? '');
      if (!next || next === '0' || next === '-1' || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    diag.pagesFetched = (diag.pagesFetched || 0) + pages;
    if (sawItems) { usedVariant = v.name; break; }
  }
  diag.usedVariant = usedVariant;

  // ── Parse (best quality available) ──────────────────────────────────────
  const videos = [];
  const seenIds = new Set();
  for (const item of fresh) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const vid = item.video || {};
    let videoUrl = '';
    if (vid.bitrateInfo?.length > 0) {
      const best = vid.bitrateInfo.reduce((a, b) =>
        (b.Bitrate || b.bitrate || 0) > (a.Bitrate || a.bitrate || 0) ? b : a
      );
      videoUrl = best.PlayAddr?.UrlList?.[0]
              || best.playAddr?.urlList?.[0]
              || best.PlayAddr || '';
    }
    if (!videoUrl) videoUrl = vid.downloadAddr || '';
    if (!videoUrl) videoUrl = vid.playAddr || '';
    videos.push({
      id:         item.id,
      desc:       item.desc || '',
      authorId:   item.author?.id || '',
      authorName: item.author?.uniqueId || '',
      nickname:   item.author?.nickname || '',
      coverUrl:   vid.originCover || vid.cover || '',
      videoUrl,
      duration:   vid.duration || 0,
      createTime: item.createTime || 0,
      itemMute:   !!item.itemMute,
      diggCount:  item.stats?.diggCount || 0,
      playCount:  item.stats?.playCount || 0,
      followerCount: item.authorStats?.followerCount || 0,
      heartCount:    item.authorStats?.heartCount || 0,
      videoCount:    item.authorStats?.videoCount || 0,
    });
    if (limit > 0 && videos.length >= limit) break;
  }

  return { videos, uniqueId: ctx.user.uniqueId || '', secUid: ctx.user.secUid, diag };
}
