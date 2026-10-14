// Watches network traffic and records media URLs per tab.

const HLS_RE = /\.m3u8?(\?|#|$)/i;
const DASH_RE = /\.mpd(\?|#|$)/i;
const SEGMENT_RE = /\.(ts|m4s|m4v\d|vtt|webvtt|key)(\?|#|$)/i;
const FILE_RE = /\.(mp4|webm|mkv|mov|m4v|flv|ogv|mp3|m4a|ogg|wav)(\?|#|$)/i;
const SELF = `chrome-extension://${chrome.runtime.id}`;
const MAX_ITEMS = 300;
const BADGE_MIN_FILE_SIZE = 2 * 1024 * 1024;

const tabs = new Map(); // tabId -> items[]
let loaded = null;

function load() {
  loaded ??= chrome.storage.session.get(null).then((all) => {
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('tab:')) tabs.set(Number(k.slice(4)), v);
    }
  });
  return loaded;
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
}

function classify(url, contentType) {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (HLS_RE.test(url) || ct.includes('mpegurl')) return 'hls';
  if (DASH_RE.test(url) || ct === 'application/dash+xml') return 'dash';
  if (ct === 'video/mp2t' || ct === 'video/iso.segment' || SEGMENT_RE.test(url)) return null;
  if (FILE_RE.test(url) || ct.startsWith('video/') || ct.startsWith('audio/')) return 'file';
  return null;
}

function totalSize(headers) {
  const range = header(headers, 'content-range').match(/\/(\d+)$/);
  if (range) return Number(range[1]);
  return Number(header(headers, 'content-length')) || 0;
}

function persist(tabId) {
  const items = tabs.get(tabId) || [];
  chrome.storage.session.set({ [`tab:${tabId}`]: items });
  const count = items.filter((i) => i.kind !== 'file' || i.size >= BADGE_MIN_FILE_SIZE).length;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

async function record(d) {
  if (d.tabId < 0 || d.statusCode >= 400 || d.initiator?.startsWith(SELF)) return;
  const contentType = header(d.responseHeaders, 'content-type');
  const kind = classify(d.url, contentType);
  if (!kind) return;

  await load();
  let frameUrl = '';
  try {
    frameUrl = (await chrome.webNavigation.getFrame({ tabId: d.tabId, frameId: d.frameId }))?.url || '';
  } catch {}

  const items = tabs.get(d.tabId) || [];
  if (items.some((i) => i.url === d.url)) return;
  items.push({
    url: d.url,
    kind,
    contentType,
    size: totalSize(d.responseHeaders),
    frameUrl,
    initiator: d.initiator || '',
    time: Date.now(),
  });
  if (items.length > MAX_ITEMS) items.shift();
  tabs.set(d.tabId, items);
  persist(d.tabId);
}

async function reset(tabId) {
  await load();
  tabs.delete(tabId);
  chrome.storage.session.remove(`tab:${tabId}`);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => { record(d); },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0) reset(d.tabId); },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.tabs.onRemoved.addListener((tabId) => { reset(tabId); });

// --- Referer spoofing -------------------------------------------------------
// Extension pages send no Referer and an extension Origin; many CDNs reject that.
// Requests from the popup and the offscreen document have no tab (-1), so we match
// them by host instead: one session rule per media host, carrying the page URL that
// played the video. Rule ids from 1000 up are ours.
let ruleQueue = Promise.resolve();

function setReferer(urls, referer) {
  const hosts = [...new Set(urls.filter(Boolean).map((u) => new URL(u).hostname))];
  if (!/^https?:/.test(referer || '') || !hosts.length) return ruleQueue;
  ruleQueue = ruleQueue.then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const byHost = new Map(rules.filter((r) => r.id >= 1000).map((r) => [r.condition.requestDomains?.[0], r.id]));
    let nextId = Math.max(999, ...rules.map((r) => r.id)) + 1;
    const origin = new URL(referer).origin;
    const addRules = hosts.map((host) => ({
      id: byHost.get(host) ?? nextId++,
      priority: 1,
      condition: { tabIds: [-1], requestDomains: [host], resourceTypes: ['xmlhttprequest'] },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: referer },
          { header: 'Origin', operation: 'set', value: origin },
        ],
      },
    }));
    const existing = new Set(byHost.values());
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: addRules.map((r) => r.id).filter((id) => existing.has(id)),
      addRules,
    });
  }).catch((e) => console.warn('setReferer', e));
  return ruleQueue;
}

// --- Download jobs ----------------------------------------------------------
// Jobs run in an offscreen document so closing the popup doesn't stop them. Their
// state lives in storage.session under job:<id>; the popup renders from there.
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS', 'WORKERS'],
    justification: 'Download HLS segments and merge them with ffmpeg.wasm in the background.',
  }).finally(() => { creating = null; });
  await creating;
}

async function startJob(job) {
  job.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.session.set({
    [`job:${job.id}`]: { id: job.id, title: job.title, status: 'running', message: 'Starting…', tracks: [], command: '', started: Date.now() },
  });
  await setReferer([job.url, job.audioUrl, job.parentUrl, ...(job.captured || [])], job.referer);
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'run', job });
  return job.id;
}

async function updateJob(state) {
  const key = `job:${state.id}`;
  const prev = (await chrome.storage.session.get(key))[key];
  if (!prev) return; // cleared by the user
  await chrome.storage.session.set({ [key]: { ...prev, ...state } });
}

async function closeOffscreenIfIdle() {
  const all = await chrome.storage.session.get(null);
  const busy = Object.entries(all).some(([k, v]) => (k.startsWith('job:') && v.status === 'running') || k.startsWith('dl:'));
  if (!busy) await chrome.offscreen.closeDocument().catch(() => {});
}

chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || d.state.current === 'in_progress') return;
  const key = `dl:${d.id}`;
  const url = (await chrome.storage.session.get(key))[key];
  if (!url) return;
  await chrome.storage.session.remove(key);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return;
  const reply = (p) => { p.then(sendResponse, (e) => sendResponse({ error: e.message })); return true; };
  switch (msg?.type) {
    case 'getItems':
      return reply(load().then(() => tabs.get(msg.tabId) || []));
    case 'setReferer':
      return reply(setReferer(msg.urls, msg.referer));
    case 'startJob':
      return reply(startJob(msg.job));
    case 'cancelJob':
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', id: msg.id }).catch(() => {});
      return;
    case 'jobUpdate':
      return reply(updateJob(msg.job));
    case 'save':
      // The blob URL belongs to the offscreen document; it stays alive until we tell it to revoke.
      return reply(chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' })
        .then((id) => chrome.storage.session.set({ [`dl:${id}`]: msg.url }).then(() => ({ id }))));
    case 'idle':
      return reply(closeOffscreenIfIdle());
  }
});
