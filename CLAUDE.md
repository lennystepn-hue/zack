# Zack

Two packages: `app/` (Electron 45 + electron-vite) and `worker/` (Cloudflare Worker relay: Durable Objects `Room`/`PairSlot`, R2 bucket `zack-portal-blobs`).

- `app/src/core/` is the transport and crypto, free of Electron, so `node scripts/e2e-core.ts <relay>` and `node scripts/e2e-rekey.ts <relay>` test it directly. Run both after touching the protocol.
- `app/src/main/` is the Electron glue, `app/src/renderer/src/themes/` holds the six looks on a shared `Theme` base (`base.ts`).
- Electron 45's `clipboard` is async and W3C-shaped (`read()`, `write([ClipboardItem])`); there is no `readImage`/`writeImage`.
- Visual work: `npm run stage` in `app/` serves the renderer with a mock bridge at `localhost:5199/stage.html` (`?view=solo&theme=…`).
- Two real instances on one machine: `ZACK_PROFILE=a` / `ZACK_PROFILE=b`, `--remote-debugging-port` to drive them over CDP.
- The relay caps total uploads per UTC day (`DAILY_UPLOAD_GB` in `wrangler.jsonc`, counted in the `Quota` Durable Object); the app shows `daily_limit` when it's hit.
- Deploying the worker (`npx wrangler deploy`) changes a live service: get the user's go first. `ROOM_SECRET` is a Worker secret, never in the repo.
- Windows installers and the AppImage need x86 tools: build them with `.github/workflows/build.yml`, not on an Apple Silicon Mac. Locally `dist:win` makes a zip.
