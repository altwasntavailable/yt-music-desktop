# Security Policy

## Supported versions

Security fixes are provided for the latest release in the `1.1.x` line. Older
builds may be missing important recovery and integrity fixes.

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
- Website permission requests (camera, microphone, notifications, etc.) are
  denied by default.
- Untrusted links open in the system browser; they are not loaded inside the
  app.
- No telemetry or analytics are collected.
- The app stores its YouTube session, settings, downloads, and logs locally in
  the Electron user-data folder.
- Offline downloads use `yt-dlp`. When the app installs `yt-dlp` itself, the
  downloaded binary is verified against the SHA-256 checksum published in the
  official yt-dlp release before it is executed.
- Automatic updates use HTTPS and GitHub Releases. The current build is not
  code-signed because no signing certificate is configured.

## Release verification

Each release should publish a `SHA256SUMS.txt` file alongside the installer.
Verify it before running the installer:

```powershell
certutil -hashfile YT-Music-Desktop-Setup-1.1.1.exe SHA256
```

Compare the output with the value in `SHA256SUMS.txt` from the same release.
