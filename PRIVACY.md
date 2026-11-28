# Privacy

YT Music Desktop is a local desktop shell around the official YouTube Music web
player. It does not include telemetry, analytics, advertising SDKs, or a remote
account system.

## Data stored on your computer

The app stores the following data locally. Settings, session data, and the
download index are in its Electron user-data folder (`%APPDATA%\YT Music
Desktop` on Windows); downloads and the download log use the active download
folder:

- YouTube/Google sign-in cookies for the app's dedicated session partition.
- App settings, window position, equalizer preferences, and the chosen download
  folder.
- Downloaded tracks (only when you choose to download them), including any
  title/artist/album tags and cover art you ask the app to embed.
- The download index and the optional `yt-dlp` helper.
- Troubleshooting logs, including the watchdog restart log and download error
  log. The download log lives in the active download folder.
- Temporary browser sign-in profile data while you use browser sign-in. The
  dedicated profile is removed after a successful import, on sign-out, and on
  cancellation/timeout cleanup where Windows file locks allow it.

Downloaded files and the download log live in the active download folder (the
app's `downloads` folder by default). The download index and settings stay in
the app's user-data folder.

You can remove the YouTube session with **Settings → Account → Sign out**. To
remove all local data, quit the app, then delete the app's user-data folder and
the active download folder.

## Network requests

The app connects to third-party services only to provide its features:

- **YouTube Music / Google** for playback and sign-in.
- **LRCLIB** when the lyrics panel requests lyrics.
- **SponsorBlock** when SponsorBlock is enabled, to fetch segment metadata. The
  same lookup is used when you enable SponsorBlock cutting for downloads.
- **Discord** only when you connect Discord Rich Presence.
- **GitHub** for update checks, downloading the optional `yt-dlp` helper, and
  yt-dlp self-updates when you use the app-managed copy.
- **YouTube/Google** hosts used by the embedded player and its artwork.

These services have their own privacy policies. The app does not send your
settings, listening history, or local files to the developer.

## Notifications

Track-change, download, and sleep-timer notifications are local Windows
notifications. They are not sent through a push service or to the developer.
You can turn track notifications off under **Settings → Desktop**.

## Discord Rich Presence

If enabled, the app sends the current track title, artist, album, artwork URL,
and playback position to your local Discord client through Discord's IPC
interface. Disable it at any time under **Settings → Discord Rich Presence**.

## Downloads

Offline downloads are performed locally by `yt-dlp`. The app itself does not
upload downloaded files anywhere. Tags/cover art and SponsorBlock cutting modify
only the local downloaded copy. When you change the download folder, new files
go to the new folder; the app does not move existing downloads.
