# Changelog

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
