# Video Scraper (Chrome extension)

Detects HLS (`.m3u8`), DASH (`.mpd`) and direct video files (`.mp4`, `.webm`, …) loaded by the current tab and downloads them.

## Install
1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `extension/` folder.

## Use
1. Open the page and play the video for a moment (so the player requests the playlist).
2. Click the extension icon (the badge shows how many streams it found).
3. For HLS master playlists pick a quality and hit **Download**. Progress shows at the top of the popup.
   The download runs in a hidden offscreen document, so you can close the popup; reopen it to see
   progress or cancel. It fetches 6 segments in parallel, decrypts AES-128 if needed, and saves the
   result to `~/Downloads`.

Output is a single `.mp4`. Separate audio tracks (`EXT-X-MEDIA:TYPE=AUDIO`) and `.ts` segments are
merged/remuxed in the browser with a bundled ffmpeg.wasm (`extension/vendor/`, no re-encoding).
Above ~900 MB, or if the merge fails, the raw `.ts`/`.m4a` files are saved instead and the page
shows the ffmpeg command to merge them locally.

## Limits
- DRM (Widevine/FairPlay, `SAMPLE-AES`) can't be downloaded.
- DASH is detected only; the popup gives you a ffmpeg command.
- Whole video is held in memory before saving; multi-GB streams may hit the tab's memory limit.
- The extension is ~32 MB because of the bundled ffmpeg.wasm core.
- Jobs live in memory: quitting Chrome or reloading the extension stops them.
