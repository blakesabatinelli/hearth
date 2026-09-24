import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// vitest config for apps/web.
//
// Tests run in jsdom so React Testing Library and DOM-fetch shimming work.
// We point at ./tests because that's where vitest.test glob picks them up.
//
// Mocking: tests stub `globalThis.fetch` directly. We do NOT spin up MSW or
// a real server. The PWA talks to apps/control over the Vite proxy, but in
// CI we never boot the backend, so tests are pure unit tests with a stub.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['./tests/setup.ts'],
  },
});
