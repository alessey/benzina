import { defineConfig } from 'vite';

const GAME_SERVER = process.env.BENZINA_SERVER ?? 'ws://localhost:2567';

export default defineConfig({
  server: {
    // Listen on the LAN so phones on the same Wi-Fi can join.
    host: true,
    // The client always connects to /ws on its own origin; in dev Vite forwards it to the
    // game server, so only one port needs to be reachable.
    proxy: { '/ws': { target: GAME_SERVER, ws: true } },
  },
  // Rapier ships its WASM inlined as base64, so the bundle is large by design.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
