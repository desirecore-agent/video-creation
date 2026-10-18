import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { buildMotionSdk, motionBuildInputs, prepareMotionSamples } from '../../../../scripts/build-motion-sdk.mjs';

/* Studio's editor: built once into dist/ and served by Studio's own server (studio/server/server.mjs) */
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwind(), {
    name: 'video-creation-motion-runtime',
    apply: 'build',
    buildStart() {
      for (const file of motionBuildInputs()) this.addWatchFile(file);
    },
    async generateBundle() {
      for (const file of await buildMotionSdk({ write: false }))
        this.emitFile({ type: 'asset', fileName: basename(file.path), source: file.contents });
    },
    async writeBundle() { await prepareMotionSamples(); },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
});
