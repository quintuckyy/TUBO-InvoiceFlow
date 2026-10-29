import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, /api calls are proxied to the backend, so the browser sees a single origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
