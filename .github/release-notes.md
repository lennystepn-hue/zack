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

## First launch

The builds aren't code-signed yet:

- **macOS**: right-click Zack in Applications → **Open** the first time. If macOS says the app is damaged, run `xattr -cr /Applications/Zack.app`.
- **Windows**: SmartScreen → **More info** → **Run anyway**.

## Check the download

`SHA256SUMS.txt` lists the checksum of every file. In the folder with the download:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```
