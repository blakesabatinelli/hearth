import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PWA dev/build config.
//
// The backend (apps/control) listens on http://127.0.0.1:8787 and does NOT
// enable CORS. We proxy /v1, /healthz, /readyz through the Vite dev server
// so the browser sees same-origin requests and the Set-Cookie header sticks
// to the page. This keeps session/CSRF working in dev without standing up
// a CORS layer on the API.
//
// `changeOrigin: true` rewrites the Host header to match the target. We
// do NOT rewrite paths: /v1/* stays /v1/* at the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/readyz': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
