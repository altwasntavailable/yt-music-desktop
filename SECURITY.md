# Security Policy

## Supported versions

Security fixes are provided for the latest published `1.3.x` release.
Older builds may be missing important recovery and integrity fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include reproduction steps, the app version, and any relevant logs.

If private reporting is unavailable, contact the repository owner through
GitHub and ask for a private channel before sharing details.

## Security model

- The desktop shell uses Electron with `contextIsolation` enabled, no Node.js
  integration in web pages, and a sandboxed YouTube Music webview.
- The renderer has a restrictive Content-Security-Policy and cannot make
  arbitrary network requests.
- IPC handlers verify that calls come from the app's own main renderer. Web
  content in the embedded YouTube Music page cannot invoke desktop APIs.
- Browser sign-in can import an existing session from Chrome/Edge/Brave/Vivaldi
  with your consent. It copies the selected cookie database and cookie key to a
  temporary profile, imports only Google/YouTube cookies, and deletes the copy;
  the real browser profile is never modified. The separate-browser fallback
  uses a private stdio debugging pipe, with no localhost debugging port.
- Website permission requests (camera, microphone, notifications, etc.) are
  denied by default.
- Untrusted links open in the system browser; they are not loaded inside the
  app.
- No telemetry or analytics are collected.
- The app stores its YouTube session, settings, download index, and logs
  locally. Downloaded files live in the active download folder, which can be
  changed in Settings or the Offline panel.
- Offline downloads use `yt-dlp`. When the app installs `yt-dlp` itself, the
  downloaded binary is verified against the SHA-256 checksum published in the
  official yt-dlp release before it is executed. In-app updates use yt-dlp's
  own updater and are only offered for the app-managed Windows binary.
- Offline playback is served through a custom `ytmd-media` protocol. It only
  resolves files tracked in the local download index and streams them with
  HTTP range support instead of reading whole files into memory.
- In-app yt-dlp updates verify the resulting executable against yt-dlp's
  published SHA-256 checksum list. The app only updates its own managed copy.
- Automatic updates use HTTPS and GitHub Releases. The current build is not
  code-signed because no signing certificate is configured.

## Release verification

Each release publishes a `SHA256SUMS.txt` file alongside the installer and
portable build. Verify the file you downloaded before running it; the example
below uses the latest published release, 1.3.1:

```powershell
certutil -hashfile YT-Music-Desktop-Setup-1.3.1.exe SHA256
```

Compare the output with the value in `SHA256SUMS.txt` from the same release.
Release assets also include GitHub build provenance attestations, which can be
checked with `gh attestation verify` (see the README).
