import { Fetcher, formatBytes, formatDuration, sanitizeFilename, ffmpegCommand } from './hls.js';
import { sniffFormat, parseCues, toSrt, toVtt, toLrc, fetchHlsSubtitle, saveText, collectPageTracks, findVideoTitle } from './subs.js';

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

// Subtitle tracks ticked "Include in video download"; filled by subtitleCard().
const embedSubs = new Set();

async function openDownloader(params) {
  let subtitles = [];
  try {
    subtitles = await Promise.all([...embedSubs].map(async (sub) => ({
      srt: toSrt(await loadCues(sub)), language: iso639_2(sub.language), label: sub.label,
    })));
  } catch (e) {
    alert(`Couldn't load subtitles to embed: ${e.message}`);
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'startJob', job: { ...params, subtitles } });
  if (res?.error) alert(`Couldn't start download: ${res.error}`);
}

// MP4 language tags are ISO 639-2 (three letters); pages give "en", "en-US", "eng"…
const LANG3 = {
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', nl: 'nld', ru: 'rus', uk: 'ukr', pl: 'pol',
  zh: 'zho', ja: 'jpn', ko: 'kor', ar: 'ara', hi: 'hin', tr: 'tur', sv: 'swe', no: 'nor', nb: 'nob', da: 'dan',
  fi: 'fin', el: 'ell', he: 'heb', cs: 'ces', hu: 'hun', ro: 'ron', th: 'tha', vi: 'vie', id: 'ind', ms: 'msa',
};
function iso639_2(lang) {
  const base = (lang || '').toLowerCase().split(/[-_]/)[0];
  return base.length === 3 ? base : LANG3[base] || '';
}

// Cues of a subtitle entry, whatever format it came in.
async function loadCues(sub) {
  const { text, cues: loaded } = await sub.load();
  const format = text != null ? sniffFormat(text, sub.url) : 'vtt';
  const cues = loaded || parseCues(text, format);
  if (!cues) throw new Error(`Can't convert ${format.toUpperCase()}`);
  if (!cues.length) throw new Error('Track has no cues');
  if (cues.every((c) => /\.(jpe?g|png|webp)(#xywh=|$)/i.test(c.text.trim()))) {
    throw new Error('Thumbnail-preview track, not subtitles');
  }
  return cues;
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
  const title = sanitizeFilename(await videoTitle(tab));
  const referer = tab.url;
  list.replaceChildren();

  const hls = items.filter((i) => i.kind === 'hls');
  const dash = items.filter((i) => i.kind === 'dash');
  const files = items.filter((i) => i.kind === 'file' && (!i.size || i.size >= MIN_FILE_SIZE));
  const subs = []; // { label, language, source, url, load: () => Promise<{ text?, cues? }> }
  embedSubs.clear();
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
    for (const m of p.pl.media.filter((x) => x.type === 'SUBTITLES' && x.uri)) {
      subs.push({
        label: [m.name, m.language && m.language !== m.name ? m.language : ''].filter(Boolean).join(' · '),
        language: m.language,
        source: 'HLS',
        url: m.uri,
        load: async () => ({ cues: await fetchHlsSubtitle(fetcher, await fetcher.playlist(m.uri, p.item.url)) }),
      });
    }
  }

  for (const p of parsed) {
    const { item } = p;
    if (p.pl?.type === 'media' && childPaths.has(new URL(item.url).pathname)) continue;
    if (p.pl?.type === 'media' && p.pl.segments.length && p.pl.segments.every((sg) => /\.(web)?vtt(\?|$)/i.test(sg.uri))) {
      subs.push({ label: subtitleLabel(item.url), source: 'HLS', url: item.url, load: async () => ({ cues: await fetchHlsSubtitle(fetcher, p.pl) }) });
      continue;
    }
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
          onclick: () => {
            // Embedding subtitles means fetching the whole file and remuxing it; MP4-family only.
            if (embedSubs.size && ['mp4', 'm4v', 'mov'].includes(ext)) {
              openDownloader({ fileUrl: item.url, fileExt: ext, url: item.url, title, referer: item.frameUrl || referer, captured });
              return;
            }
            chrome.runtime.sendMessage({ type: 'download', url: item.url, filename: `${title}.${ext}` })
              .then((r) => r?.error && alert(`Couldn't download: ${r.error}`));
          },
        }, 'Download'),
        copyButton(item.url)),
    ));
  }

  const dir = (u) => { const x = new URL(u); return x.origin + x.pathname.replace(/[^/]*$/, ''); };
  const hlsSubDirs = new Set(subs.filter((x) => x.source === 'HLS').map((x) => dir(x.url)));
  for (const item of items.filter((i) => i.kind === 'sub')) {
    if (subs.some((x) => x.url === item.url) || hlsSubDirs.has(dir(item.url))) continue;
    subs.push({
      label: subtitleLabel(item.url), language: urlLanguage(item.url), source: 'network', url: item.url,
      load: async () => ({ text: (await fetcher.get(item.url, null, { as: 'text', retries: 1 })).data }),
    });
  }
  await addPageTracks(tab, subs, fetcher);
  if (subs.length) {
    list.append(el('div', { class: 'section muted' }, 'Subtitles & lyrics'), ...subs.map((s) => subtitleCard(s, title)));
  }

  if (!list.children.length) {
    list.append(el('p', { class: 'muted' },
      tab.url?.startsWith('blob:') || !items.length
        ? 'No videos detected on this tab yet.'
        : 'Only small media files found (ads, thumbnails…).'));
  }
}

// --- Subtitles / lyrics -------------------------------------------------------

function urlLanguage(url) {
  const u = new URL(url);
  return u.searchParams.get('tlang') || u.searchParams.get('lang')
    || u.pathname.match(/[._/-]([a-z]{2,3}(?:-[A-Za-z]{2})?)\.(?:web)?vtt$|[._/-]([a-z]{2,3}(?:-[A-Za-z]{2})?)\.srt$/)?.slice(1).find(Boolean) || '';
}

function subtitleLabel(url) {
  const u = new URL(url);
  const lang = urlLanguage(url);
  const name = decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
  return lang ? `${lang} · ${name}` : name;
}

// Filename base: the video's own title, read first from frames that contain a
// <video> (an embedded player knows its own title), then the top page; else the
// tab title, else the site name.
async function videoTitle(tab) {
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: findVideoTitle });
  } catch {} // chrome:// pages, web store, etc.
  const results = frames.map((f) => ({ ...f.result, top: f.frameId === 0 })).filter((r) => r.title);
  const pick = results.find((r) => r.hasVideo && r.top) || results.find((r) => r.hasVideo) || results.find((r) => r.top);
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  return pick?.title || tab.title || host || 'video';
}

// <track> elements and text tracks a player filled from JS (no network file to catch).
async function addPageTracks(tab, subs, fetcher) {
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: collectPageTracks });
  } catch {
    return; // chrome:// pages, web store, etc.
  }
  for (const t of frames.flatMap((f) => f.result || [])) {
    const label = [t.label, t.language].filter(Boolean).join(' · ') || 'Untitled track';
    if (t.src) {
      if (t.src.startsWith('blob:') || t.src.startsWith('data:')) continue; // not fetchable from here
      if (subs.some((x) => x.url === t.src)) continue;
      subs.push({
        label, language: t.language, source: '<track>', url: t.src,
        load: async () => ({ text: (await fetcher.get(t.src, null, { as: 'text', retries: 1 })).data }),
      });
    } else {
      subs.push({ label, language: t.language, source: 'player', url: '', load: async () => ({ cues: t.cues }) });
    }
  }
}

const OUTPUTS = [['original', 'Original'], ['srt', 'SRT'], ['vtt', 'WebVTT'], ['lrc', 'LRC (lyrics)']];

function subtitleCard(sub, title) {
  const select = el('select', {}, ...OUTPUTS.map(([v, l]) => el('option', { value: v }, l)));
  select.value = 'srt';
  const status = el('span', { class: 'muted' });
  const button = el('button', {
    onclick: async () => {
      button.disabled = true;
      status.className = 'muted';
      status.textContent = 'Fetching…';
      try {
        let want = select.value;
        let out, ext;
        if (want === 'original') {
          const { text } = await sub.load();
          if (text == null) want = 'vtt'; // player-only track: there is no original file
          else {
            out = text;
            const format = sniffFormat(text, sub.url);
            ext = { json3: 'json' }[format] || format;
          }
        }
        if (want !== 'original') {
          out = { srt: toSrt, vtt: toVtt, lrc: toLrc }[want](await loadCues(sub));
          ext = want;
        }
        const lang = sub.label.split(' · ')[0].replace(/\.\w+$/, '');
        await saveText(out, sanitizeFilename(`${title} [${lang}]`) + `.${ext}`, ext);
        status.className = 'ok';
        status.textContent = 'Saved';
      } catch (e) {
        status.className = 'error';
        status.textContent = e.message;
      } finally {
        button.disabled = false;
      }
    },
  }, 'Download');
  const embed = el('input', { type: 'checkbox' });
  embed.addEventListener('change', async () => {
    if (!embed.checked) { embedSubs.delete(sub); return; }
    embedSubs.add(sub);
    // Check now, so a bad track is flagged before the video download starts.
    try {
      await loadCues(sub);
    } catch (e) {
      embed.checked = false;
      embedSubs.delete(sub);
      status.className = 'error';
      status.textContent = e.message;
    }
  });
  return el('div', { class: 'card' },
    el('div', { class: 'row' }, el('span', { class: 'tag' }, sub.source === 'HLS' ? 'HLS sub' : 'sub'),
      el('span', { class: 'grow' }, sub.label), el('span', { class: 'muted' }, sub.source)),
    sub.url ? el('div', { class: 'url' }, sub.url) : null,
    el('div', { class: 'row' }, select, button, sub.url ? copyButton(sub.url) : null, status),
    el('label', { class: 'row muted' }, embed, 'Include in video download (shown in QuickTime under View → Subtitles)'));
}

document.getElementById('refresh').addEventListener('click', render);
renderJobs();
render().catch((e) => list.replaceChildren(el('p', { class: 'error' }, e.message)));
