import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  root: './',
  envPrefix: ['VITE_', 'X_DEBUG_'],
  server: { port: 4173, strictPort: true },
  build: {
    outDir: 'dist'
  }
});
