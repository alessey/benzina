import { defineConfig } from 'vite';

export default defineConfig({
  // Rapier ships its WASM inlined as base64, so the bundle is large by design.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
