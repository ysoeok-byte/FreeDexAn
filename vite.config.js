import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { uploadApiPlugin } from './server/upload-api.js';
import { animeSamaApiPlugin } from './server/anime-sama-api.js';

export default defineConfig({
  plugins: [react(), uploadApiPlugin(), animeSamaApiPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5000,
    strictPort: true,
    allowedHosts: true
  }
});