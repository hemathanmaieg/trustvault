import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // During development the API runs separately on port 3000.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
