import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// The relay this build talks to. `ZACK_SERVER=http://127.0.0.1:8787 npm run dev`
// points a dev build at `wrangler dev`; the app's settings can override it too.
const SERVER = process.env.ZACK_SERVER ?? 'https://zack-portal.lennystepn.workers.dev';

export default defineConfig({
  main: {
    define: { __ZACK_SERVER__: JSON.stringify(SERVER) },
  },
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          widget: resolve(__dirname, 'src/renderer/widget.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          stage: resolve(__dirname, 'src/renderer/stage.html'),
        },
      },
    },
  },
});
