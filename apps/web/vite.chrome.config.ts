import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    crx({
      manifest: { ...manifest, background: { service_worker: manifest.background.service_worker, type: 'module' } },
    }),
  ],
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  build: {
    outDir: 'chrome-extension',
    rollupOptions: {
      input: {
        kanban: 'index.html',
      },
    },
  },
});
