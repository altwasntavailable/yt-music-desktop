# Changelog

## 1.3.1 — 2026-11-28

### Fixed

- Google sign-in no longer dead-ends on **"Couldn't sign you in — This browser
  or app may not be secure."** The app now offers to import the existing
  Google/YouTube session from Chrome, Edge, Brave, or Vivaldi. With your
  consent it copies the selected browser's cookie database to a temporary
  profile, imports only Google/YouTube cookies, and deletes the copy. The real
  browser profile is never modified. Close the browser first if it is running.
- The separate browser sign-in fallback now disables Chromium's automation
  signal (`navigator.webdriver`), which Google rejects, while keeping the
  private stdio debugging pipe.
- Browser import now tries other profiles and installed browsers when the
  first profile has no saved YouTube session.
- The imported session is verified before the app reports success; a partial
  import is cleared instead of leaving the UI falsely signed in.
- Temporary import profiles are cleaned up on quit and at the next startup, so
  a crash or timeout cannot leave a copied cookie database in `%TEMP%`.
- Sign-out waits for an in-flight cookie import before clearing the session.

## 1.3.0 — 2026-11-28

### Added

- Downloads now support **M4A** (original audio, no FFmpeg), **MP3** (128, 192,
  256, or 320 kbps, or best VBR), and **MP4** (480p, 720p, 1080p, or best).
- The download folder can be changed from **Settings → Downloads** or the
  **Offline** panel. Existing downloads keep their paths and remain playable.
- Optional title/artist/album tags and cover art for audio downloads, plus
  optional SponsorBlock segment removal during download. Both require FFmpeg.
- Install and update the app-managed `yt-dlp` from the Offline panel. The UI
  shows the installed version and offers a one-click install; external copies
  must be updated separately.
- Offline library: search, audio/video filter, sorting, total track count and
  size, per-track details, cancellation for active downloads, retry for the last
  failed track, and shortcuts to the download log and active download folder.
- Offline player: previous/next, shuffle, repeat, queue position, playback
  speed, Windows media-session metadata/actions, and player state forwarded to
  the tray, Discord Rich Presence, and the sleep-prevention blocker.
- Offline-first error screen: when YouTube Music fails to load, the error screen
  offers the offline library instead of only a retry button.
- Playlist downloads add each track to the offline library as soon as that
  track finishes.
- Windows desktop integration: taskbar thumbnail buttons (Previous,
  Play/Pause, Next, Download, Settings), jump-list actions and recent
  downloads, taskbar download progress, completion/error overlays, and
  track-change notifications when the app is hidden.
- Sleep timer (15–90 minutes) that pauses playback.
- Start with Windows, launching the installed app hidden in the tray.
- The system is kept awake while a download is active, even if the window is in
  the tray.
- Diagnostics actions to copy app/tool/download status and recent logs, open
  the app data folder, and open the download log.

### Changed

- The download dialog exposes per-download MP3 quality, MP4 quality, tag/cover
  art, and SponsorBlock cutting options; Settings holds the defaults.
- The Offline panel is now a library with tool status and download controls
  rather than only a file list.

### Fixed

- The SponsorBlock category list can now legitimately be empty. Unchecking every
  category is preserved instead of being replaced with the default categories.
- Lyrics offset controls now move lyrics in the direction their labels describe.
- The **Restart & install update** button stays visible after closing and
  reopening Settings when an update has already downloaded.
- Escape closes the open download dialog or download menu, and the drawer, even
  when the YouTube Music player has keyboard focus.
- Tag and cover-art embedding now works for audio downloads when FFmpeg is
  available. If the optional metadata step fails, the track is kept with a
  warning instead of being discarded.
- Per-track downloads appear in the offline library immediately when each track
  finishes, not only when the whole playlist completes.
- Offline playback streams large files from disk instead of loading the whole
  file into memory, so large MP4 downloads start without a memory spike.
- Download retries now resume from kept partial files, stale library entries are
  pruned instead of blocking a re-download, and cancelling a playlist can no
  longer start a pending track after the cancel.
- First launch no longer forces the window to the top-left corner; saved window
  coordinates are optional.
- A transient SponsorBlock lookup failure no longer disables segments for six
  hours; failures retry after one minute.
- Portable builds use the outer portable launcher for watchdog restart, jump
  list, and Start with Windows, instead of the temporary extracted executable.
  Portable builds no longer report as supporting in-app updates.

### Security

- IPC handlers reject calls from anything other than the app's own renderer.
- The `ytmd-media` protocol streams offline files with HTTP range support and
  only resolves files tracked in the download index.
- Browser sign-in now uses a private stdio debugging pipe instead of a localhost
  CDP port, and deletes the temporary browser profile after a successful import.
- In-app yt-dlp updates verify the resulting executable against the official
  SHA-256 checksum list.

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
