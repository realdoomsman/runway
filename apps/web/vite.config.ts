import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  // wallet-adapter and its deps reference Node globals; Buffer itself is
  // installed at runtime in src/polyfills.ts before anything else loads.
  define: { global: 'globalThis' },
  optimizeDeps: { esbuildOptions: { define: { global: 'globalThis' } } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', 'zustand'],
          solana: [
            '@solana/web3.js',
            '@solana/spl-token',
            '@solana/wallet-adapter-base',
            '@solana/wallet-adapter-react',
            '@solana/wallet-adapter-phantom',
            '@solana/wallet-adapter-solflare',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true, changeOrigin: true },
      '/sites': { target: API, changeOrigin: true },
      '/svc': { target: API, changeOrigin: true },
    },
  },
});
