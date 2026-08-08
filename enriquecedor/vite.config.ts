import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Servido como sub-app do SalesHub em /enriquecedor/ (dev standalone e produção).
  base: '/enriquecedor/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
    proxy: {
      // Encaminha as chamadas de enriquecimento para o backend local (Node).
      '/api': 'http://localhost:3011',
    },
  },
});
