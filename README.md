# zack.

A portal between your computers. Drop anything into it (text, a photo, a file, a whole folder) and it comes out on your other machine: text and images land straight on the clipboard, files in `Downloads/Zack`. Mac, Windows and Linux, any direction, two or more devices.

Six looks, each with its own animation and synthesized sound:

| | |
|---|---|
| **Singularity** | A black hole, ray-traced per pixel: lensed accretion disk, Doppler beaming, items get spaghettified on the way in and come out of a white hole. |
| **Warp Pipe** | Pixel-art pipe on a floating island. Files turn into 18×18 sprites; a bulge travels through the pipe, the rim pops on the other side. |
| **Rift** | A ring of molten sparks with gravity; items burn through the edge. |
| **Toaster** | Files become toast with the file branded on; lever down, coils glow, it pops up over there with a ding. |
| **Liquid Metal** | A mercury puddle with real ripples; on arrival a column of metal rises and melts away. |
| **Monster** | Eats your files, chews, burps; the other one gets queasy and coughs them up. |

## How it works

```
 Mac ──┐                                   ┌── Windows
       │  E2E-encrypted chunks (AES-256-GCM)│
       └──▶ Cloudflare Worker ──▶ R2 (≤24 h) ┘
            Durable Object per portal:
            presence, envelopes, offline inbox
```

- **End-to-end encrypted.** Every drop gets its own key (HKDF from the portal key); file names, previews and text are sealed too. The relay sees sizes and timing, nothing else. The chunk count is sealed, so the relay can't truncate a file.
- **Pairing** with an 8-character one-shot code that expires after 10 minutes. The relay only sees a slow hash of it; the portal key travels inside an envelope sealed with a second derivation of the code. Pairing endpoints are rate limited.
- **Removing a device rotates the portal**: the remaining devices get a new room and key (sent encrypted under the old one), so the removed one can't read anything afterwards.
- **Streaming**: the receiver fetches each 4 MiB chunk as soon as it's uploaded.
- **Nothing is kept**: ciphertext is deleted from R2 the moment every recipient has it (typically within a second of arrival).
- **Offline delivery**: only for a device that is away, drops wait in the portal for 24 h (text for 30 days) and arrive when it comes back. An R2 lifecycle rule removes anything orphaned after two days.
- **Folders and apps** travel as zips with permissions and symlinks intact (`.app` bundles still run), and are unpacked on arrival with path-traversal checks.
- Received files are never opened automatically; a click on an executable only reveals it.
- The Electron app runs sandboxed with context isolation, a strict CSP, IPC sender checks, no navigation and no new windows. Room secrets live in the OS keychain (DPAPI / Keychain / libsecret) where that is available.

## Use

- Drag anything onto the portal, or press **⌥⌘Z / Ctrl+Alt+Z** to send the clipboard.
- Drag the portal itself to move it. Click it for quick actions, right-click for the menu.
- Hover to see the device and the last five items; drag an item out to drop it anywhere, right-click to cancel a running transfer.

## Develop

```bash
cd worker && npm install && npm run dev        # relay on :8787
cd app && npm install
ZACK_SERVER=http://127.0.0.1:8787 npm run dev   # the app, against the local relay
npm run dev:b                                   # a second instance (own profile) to pair with
npm run stage                                   # renderer only, mock bridge, all looks: localhost:5199/stage.html
node scripts/e2e-core.ts [server]               # end-to-end test of the transfer engine
```

## Release

```bash
cd worker && npx wrangler deploy               # needs ROOM_SECRET set once via `wrangler secret put`
cd app && npm run dist:mac                      # DMGs for Apple Silicon and Intel
cd app && npm run dist:win                      # zip with Zack.exe (installer: see CI)
```

## Run your own relay

Release builds talk to the author's relay. To use your own, deploy `worker/` to your Cloudflare account, set a secret, and build the app against it:

```bash
cd worker && npx wrangler r2 bucket create zack-portal-blobs && npx wrangler deploy
openssl rand -base64 48 | npx wrangler secret put ROOM_SECRET
cd ../app && ZACK_SERVER=https://<your-worker>.workers.dev npm run dist:mac
```

The relay is public by design (it only ever sees ciphertext): room creation, pairing and uploads are rate-limited per IP, the whole relay accepts at most `DAILY_UPLOAD_GB` (10 GB) per UTC day, and everything in R2 expires within two days.

`.github/workflows/build.yml` builds the Windows installer, a portable exe, the Mac DMG and Linux AppImage/deb natively on GitHub Actions.

Builds are not code-signed yet: on macOS right-click → Open the first time (or `xattr -cr /Applications/Zack.app`), on Windows SmartScreen → More info → Run anyway.

## License

MIT
