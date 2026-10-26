A portal between your computers: drop anything onto it and it comes out on your other machine. End-to-end encrypted, Mac, Windows and Linux, six animated looks.

## Download

| | |
|---|---|
| **macOS, Apple Silicon** (M1 and newer) | `Zack-…-mac-arm64.dmg` |
| **macOS, Intel** | `Zack-…-mac-x64.dmg` |
| **Windows** | `Zack-…-win-setup.exe` (installer) or `Zack-…-win-portable.exe` (no install) |
| **Linux** | `Zack-…-linux-x64.AppImage` or `.tar.gz` |

## Pair two computers

1. On the first one, click **Open a new portal**. You get a 12-character code (valid once, for 10 minutes).
2. On the second one, choose **Enter a code** and type it in. Both portals light up.

Add more devices the same way from the settings.

## Updates

From 0.2.1 on Zack updates itself: Settings → Updates → Update now, or the tray menu when a new version is out.

## First launch

- **macOS**: signed with a Developer ID and notarized by Apple, it opens like any other app.
- **Windows**: not signed yet, so SmartScreen asks once: **More info** → **Run anyway**.

## Check the download

`SHA256SUMS.txt` lists the checksum of every file. In the folder with the download:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```
