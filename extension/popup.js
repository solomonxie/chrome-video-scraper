import { Fetcher, formatBytes, formatDuration, sanitizeFilename, ffmpegCommand } from './hls.js';

const list = document.getElementById('list');
const MIN_FILE_SIZE = 512 * 1024;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...children.filter((c) => c != null));
  return e;
}

function copyButton(text, label = 'Copy URL') {
  const b = el('button', { class: 'ghost' }, label);
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = label), 1200);
  });
  return b;
}

async function openDownloader(params) {
  const res = await chrome.runtime.sendMessage({ type: 'startJob', job: params });
  if (res?.error) alert(`Couldn't start download: ${res.error}`);
}

// --- Jobs panel -------------------------------------------------------------
// Jobs run in the background (offscreen document); this just renders their state
// from storage.session, live while the popup is open.

const jobsEl = document.getElementById('jobs');

async function renderJobs() {
  const all = await chrome.storage.session.get(null);
  const jobs = Object.entries(all).filter(([k]) => k.startsWith('job:')).map(([, v]) => v)
    .sort((a, b) => b.started - a.started);
  jobsEl.replaceChildren(...jobs.map((j) => el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('strong', { class: 'grow' }, j.title),
      j.status === 'running'
        ? el('button', { class: 'ghost', onclick: () => chrome.runtime.sendMessage({ type: 'cancelJob', id: j.id }) }, 'Cancel')
        : el('button', { class: 'ghost', title: 'Remove from list', onclick: () => chrome.storage.session.remove(`job:${j.id}`) }, '✕')),
    ...j.tracks.map((t) => el('div', { class: 'track' },
      el('div', { class: 'row muted' }, el('span', {}, t.label), el('span', {}, t.info)),
      el('progress', { max: 1, value: t.progress }))),
    el('div', { class: { done: 'ok', error: 'error', cancelled: 'error' }[j.status] || 'muted' }, j.message),
    j.command ? el('pre', {}, j.command) : null,
    j.command ? el('div', { class: 'row' }, copyButton(j.command, 'Copy command')) : null,
  )));
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k.startsWith('job:'))) renderJobs();
});

function variantLabel(v) {
  const parts = [v.height ? `${v.height}p` : v.resolution || 'unknown'];
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(1)} Mbps`);
  return parts.join(' · ');
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const items = await chrome.runtime.sendMessage({ type: 'getItems', tabId: tab.id });
  const title = sanitizeFilename(tab.title);
  const referer = tab.url;
  list.replaceChildren();

  const hls = items.filter((i) => i.kind === 'hls');
  const dash = items.filter((i) => i.kind === 'dash');
  const files = items.filter((i) => i.kind === 'file' && (!i.size || i.size >= MIN_FILE_SIZE));
  const captured = items.map((i) => i.url);
  await chrome.runtime.sendMessage({ type: 'setReferer', urls: captured, referer });
  const fetcher = new Fetcher(captured);

  // Parse every captured playlist so child playlists can be folded under their master.
  const parsed = await Promise.all(hls.map(async (i) => {
    try {
      return { item: i, pl: await fetcher.playlist(i.url, null, { retries: 1 }) };
    } catch (e) {
      return { item: i, error: e.message };
    }
  }));
  const childPaths = new Set();
  for (const p of parsed) {
    if (p.pl?.type !== 'master') continue;
    for (const u of [...p.pl.variants.map((v) => v.uri), ...p.pl.media.map((m) => m.uri)]) {
      if (u) childPaths.add(new URL(u).pathname);
    }
  }

  for (const p of parsed) {
    const { item } = p;
    if (p.pl?.type === 'media' && childPaths.has(new URL(item.url).pathname)) continue;
    const frameReferer = item.frameUrl || referer;

    if (p.error) {
      list.append(el('div', { class: 'card' },
        el('div', { class: 'row' }, el('span', { class: 'tag' }, 'HLS'), el('span', { class: 'error' }, p.error)),
        el('div', { class: 'url' }, item.url),
        el('div', { class: 'row' },
          el('button', { onclick: () => openDownloader({ url: item.url, title, referer: frameReferer, captured }) }, 'Try download'),
          copyButton(item.url),
          copyButton(ffmpegCommand(item.url, frameReferer, `${title}.mp4`), 'Copy ffmpeg')),
      ));
      continue;
    }

    if (p.pl.type === 'master') {
      const audios = p.pl.media.filter((m) => m.type === 'AUDIO');
      const select = el('select', {}, ...p.pl.variants.map((v, idx) => el('option', { value: idx }, variantLabel(v))));
      list.append(el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('span', { class: 'tag' }, 'HLS'),
          el('span', {}, `${p.pl.variants.length} qualities`),
          audios.length ? el('span', { class: 'muted' }, `· separate audio`) : null),
        el('div', { class: 'url' }, item.url),
        el('div', { class: 'row' },
          select,
          el('button', {
            onclick: () => {
              const v = p.pl.variants[Number(select.value)];
              const group = audios.filter((a) => a.groupId === v.audio && a.uri);
              const audio = group.find((a) => a.isDefault) || group[0];
              openDownloader({
                url: v.uri, audioUrl: audio?.uri || '', parentUrl: item.url,
                title: `${title} ${v.height ? v.height + 'p' : ''}`.trim(), referer: frameReferer, captured,
              });
            },
          }, 'Download'),
          copyButton(item.url)),
      ));
    } else {
      const encrypted = p.pl.segments.find((s) => s.key)?.key;
      list.append(el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('span', { class: 'tag' }, 'HLS'),
          el('span', {}, `${p.pl.segments.length} segments · ${formatDuration(p.pl.duration)}`),
          p.pl.endList ? null : el('span', { class: 'muted' }, '· live'),
          encrypted ? el('span', { class: 'muted' }, `· ${encrypted.method}`) : null),
        el('div', { class: 'url' }, item.url),
        el('div', { class: 'row' },
          el('button', { onclick: () => openDownloader({ url: item.url, title, referer: frameReferer, captured }) }, 'Download'),
          copyButton(item.url)),
      ));
    }
  }

  for (const item of dash) {
    const ref = item.frameUrl || referer;
    list.append(el('div', { class: 'card' },
      el('div', { class: 'row' }, el('span', { class: 'tag' }, 'DASH'), el('span', { class: 'muted' }, 'in-browser download not supported; use ffmpeg / yt-dlp')),
      el('div', { class: 'url' }, item.url),
      el('div', { class: 'row' }, copyButton(item.url), copyButton(ffmpegCommand(item.url, ref, `${title}.mp4`), 'Copy ffmpeg')),
    ));
  }

  for (const item of files) {
    const ext = (new URL(item.url).pathname.match(/\.(\w{2,4})$/)?.[1] || item.contentType.split('/')[1]?.split(';')[0] || 'mp4').toLowerCase();
    list.append(el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('span', { class: 'tag' }, ext),
        item.size ? el('span', {}, formatBytes(item.size)) : null),
      el('div', { class: 'url' }, item.url),
      el('div', { class: 'row' },
        el('button', {
          onclick: () => chrome.downloads.download({ url: item.url, filename: `${title}.${ext}`, saveAs: false }),
        }, 'Download'),
        copyButton(item.url)),
    ));
  }

  if (!list.children.length) {
    list.append(el('p', { class: 'muted' },
      tab.url?.startsWith('blob:') || !items.length
        ? 'No videos detected on this tab yet.'
        : 'Only small media files found (ads, thumbnails…).'));
  }
}

document.getElementById('refresh').addEventListener('click', render);
renderJobs();
render().catch((e) => list.replaceChildren(el('p', { class: 'error' }, e.message)));
