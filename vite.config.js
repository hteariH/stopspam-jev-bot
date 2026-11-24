import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The Mini App lives in app/ and builds into dist/, which tgcloud.jsonc
// hands to `tgcloud push` as the static site.
export default defineConfig({
  root: 'app',
  plugins: [preact()],
  build: { outDir: '../dist', emptyOutDir: true },
});
