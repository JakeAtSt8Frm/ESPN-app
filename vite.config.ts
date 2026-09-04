import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Mounts the local refresh route on the dev server.
 *
 * Development only, by construction — `apply: 'serve'` means it never exists in
 * a build, so a deployed copy has no such route to reach. See
 * `scripts/refresh-endpoint.ts` for why the route exists at all and why it can
 * never be a public listener.
 */
function refreshEndpoint(): Plugin {
  return {
    name: 'espn-refresh-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void import('./scripts/refresh-endpoint.ts')
          .then(({ handleRefresh }) => handleRefresh(req, res))
          .then((handled) => {
            if (!handled) next();
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), refreshEndpoint()],

  // Relative URLs work both on a GitHub project page and at the domain root.
  base: './',

  // 5174 so this can run alongside the Sleeper app on 5173.
  server: { port: 5174, strictPort: true },

  build: {
    rollupOptions: {
      output: {
        // Keep the initial page small; charts load only on pages that use them.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          if (id.includes('react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
