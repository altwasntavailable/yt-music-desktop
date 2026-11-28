# Winget manifest

The manifest in this folder packages the NSIS installer for
`altwasntavailable.YTMusicDesktop`.

The checked-in manifest currently targets **1.3.0**, the latest published
release. Its installer URL and SHA-256 match the released
`YT-Music-Desktop-Setup-1.3.0.exe`.

Validate it locally:

```powershell
winget validate --manifest packaging\winget\altwasntavailable.YTMusicDesktop\1.3.0
```

To publish it to the Winget community repository, submit the same manifest to
[`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs). You can use
[WingetCreate](https://github.com/microsoft/winget-create) or open the manifest
pull request manually.

Submission is still pending. Until the package is accepted, `winget install`
will not find it; use the GitHub release instead. Once accepted, users will be
able to install with:

```powershell
winget install altwasntavailable.YTMusicDesktop
```

Update the installer URL and SHA-256 for each new release, then add a new version
folder.
