import { defineConfig } from 'vite';

// Local OSRM backup servers (scripts/routing-servers.sh) proxied under one
// origin so the browser needs no CORS.
const osrm = (port: number) => ({
  target: `http://127.0.0.1:${port}`,
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/osrm\/[a-z]+/, ''),
});

export default defineConfig({
  // GitHub Pages serves under /<repo>/ — set by the deploy workflow.
  base: process.env.PAGES_BASE ?? '/',
  server: {
    host: true, // bind all interfaces so 127.0.0.1 (Chrome) works, not just ::1
    proxy: {
      '/osrm/car': osrm(5001),
      '/osrm/bike': osrm(5002),
      '/osrm/foot': osrm(5003),
    },
  },
});
