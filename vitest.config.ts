import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The in-process multiplayer simulations run tens of seconds of game time.
    testTimeout: 30_000,
  },
});
