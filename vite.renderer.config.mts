import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The production CSP in index.html is strict. The Vite dev server needs inline
// scripts/styles (React refresh, CSS injection) and a websocket, so loosen it only in dev.
const devCsp = (): Plugin => ({
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /content="default-src 'none';[^"]*"/,
      `content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'"`,
    );
  },
});

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), devCsp()],
});
