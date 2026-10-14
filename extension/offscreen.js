// Runs HLS download jobs in a hidden offscreen document so they survive the popup closing.
// Offscreen documents only get chrome.runtime, so progress goes to the background via
// messages, and the background does the chrome.downloads / storage work.

import { Fetcher, formatBytes, sanitizeFilename, ffmpegCommand } from './hls.js';
import { remuxToMp4, MAX_REMUX_BYTES } from './remux.js';

const CONCURRENCY = 6;
const running = new Map(); // job id -> AbortController
const blobs = new Set(); // blob URLs still being copied by chrome.downloads

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'run') runJob(msg.job);
  else if (msg.type === 'cancel') running.get(msg.id)?.abort();
  else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.url);
    blobs.delete(msg.url);
    maybeIdle();
  }
});

function maybeIdle() {
  if (!running.size && !blobs.size) chrome.runtime.sendMessage({ target: 'bg', type: 'idle' });
}

function ivFor(seg) {
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq);
  }
  return iv;
}

class Job {
  constructor(job, abort) {
    this.job = job;
    this.abort = abort;
    this.fetcher = new Fetcher(job.captured || []);
    this.keyCache = new Map();
    this.state = { id: job.id, title: job.title, status: 'running', message: 'Starting…', tracks: [], command: '' };
    this.timer = null;
  }

  // Throttled: segment progress can fire hundreds of times a second.
  report(now = false) {
    const flush = () => {
      this.timer = null;
      chrome.runtime.sendMessage({ target: 'bg', type: 'jobUpdate', job: this.state });
    };
    if (now) { clearTimeout(this.timer); flush(); }
    else this.timer ??= setTimeout(flush, 300);
  }

  track(label) {
    const t = { label, progress: 0, info: '' };
    this.state.tracks.push(t);
    this.report();
    return t;
  }

  async decrypt(seg, data, playlistUrl) {
    if (!seg.key) return data;
    if (seg.key.method !== 'AES-128' || (seg.key.keyFormat && seg.key.keyFormat !== 'identity')) {
      throw new Error(`Stream is DRM-protected (${seg.key.method}${seg.key.keyFormat ? ', ' + seg.key.keyFormat : ''}); it cannot be downloaded.`);
    }
    if (!this.keyCache.has(seg.key.uri)) {
      this.keyCache.set(seg.key.uri, this.fetcher.get(seg.key.uri, playlistUrl, { signal: this.abort.signal })
        .then(({ data: raw }) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
    }
    const key = await this.keyCache.get(seg.key.uri);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, key, data);
  }

  async downloadTrack(url, label) {
    const { signal } = this.abort;
    const t = this.track(label);
    t.info = 'Loading playlist…';
    const pl = await this.fetcher.playlist(url, this.job.parentUrl, { signal });
    if (pl.type === 'master') throw new Error('Expected a media playlist but got a master playlist.');
    if (!pl.segments.length) throw new Error('Playlist has no segments.');
    if (pl.segments[0].key) await this.decrypt(pl.segments[0], new ArrayBuffer(0), pl.url).catch((e) => {
      if (/DRM/.test(e.message)) throw e;
    });

    const parts = new Array(pl.segments.length);
    const maps = new Map();
    let done = 0, bytes = 0, next = 0;
    const started = performance.now();

    const worker = async () => {
      while (next < pl.segments.length) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const i = next++;
        const seg = pl.segments[i];
        const { data } = await this.fetcher.get(seg.uri, pl.url, { range: seg.range, signal });
        parts[i] = await this.decrypt(seg, data, pl.url);
        if (seg.map && !maps.has(seg.map.uri + seg.map.range)) {
          maps.set(seg.map.uri + seg.map.range, null);
          const { data: init } = await this.fetcher.get(seg.map.uri, pl.url, { range: seg.map.range, signal });
          maps.set(seg.map.uri + seg.map.range, init);
        }
        done++;
        bytes += parts[i].byteLength;
        const secs = (performance.now() - started) / 1000;
        t.progress = done / pl.segments.length;
        t.info = `${done} / ${pl.segments.length} segments · ${formatBytes(bytes)} · ${formatBytes(bytes / secs)}/s`;
        this.report();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Interleave init segments (fMP4) wherever the EXT-X-MAP changes.
    const out = [];
    let lastMap = null;
    pl.segments.forEach((seg, i) => {
      const mk = seg.map ? seg.map.uri + seg.map.range : null;
      if (mk && mk !== lastMap) out.push(maps.get(mk));
      lastMap = mk;
      out.push(parts[i]);
    });
    t.info += pl.endList ? ' · done' : ' · done (live stream: only segments available now)';
    this.report();
    return { blob: new Blob(out), fmp4: !!pl.segments[0].map };
  }

  async save(blob, filename) {
    const url = URL.createObjectURL(blob);
    blobs.add(url);
    const res = await chrome.runtime.sendMessage({ target: 'bg', type: 'save', url, filename });
    if (res?.error) {
      URL.revokeObjectURL(url);
      blobs.delete(url);
      throw new Error(`Couldn't save ${filename}: ${res.error}`);
    }
  }

  async run() {
    const { job, state } = this;
    const base = sanitizeFilename(job.title);
    const tasks = [this.downloadTrack(job.url, job.audioUrl ? 'Video' : 'Video + audio')];
    if (job.audioUrl) tasks.push(this.downloadTrack(job.audioUrl, 'Audio'));
    state.message = 'Downloading…';
    const [video, audio] = await Promise.all(tasks);

    const inputs = [{ blob: video.blob, ext: video.fmp4 ? 'mp4' : 'ts' }];
    if (audio) inputs.push({ blob: audio.blob, ext: audio.fmp4 ? 'm4a' : 'ts' });
    const total = inputs.reduce((n, i) => n + i.blob.size, 0);

    // Already a single fMP4 file: nothing to merge or convert.
    if (!audio && video.fmp4) {
      await this.save(video.blob, `${base}.mp4`);
      return `Saved ${base}.mp4 (${formatBytes(video.blob.size)}) to Downloads.`;
    }

    let mergeError = '';
    if (total <= MAX_REMUX_BYTES) {
      const t = this.track(audio ? 'Merging video + audio into .mp4' : 'Converting to .mp4');
      t.info = 'Loading ffmpeg…';
      state.message = 'Merging…';
      try {
        const mp4 = await remuxToMp4(inputs, (p) => { t.progress = p; t.info = `${Math.round(p * 100)}%`; this.report(); }, this.abort.signal);
        t.progress = 1;
        t.info = 'done';
        await this.save(mp4, `${base}.mp4`);
        return `Saved ${base}.mp4 (${formatBytes(mp4.size)}) to Downloads.`;
      } catch (e) {
        if (this.abort.signal.aborted) throw e;
        mergeError = e.message || String(e);
        t.info = `failed: ${mergeError}`;
      }
    } else {
      mergeError = `${formatBytes(total)} is too large to merge in the browser (limit ${formatBytes(MAX_REMUX_BYTES)})`;
    }

    // Fallback: save the raw tracks and show how to merge them locally.
    const [vName, aName] = inputs.map((i, n) => `${base}${audio ? (n ? '.audio' : '.video') : ''}.${i.ext}`);
    await this.save(video.blob, vName);
    if (audio) await this.save(audio.blob, aName);
    state.command = audio
      ? `cd ~/Downloads && ffmpeg -i "${vName}" -i "${aName}" -map 0:v -map 1:a -c copy "${base}.mp4"`
      : `cd ~/Downloads && ffmpeg -i "${vName}" -c copy "${base}.mp4"`;
    return `Saved ${audio ? `${vName} and ${aName}` : vName} to Downloads (couldn't make .mp4: ${mergeError}). Merge locally with:`;
  }
}

async function runJob(job) {
  const abort = new AbortController();
  running.set(job.id, abort);
  const j = new Job(job, abort);
  j.report(true);
  try {
    j.state.message = await j.run();
    j.state.status = 'done';
  } catch (e) {
    if (abort.signal.aborted) {
      j.state.status = 'cancelled';
      j.state.message = 'Cancelled.';
    } else {
      j.state.status = 'error';
      j.state.message = `Failed: ${e.message}. You can try ffmpeg instead:`;
      j.state.command = ffmpegCommand(job.parentUrl || job.url, job.referer, `${sanitizeFilename(job.title)}.mp4`);
    }
  } finally {
    running.delete(job.id);
    j.report(true);
    maybeIdle();
  }
}
