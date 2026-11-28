# Changelog

## 1.2.1

### Fixed

- Fixed MP3/MP4 downloads failing when FFmpeg was found through `PATH` but not the
  app's tools folder. The app now resolves the real FFmpeg executable path.
- Added a persistent `downloads.log` and a visible **Last error** line in the
  Offline panel so failed downloads are diagnosable instead of disappearing
  silently.
- Playlist downloads now stop immediately with a clear error if FFmpeg cannot be
  used, instead of attempting every track.

### Packaging

- Added a portable executable to the release assets.
- Added a GitHub Actions release workflow with build provenance attestations.
- Added README screenshots/demo, issue templates, a contributing guide, and a
  validated Winget manifest.

## 1.2.0

### Added

- Choose **MP3** (audio) or **MP4** (video) before every download.
- Download the **current track** or the **current playlist/queue** from the title-bar download menu or the Offline panel.
- Playlist downloads run sequentially, skip tracks that are already saved, and show aggregate progress.

### Fixed

- Downloaded files are named `Artist - Title.ext` instead of the YouTube video ID, with safe Windows filename handling and duplicate-name suffixes.

### Notes

- MP3 requires FFmpeg. MP4 uses FFmpeg for high-quality merging when available and falls back to a progressive MP4 without it.

## 1.1.1

### Fixed

- Added an out-of-process watchdog that restarts the app when the Electron main
  process hangs (`AppHangB1`) after long background periods or sleep/resume.
- Kept renderer-level auto-recovery for the desktop UI and the YouTube Music
  player, including manual **Reload window** / **Reload player** actions and
  `Ctrl+R` / `Ctrl+Shift+R`.
- Made yt-dlp probing asynchronous so checking the Downloads panel cannot block
  the main process.
- Replaced the blocking sign-out confirmation with a native dialog.

### Security

- Verified downloaded yt-dlp binaries against the official SHA-256 checksum
  list before execution.
- Added a security policy, privacy documentation, and a complete ignore list so
  local sessions, logs, build output, and signing material are not committed.
- Added `.gitattributes` normalization and Dependabot configuration.

## 1.1.0

- Added offline downloads, SponsorBlock, automatic updates, and the expanded
  settings/downloads UI.
- Added renderer crash/hang recovery and background playback hardening.

## 1.0.0

- Initial desktop player release.
