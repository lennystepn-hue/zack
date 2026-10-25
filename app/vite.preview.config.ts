import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Serves the renderer alone (mock bridge) for design work: npm run stage
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  server: { port: 5199, strictPort: true },
});
