import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const daemon = `http://127.0.0.1:${process.env.MH_PORT ?? 7420}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': daemon,
      '/ws': { target: daemon.replace('http', 'ws'), ws: true },
    },
  },
});
