import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Static build of the scripted demo page, for Cuttle to render frame by frame:
//   npx vite build --config vite.media.config.ts   → media-build/reel.html
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'media-build'),
    emptyOutDir: true,
    rollupOptions: {
      input: { reel: resolve(__dirname, 'src/renderer/reel.html'), settings: resolve(__dirname, 'src/renderer/settings.html') },
    },
  },
});
