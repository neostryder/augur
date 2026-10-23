import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  // The usage panel is the page at the root; the chat is its own page at /chat/, so opening it never loads the panel's code.
  build: {
    outDir: 'dist', target: 'es2023', sourcemap: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), chat: resolve(import.meta.dirname, 'chat/index.html') } },
  },
});
