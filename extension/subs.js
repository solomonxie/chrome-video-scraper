// Subtitle / lyrics helpers: parse common formats into cues, write them back out
// as SRT, WebVTT or LRC, and merge segmented HLS WebVTT.

const MIME = { vtt: 'text/vtt', srt: 'application/x-subrip', lrc: 'text/plain', ttml: 'application/ttml+xml', ass: 'text/x-ssa' };

export function sniffFormat(text, url = '') {
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 1000);
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\d+\s*\n\s*\d+:\d\d:\d\d[,.]\d+\s*-->/.test(head)) return 'srt';
  if (head.startsWith('[Script Info]')) return 'ass';
  if (/<tt[\s>]|<tt:tt[\s>]/.test(head)) return 'ttml';
  if (head.startsWith('{') && head.includes('"events"')) return 'json3';
  if (/^\[\d+:\d\d([.:]\d+)?\]/m.test(head)) return 'lrc';
  const ext = (() => { try { return new URL(url).pathname.match(/\.(\w+)$/)?.[1]?.toLowerCase(); } catch { return ''; } })();
  return { webvtt: 'vtt', dfxp: 'ttml', xml: 'ttml' }[ext] || ext || 'txt';
}

// "01:02:03.456", "02:03,456", "3.5" -> seconds
function clock(s) {
  const parts = s.trim().replace(',', '.').split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseCueBlocks(text) {
  const cues = [];
  for (const b of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = b.trim().split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue; // WEBVTT header, NOTE, STYLE, REGION
    const [start, end] = lines[i].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    cues.push({ start: clock(start), end: clock(end), text: lines.slice(i + 1).join('\n') });
  }
  return cues;
}

// TTML times: "00:00:01.500", "00:00:01:12" (frames), "1.5s", "1500ms", "15000000t".
function ttmlTime(s, tickRate, frameRate) {
  if (!s) return null;
  const m = s.match(/^([\d.]+)(h|m|s|ms|f|t)$/);
  if (m) {
    const n = Number(m[1]);
    return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, f: n / frameRate, t: n / tickRate }[m[2]];
  }
  const p = s.split(':');
  if (p.length === 4) return clock(p.slice(0, 3).join(':')) + Number(p[3]) / frameRate;
  return clock(s);
}

function parseTtml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  const attr = (el, name) => el.getAttribute(name) ?? el.getAttributeNS('http://www.w3.org/ns/ttml#parameter', name.split(':').pop());
  const tickRate = Number(attr(root, 'ttp:tickRate')) || 10000000;
  const frameRate = Number(attr(root, 'ttp:frameRate')) || 30;
  const textOf = (node) => [...node.childNodes].map((c) => {
    if (c.nodeType === 3) return c.nodeValue.replace(/\s+/g, ' ');
    if (c.localName === 'br') return '\n';
    return c.nodeType === 1 ? textOf(c) : '';
  }).join('');
  const cues = [];
  for (const p of doc.getElementsByTagNameNS('*', 'p')) {
    // Apple Music lyrics put timing on <span>s inside <p>; the <p> still has begin/end.
    const start = ttmlTime(p.getAttribute('begin'), tickRate, frameRate);
    if (start == null) continue;
    let end = ttmlTime(p.getAttribute('end'), tickRate, frameRate);
    const dur = ttmlTime(p.getAttribute('dur'), tickRate, frameRate);
    if (end == null) end = dur != null ? start + dur : start;
    cues.push({ start, end, text: textOf(p).split('\n').map((l) => l.trim()).join('\n').trim() });
  }
  return cues;
}

// YouTube's /api/timedtext?fmt=json3
function parseJson3(text) {
  const { events = [] } = JSON.parse(text);
  return events.filter((e) => e.segs).map((e) => ({
    start: e.tStartMs / 1000,
    end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
    text: e.segs.map((s) => s.utf8 || '').join('').trim(),
  })).filter((c) => c.text);
}

function parseLrc(text) {
  const cues = [];
  for (const line of text.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+:\d\d(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d\d[.:]\d+>/g, '').trim();
    for (const s of stamps) {
      // mm:ss, mm:ss.xx or mm:ss:xx
      const [, min, sec, frac = '0'] = s[1].match(/^(\d+):(\d\d)(?:[.:](\d+))?$/);
      cues.push({ start: Number(min) * 60 + Number(sec) + Number(`0.${frac}`), end: 0, text: words });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  cues.forEach((c, i) => { c.end = cues[i + 1]?.start ?? c.start + 5; });
  return cues;
}

export function parseCues(text, format) {
  switch (format) {
    case 'vtt': case 'srt': return parseCueBlocks(text);
    case 'ttml': return parseTtml(text);
    case 'json3': return parseJson3(text);
    case 'lrc': return parseLrc(text);
    default: return null; // ASS etc.: offered as-is only
  }
}

// HLS subtitle playlists split one WebVTT file into many; a cue that spans a
// segment boundary appears in both, so repeats are dropped.
export function mergeVttCues(texts) {
  const seen = new Set();
  return texts.flatMap((t) => parseCueBlocks(t)).filter((c) => {
    const k = `${c.start}|${c.end}|${c.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function stamp(sec, sep) {
  const ms = Math.round(sec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

function plain(text, keep = /^\/?[ibu]$/) {
  return text.replace(/<\/?([^\s>]*)[^>]*>/g, (tag, name) => (keep.test(name) ? tag : ''))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&').trim();
}

export function toSrt(cues) {
  return `${cues.filter((c) => plain(c.text)).map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${plain(c.text)}`).join('\n\n')}\n`;
}

export function toVtt(cues) {
  return `WEBVTT\n\n${cues.filter((c) => c.text.trim()).map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text.trim()}`).join('\n\n')}\n`;
}

export function toLrc(cues) {
  const t = (sec) => {
    const cs = Math.round(sec * 100);
    return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  return `${cues.map((c) => `[${t(c.start)}]${plain(c.text, /^$/).replace(/\n/g, ' ')}`).join('\n')}\n`;
}

export async function fetchHlsSubtitle(fetcher, pl) {
  const texts = new Array(pl.segments.length);
  let next = 0;
  const worker = async () => {
    while (next < pl.segments.length) {
      const i = next++;
      const seg = pl.segments[i];
      texts[i] = (await fetcher.get(seg.uri, pl.url, { as: 'text', range: seg.range })).data;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return mergeVttCues(texts);
}

// A blob URL, not a data: URL, so Chrome keeps the extension in the name. The
// popup holds the blob; the file is tiny and written before the popup could close.
export async function saveText(text, filename, format) {
  const blob = new Blob([text], { type: `${MIME[format] || 'text/plain'};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({ type: 'download', url, filename });
  if (res?.error) throw new Error(res.error);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return res.id;
}

// Runs inside the page via chrome.scripting, so it must be self-contained.
// Returns <track> URLs, plus the cues of text tracks a player filled from JS.
export function collectPageTracks() {
  const out = [];
  for (const media of document.querySelectorAll('video, audio')) {
    const els = [...media.querySelectorAll('track')];
    for (const t of media.textTracks) {
      if (t.kind === 'metadata') continue;
      const src = els.find((e) => e.track === t)?.src || '';
      const cues = !src && t.cues?.length
        ? [...t.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: c.text ?? '' }))
        : null;
      if (src || cues) out.push({ src, cues, label: t.label, language: t.language });
    }
  }
  return out;
}

// Runs inside each frame via chrome.scripting, so it must be self-contained.
// Best guess at the video's own title, most specific source first ('' if none),
// and whether this frame has a <video>.
export function findVideoTitle() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const meta = (sel) => clean(document.querySelector(sel)?.content);
  const fromJsonLd = () => {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const stack = [JSON.parse(s.textContent)];
        while (stack.length) {
          const o = stack.pop();
          if (!o || typeof o !== 'object') continue;
          if (Array.isArray(o)) { stack.push(...o); continue; }
          const type = [].concat(o['@type'] || []);
          if (type.includes('VideoObject') && o.name) return clean(o.name);
          stack.push(o['@graph'], o.video, o.mainEntity);
        }
      } catch {}
    }
    return '';
  };
  const video = document.querySelector('video');
  const candidates = [
    clean(video?.getAttribute('title') || video?.getAttribute('aria-label')),
    fromJsonLd(),
    meta('meta[property="og:video:title"]'),
    meta('meta[property="og:title"]'),
    meta('meta[name="twitter:title"]'),
    meta('meta[name="title"]'),
    clean(navigator.mediaSession?.metadata?.title),
    clean(document.querySelector('h1')?.textContent),
  ];
  return { title: candidates.find((c) => c && c.length <= 300) || '', hasVideo: !!video };
}
