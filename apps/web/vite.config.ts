// cspell:ignore idents
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// https://vite.dev/config/
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react(), tsconfigPaths()],
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  // The SSR build is only the static pages' renderer (`npm run prerender`); the site's build
  // already copies public/ into dist/.
  build: { copyPublicDir: !isSsrBuild },
}));
