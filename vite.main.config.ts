import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': '/src/shared',
    },
  },
  build: {
    rollupOptions: {
      external: [
        'node-pty',
        'ssh2',
      ],
    },
  },
});
