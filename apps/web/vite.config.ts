import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// `import.meta.dirname` rather than `__dirname`: Vite's native config loader
// does not provide CommonJS globals.
const here = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  // Read VITE_* vars from the repo-root .env files, the same place the API
  // reads its config from.
  envDir: path.resolve(here, '../..'),
  resolve: {
    alias: {
      // Consume the shared package straight from source so a funnel config
      // change is hot-reloaded rather than requiring a rebuild step.
      '@funnel/shared': path.resolve(here, '../../packages/shared/src/index.ts'),
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep React in its own chunk: the funnel config changes far more often
        // than React does, so this keeps the big vendor chunk cacheable across
        // deploys instead of being invalidated by every copy tweak.
        manualChunks(id) {
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
