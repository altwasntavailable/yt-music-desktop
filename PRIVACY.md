# Privacy

YT Music Desktop is a local desktop shell around the official YouTube Music web
player. It does not include telemetry, analytics, advertising SDKs, or a remote
account system.

## Data stored on your computer

The app stores the following data in its Electron user-data folder
(`%APPDATA%\YT Music Desktop` on Windows):

- YouTube/Google sign-in cookies for the app's dedicated session partition.
- App settings, window position, and equalizer preferences.
- Downloaded tracks (only when you choose to download them).
- The optional `yt-dlp` helper and its download index.
- Troubleshooting logs, including the watchdog restart log and download error log.
- Browser sign-in profile data when you use browser sign-in.

You can remove the YouTube session with **Settings → Account → Sign out**, or
delete the app's user-data folder after quitting the app to remove all local
data.

## Network requests

The app connects to third-party services only to provide its features:

- **YouTube Music / Google** for playback and sign-in.
- **LRCLIB** when the lyrics panel requests lyrics.
- **SponsorBlock** when SponsorBlock is enabled, to fetch segment metadata.
- **Discord** only when you connect Discord Rich Presence.
- **GitHub** for update checks and for downloading the optional `yt-dlp`
  helper.
- **YouTube/Google** hosts used by the embedded player and its artwork.

These services have their own privacy policies. The app does not send your
settings, listening history, or local files to the developer.

## Discord Rich Presence

If enabled, the app sends the current track title, artist, album, artwork URL,
and playback position to your local Discord client through Discord's IPC
interface. Disable it at any time under **Settings → Discord Rich Presence**.

## Downloads

Offline downloads are performed locally by `yt-dlp`. The app itself does not
upload downloaded files anywhere.
