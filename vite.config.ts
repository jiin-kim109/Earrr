import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'frontend',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./frontend', import.meta.url)) },
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1' },
});
