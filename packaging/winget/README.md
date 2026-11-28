# Winget manifest

The manifest in this folder packages the NSIS installer for
`altwasntavailable.YTMusicDesktop`.

Validate it locally:

```powershell
winget validate --manifest packaging\winget\altwasntavailable.YTMusicDesktop\1.2.1
```

To publish it to the Winget community repository, submit the same manifest to
[`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs). A pull
request can be created with WingetCreate:

```powershell
wingetcreate submit --manifest packaging\winget\altwasntavailable.YTMusicDesktop\1.2.1
```

Once accepted, users will be able to install with:

```powershell
winget install altwasntavailable.YTMusicDesktop
```

Update the installer URL and SHA-256 for each new release, then add a new version
folder.
