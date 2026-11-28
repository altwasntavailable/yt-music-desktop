# Contributing

Thanks for helping improve YT Music Desktop.

## Development setup

Requirements:

- Windows 10/11
- Node.js 20 or newer
- npm

```bash
npm install
npm start       # run the app
npm run dev     # run with development logging
```

Build outputs:

```bash
npm run dist            # NSIS installer
npm run dist:portable   # portable executable
npm run pack            # unpacked app in dist/win-unpacked
```

## Architecture

- `src/main/` — Electron main process: windows, tray, IPC, sessions, recovery,
  watchdog, downloads, updater, and third-party lookups.
- `src/preload/` — the narrow, context-isolated IPC bridge exposed to the desktop
  renderer.
- `src/renderer/` — the desktop chrome and drawer UI. It also probes the embedded
  YouTube Music player for track/queue state.
- `src/main/downloads.js` — yt-dlp/FFmpeg detection, filename handling, verified
  tool downloads, and sequential playlist jobs.

Keep renderer access narrow: add IPC handlers in `main.js`, expose only the
needed method in `chrome-preload.js`, and validate/sanitize all input in the
main process.

## Pull requests

- Keep changes focused and explain the user-facing effect.
- Run `node --check` on changed JavaScript files and `npm run dist` when changing
  packaging or main-process code.
- Include screenshots for UI changes.
- Never commit `node_modules`, `dist`, signing material, cookies, logs, or user
  data. The existing `.gitignore` covers the usual cases.
- For download changes, test with:
  - a single track as MP3 and MP4
  - a playlist download with at least two tracks
  - FFmpeg found through `PATH` (do not rely only on `YTMD_FFMPEG_PATH`)
  - a duplicate download and a cancelled/failed download

## Security

Do not open a public issue for a vulnerability. Use the repository's private
vulnerability reporting flow described in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License in [LICENSE](LICENSE).
