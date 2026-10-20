/**
 * index.js — Entrypoint standalone: Web Dashboard + Control + Engine WhatsApp
 *
 * Mode all-in-one (VPS / Railway / Render / Fly.io / Termux / lokal):
 *   npm start        -> dashboard + engine dalam satu proses di PORT (default 3000)
 *
 * Mode Vercel (dashboard saja — engine WA tetap harus di host persistent):
 *   vercel deploy, set env ENGINE_URL (alamat engine) + ENGINE_TOKEN + AUTH_SECRET
 *
 * Struktur:
 *   system/  -> modul backend (config, auth, http, engine WA, auto-delete, router API)
 *   web/     -> dashboard (login, pairing, kontrol)
 *   api/     -> handler serverless untuk Vercel
 */
import http from 'node:http';
import { CONFIG, PATHS, RUNTIME } from './system/config.js';
import { createLocalEngine } from './system/wa.js';
import { createApiRouter } from './system/apiHandlers.js';
import { applySecurityHeaders, isHttps, normalizeReq, readJsonBody, serveStatic, sendJson } from './system/http.js';

const engine = createLocalEngine();
const route = createApiRouter({ engine, statefulAuth: true });

engine.on('state', st => {
   console.log(`[ENGINE] ${st.state} — ${st.message}`);
});

const server = http.createServer(async (req, res) => {
   const https = isHttps(req);
   applySecurityHeaders(res, { https });

   let pathname = '/';
   try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
   } catch {}

   try {
      if (pathname.startsWith('/api/')) {
         const method = (req.method || 'GET').toUpperCase();
         const body = method === 'POST' ? await readJsonBody(req) : null;
         const norm = normalizeReq(req, body);
         norm.raw = req;
         await route(norm, res);
         return;
      }
      serveStatic(res, pathname, PATHS.web);
   } catch (error) {
      console.error('[HTTP]', error?.message ?? error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Kesalahan server' });
   }
});

server.listen(CONFIG.port, CONFIG.host, async () => {
   console.log('==============================================');
   console.log(' sly-to-sticker — Dashboard & Control');
   console.log(` http://${CONFIG.host}:${CONFIG.port}`);
   console.log(` policy disconnect : ${CONFIG.disconnectPolicy}`);
   console.log(` auto-delete       : ${RUNTIME.autoDelete.enabled ? 'aktif' : 'mati'}`);
   console.log('==============================================');
   await engine.resumeIfPossible();
});

function shutdown() {
   console.log('\n[ENGINE] mematikan…');
   engine
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
   setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
