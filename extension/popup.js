// ttpull popup script

const $ = id => document.getElementById(id);

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get({
      serverUrl: 'http://localhost:3847',
      intervalHours: 24,
      enabled: false,
      testMode: false,
      lastPush: null,
      lastStatus: null,
    }, resolve);
  });
}

async function saveSettings(patch) {
  return new Promise(resolve => chrome.storage.local.set(patch, resolve));
}

// ── Ping container ────────────────────────────────────────────────────────────

async function pingServer(url) {
  try {
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const s = await getSettings();

  $('server-url').value  = s.serverUrl;
  $('interval').value    = s.intervalHours;
  $('enabled').checked   = s.enabled;
  $('test-mode').checked = s.testMode;

  setStatus(s.lastStatus || '—');
  $('last-push').textContent = s.lastPush ? `Last push: ${s.lastPush}` : '';

  const online = await pingServer(s.serverUrl);
  $('dot').className = 'dot ' + (online ? 'online' : 'offline');
}

// ── Status display ────────────────────────────────────────────────────────────

function setStatus(msg) {
  const el = $('status');
  el.textContent = msg || '—';
  el.className = 'status-block'
    + (/error|fail|not found|could not|connection/i.test(msg) ? ' err' : '')
    + (/ok|success|pushed/i.test(msg) ? ' ok' : '');
}

// ── Save on change ────────────────────────────────────────────────────────────

$('server-url').addEventListener('change', async () => {
  const url = $('server-url').value.trim().replace(/\/$/, '');
  await saveSettings({ serverUrl: url });
  const online = await pingServer(url);
  $('dot').className = 'dot ' + (online ? 'online' : 'offline');
});

$('interval').addEventListener('change', async () => {
  await saveSettings({ intervalHours: Number($('interval').value) });
  chrome.runtime.sendMessage({ type: 'schedule_changed' });
});

$('enabled').addEventListener('change', async () => {
  await saveSettings({ enabled: $('enabled').checked });
  chrome.runtime.sendMessage({ type: 'schedule_changed' });
});

$('test-mode').addEventListener('change', async () => {
  await saveSettings({ testMode: $('test-mode').checked });
});

// ── Push now ──────────────────────────────────────────────────────────────────

$('push-btn').addEventListener('click', async () => {
  $('push-btn').disabled = true;
  $('push-btn').textContent = 'Pushing…';
  setStatus('collecting session…');

  chrome.runtime.sendMessage({ type: 'push_now' }, async () => {
    const s = await getSettings();
    setStatus(s.lastStatus);
    $('last-push').textContent = s.lastPush ? `Last push: ${s.lastPush}` : '';
    $('push-btn').disabled = false;
    $('push-btn').textContent = 'Push Session Now';
  });
});

// ── Job status / run now ──────────────────────────────────────────────────────

$('job-status-btn').addEventListener('click', async () => {
  const s = await getSettings();
  try {
    const res  = await fetch(`${s.serverUrl}/status`);
    const data = await res.json();
    setStatus(JSON.stringify(data, null, 2));
  } catch (e) {
    setStatus(`connection failed: ${e.message}`);
  }
});

$('run-now-btn').addEventListener('click', async () => {
  const s = await getSettings();
  try {
    setStatus('triggering download job…');
    const res  = await fetch(`${s.serverUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testMode: s.testMode }),
    });
    const data = await res.json();
    setStatus(data.message || 'job started');
  } catch (e) {
    setStatus(`connection failed: ${e.message}`);
  }
});

// ── Poll status while open ────────────────────────────────────────────────────

async function pollStatus() {
  const s = await getSettings();
  if (!s.serverUrl) return;
  try {
    const res  = await fetch(`${s.serverUrl}/status`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    if (data.running) setStatus(`running: ${data.phase || '…'} (${data.progress || ''})`);
  } catch { /* offline, ignore */ }
}

setInterval(pollStatus, 3000);

init();
