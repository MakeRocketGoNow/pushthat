import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import manifest from './manifest.json';

/**
 * The commit this build was made from, shown beside the version on chrome://extensions
 * (`version_name`), with `+` when the web app had uncommitted changes. An unpacked build
 * otherwise looks the same whichever checkout or branch it came from, and telling one from
 * another meant comparing the worker bundle's hash. `version` stays the release number,
 * since Chrome requires it to be dotted integers.
 */
const build = (() => {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain -- .', { encoding: 'utf8' }).trim() !== '';
    return `${sha}${dirty ? '+' : ''}`;
  } catch {
    return 'unknown';
  }
})();

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
    crx({
      manifest: {
        ...manifest,
        version_name: `${manifest.version} (${build})`,
        background: { service_worker: manifest.background.service_worker, type: 'module' },
      },
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
