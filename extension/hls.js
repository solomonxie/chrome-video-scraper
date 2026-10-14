// M3U8 parsing and fetch helpers shared by the popup and the download page.

export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function byteRange(spec, lastEnd = 0) {
  const [len, off] = spec.split('@');
  const start = off !== undefined ? Number(off) : lastEnd;
  return { header: `bytes=${start}-${start + Number(len) - 1}`, end: start + Number(len) };
}

export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an M3U8 playlist');
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const media = [];
    let pending = null;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        pending = parseAttrs(l.slice(18));
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        media.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'],
          name: a.NAME || a.LANGUAGE || a['GROUP-ID'],
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? abs(a.URI) : '',
        });
      } else if (!l.startsWith('#') && pending) {
        const resolution = pending.RESOLUTION || '';
        variants.push({
          uri: abs(l),
          bandwidth: Number(pending.BANDWIDTH) || 0,
          resolution,
          height: Number(resolution.split('x')[1]) || 0,
          codecs: pending.CODECS || '',
          audio: pending.AUDIO || '',
        });
        pending = null;
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: 'master', url: baseUrl, variants, media };
  }

  const segments = [];
  let seq = 0, duration = 0, key = null, map = null, range = null, endList = false;
  const lastEnd = {};
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXTINF:')) duration = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) range = l.slice(17);
    else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === 'NONE' ? null
        : { method: a.METHOD, uri: a.URI ? abs(a.URI) : '', iv: a.IV || '', keyFormat: a.KEYFORMAT || '' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      map = { uri: abs(a.URI), range: a.BYTERANGE ? byteRange(a.BYTERANGE).header : '' };
    } else if (!l.startsWith('#')) {
      const uri = abs(l);
      const seg = { uri, duration, seq: seq++, key, map, range: '' };
      if (range) {
        const r = byteRange(range, lastEnd[uri]);
        seg.range = r.header;
        lastEnd[uri] = r.end;
        range = null;
      }
      segments.push(seg);
      duration = 0;
    }
  }
  const total = segments.reduce((s, x) => s + x.duration, 0);
  return { type: 'media', url: baseUrl, segments, endList, duration: total };
}

// Some CDNs sign only the master URL and expect the player to copy its query
// string onto child playlists and segments. We try, in order: the URL the page
// actually requested (if we captured it), the URL as written, and the URL with
// the parent's query appended. Once the appended form works, we try it first.
export class Fetcher {
  constructor(captured = []) {
    this.captured = new Map(captured.map((u) => {
      const x = new URL(u);
      return [x.origin + x.pathname, u];
    }));
    this.inheritQuery = false;
  }

  candidates(url, parentUrl) {
    const u = new URL(url);
    const p = parentUrl ? new URL(parentUrl) : null;
    const inherited = !u.search && p?.search ? url.split('#')[0] + p.search : null;
    const list = [this.captured.get(u.origin + u.pathname), url];
    if (inherited) this.inheritQuery ? list.unshift(inherited) : list.push(inherited);
    return [...new Set(list.filter(Boolean))];
  }

  async get(url, parentUrl, { as = 'arrayBuffer', range = '', signal, retries = 3 } = {}) {
    let lastErr;
    for (const c of this.candidates(url, parentUrl)) {
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const res = await fetch(c, {
            credentials: 'include',
            signal,
            headers: range ? { Range: range } : {},
          });
          if (res.ok) {
            if (c !== url && !this.captured.has(new URL(c).origin + new URL(c).pathname)) this.inheritQuery = true;
            return { data: await res[as](), url: c };
          }
          lastErr = new Error(`HTTP ${res.status} for ${c}`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        } catch (e) {
          if (signal?.aborted) throw e;
          lastErr = e;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  async playlist(url, parentUrl, opts) {
    const { data, url: finalUrl } = await this.get(url, parentUrl, { ...opts, as: 'text' });
    return parseM3U8(data, finalUrl);
  }
}

export function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function sanitizeFilename(s) {
  return (s || 'video').replace(/[\\/:*?"<>|~\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
}

export function ffmpegCommand(url, referer, out) {
  const headers = referer ? `-headers "Referer: ${referer}" ` : '';
  return `ffmpeg ${headers}-i "${url}" -c copy "${out}"`;
}
