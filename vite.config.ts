import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/api', '/auth', '/logout', '/login', '/login.css', '/login.js', '/fonts', '/manifest.webmanifest', '/icon.svg']
        .map((path) => [path, { target: 'http://127.0.0.1:8787', changeOrigin: false }]),
    ),
  },
  build: {
    outDir: 'public/build-staging',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
  },
});
