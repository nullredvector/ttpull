// ttpull content script — runs on tiktok.com
// Reads page context and exposes it as window.__TTPULL_CTX__ for the background
// worker to collect via scripting.executeScript.

(function () {
  'use strict';

  function extractCtx() {
    // TikTok stores app state in window.__NEXT_DATA__ (Next.js) or SIGI_STATE
    let uid = '', secUid = '', uniqueId = '', region = 'US', deviceId = '';

    try {
      const nd = window.__NEXT_DATA__;
      if (nd) {
        const props = nd.props?.pageProps;
        const userInfo = props?.userInfo?.user
                      || props?.itemInfo?.itemStruct?.author
                      || null;
        if (userInfo) {
          uid      = userInfo.id       || '';
          secUid   = userInfo.secUid   || '';
          uniqueId = userInfo.uniqueId || '';
        }
        region   = nd.props?.pageProps?.abTestVersion?.parameters?.regionCode
                || nd.query?.region
                || 'US';
      }
    } catch { /* ignore */ }

    try {
      const sigi = window.SIGI_STATE;
      if (sigi) {
        const uInfo = sigi.UserModule?.users;
        if (uInfo) {
          const first = Object.values(uInfo)[0];
          if (first) {
            uid      = uid      || first.id       || '';
            secUid   = secUid   || first.secUid   || '';
            uniqueId = uniqueId || first.uniqueId || '';
          }
        }
        region = region || sigi.AppContext?.region || 'US';
      }
    } catch { /* ignore */ }

    // device_id — TikTok stores it in localStorage as several possible keys
    try {
      deviceId = localStorage.getItem('tt_device_id')
              || localStorage.getItem('device_id')
              || '';
    } catch { /* ignore */ }

    // verifyFp is derived from s_v_web_id cookie — container will do that
    // screen / browser params (container uses these in API requests)
    const browserInfo = {
      language: navigator.language || 'en',
      platform: /Win/.test(navigator.platform) ? 'Win32'
               : /Mac/.test(navigator.platform) ? 'MacIntel'
               : 'Linux x86_64',
      screenWidth:  screen.width,
      screenHeight: screen.height,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    return { uid, secUid, uniqueId, region, deviceId, browserInfo };
  }

  // Expose immediately and refresh on navigation (SPA)
  function publish() {
    window.__TTPULL_CTX__ = extractCtx();
  }

  publish();

  // Re-publish after soft navigations (TikTok is a SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(publish, 1500); // allow Next.js data to settle
    }
  }).observe(document, { subtree: true, childList: true });
})();
