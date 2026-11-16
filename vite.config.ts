import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built app works from any sub-path (e.g. GitHub Pages).
  base: './',
  optimizeDeps: {
    // Both packages ship their own WASM loaders; let Vite serve them untouched.
    exclude: ['manifold-3d', '@salusoft89/planegcs'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
  },
} as any);
