import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', target: 'es2023', sourcemap: true },
});
