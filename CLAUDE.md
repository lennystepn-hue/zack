# Zack

Two packages: `app/` (Electron 45 + electron-vite) and `worker/` (Cloudflare Worker relay: Durable Objects `Room`/`PairSlot`, R2 bucket `zack-portal-blobs`).

- `app/src/core/` is the transport and crypto, free of Electron, so `node scripts/e2e-core.ts <relay>`, `e2e-rekey.ts` and `e2e-security.ts` test it directly. Run all three after touching the protocol or the relay.
- Each device binds its id on the relay with a secret (`dev.` subprotocol); names are sealed (`s1.` prefix). Pairing codes are 12 Crockford chars through scrypt; changing that breaks pairing with older versions.
- `app/src/main/` is the Electron glue, `app/src/renderer/src/themes/` holds the six looks on a shared `Theme` base (`base.ts`).
- Electron 45's `clipboard` is async and W3C-shaped (`read()`, `write([ClipboardItem])`); there is no `readImage`/`writeImage`.
- Visual work: `npm run stage` in `app/` serves the renderer with a mock bridge at `localhost:5199/stage.html` (`?view=solo&theme=…`).
- Two real instances on one machine: `ZACK_PROFILE=a` / `ZACK_PROFILE=b`, `--remote-debugging-port` to drive them over CDP.
- The relay caps total uploads per UTC day (`DAILY_UPLOAD_GB` in `wrangler.jsonc`, counted in the `Quota` Durable Object); the app shows `daily_limit` when it's hit.
- Deploying the worker (`npx wrangler deploy`) changes a live service: get the user's go first. `ROOM_SECRET` is a Worker secret, never in the repo.
- Self-update (`app/src/main/updater.ts`) reads the latest GitHub release and needs the asset names `Zack-<v>-mac-<arch>.dmg`, `-win-setup.exe`, `-linux-x64.AppImage` plus `SHA256SUMS.txt`; renaming them breaks updates for everyone already installed. Test it with a packaged copy built as an older version (`electron-builder --mac dir --arm64 -c.extraMetadata.version=0.1.9`) started with `--user-data-dir=<tmp>`, so the real profile and keychain stay out of it.
- macOS releases are signed (Developer ID, team `UKP7WY42H3`), hardened and notarized in CI from the repo secrets `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`; a `v*` tag fails without them, because the updater refuses Mac updates without that signature. Local builds stay ad-hoc and without the hardened runtime (ad-hoc + hardened runtime would need a library-validation exception).
- Windows installers and the AppImage need x86 tools: build them with `.github/workflows/build.yml`, not on an Apple Silicon Mac. Locally `dist:win` makes a zip.
