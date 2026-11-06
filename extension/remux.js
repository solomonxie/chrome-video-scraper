// Lossless remux to a single .mp4 with ffmpeg.wasm (no re-encoding).

import { FFmpeg } from './vendor/ffmpeg/index.js';

// The wasm heap tops out around 2 GB and has to hold inputs and output at once.
export const MAX_REMUX_BYTES = 900 * 1024 * 1024;

// inputs: [{ blob, ext }] (video first, then optional separate audio)
// subtitles: [{ srt, language, label }], muxed as mov_text tracks QuickTime can show.
export async function remuxToMp4(inputs, onProgress, signal, subtitles = []) {
  const ff = new FFmpeg();
  const onAbort = () => ff.terminate();
  signal?.addEventListener('abort', onAbort);
  const log = [];
  ff.on('log', ({ message }) => { log.push(message); if (log.length > 40) log.shift(); });
  ff.on('progress', ({ progress }) => onProgress?.(Math.min(Math.max(progress, 0), 1)));
  await ff.load({
    coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm'),
  });
  try {
    const args = [];
    for (const [i, { blob, ext }] of inputs.entries()) {
      const name = `in${i}.${ext}`;
      await ff.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
      args.push('-i', name);
    }
    for (const [i, sub] of subtitles.entries()) {
      const name = `sub${i}.srt`;
      await ff.writeFile(name, new TextEncoder().encode(sub.srt));
      args.push('-i', name);
    }
    if (inputs.length > 1) args.push('-map', '0:v:0?', '-map', '1:a:0?');
    else if (subtitles.length) args.push('-map', '0:v?', '-map', '0:a?');
    subtitles.forEach((sub, i) => {
      args.push('-map', `${inputs.length + i}:0`);
      if (sub.language) args.push(`-metadata:s:s:${i}`, `language=${sub.language}`);
      if (sub.label) args.push(`-metadata:s:s:${i}`, `title=${sub.label}`, `-metadata:s:s:${i}`, `handler_name=${sub.label}`);
    });
    args.push('-c', 'copy');
    if (subtitles.length) args.push('-c:s', 'mov_text', '-disposition:s:0', 'default');
    args.push('-movflags', '+faststart', 'out.mp4');
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${log.slice(-3).join(' | ')}`);
    const out = await ff.readFile('out.mp4');
    return new Blob([out], { type: 'video/mp4' });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    ff.terminate();
  }
}
