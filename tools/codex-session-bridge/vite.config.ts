import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist/harness-ui', emptyOutDir: true, manifest: true, sourcemap: false },
});
