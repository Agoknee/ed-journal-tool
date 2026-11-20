import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// During development (npm run client:dev), API requests are proxied to the running server.
const apiServerUrl = process.env.API_SERVER_URL ?? 'http://localhost:4267';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: apiServerUrl, changeOrigin: true },
    },
  },
});
