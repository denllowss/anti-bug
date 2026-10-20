/**
 * api/[...path].js — Handler serverless Vercel (satu catch-all untuk /api/*)
 *
 * Di Vercel, koneksi WhatsApp TIDAK bisa berjalan (butuh proses permanen).
 * Handler ini menjadi "control plane": login + dashboard memanggil ENGINE
 * (node index.js di host persistent) lewat ENGINE_URL + ENGINE_TOKEN.
 *
 * Env yang dibutuhkan di Vercel:
 *   AUTH_SECRET   — rahasia token sesi (WAJIB, minimal 16 karakter)
 *   ENGINE_URL    — alamat engine, contoh https://bot.example.com
 *   ENGINE_TOKEN  — token mesin (sama dengan yang tercetak/dibuat engine)
 */
import { CONFIG } from '../system/config.js';
import { createApiRouter } from '../system/apiHandlers.js';
import { createRemoteEngine } from '../system/engineClient.js';
import { normalizeReq, readJsonBody, sendJson, applySecurityHeaders, isHttps } from '../system/http.js';

const engine = createRemoteEngine({
   baseUrl: process.env.ENGINE_URL || '',
   token: process.env.ENGINE_TOKEN || CONFIG.engineToken,
});
const route = createApiRouter({ engine, statefulAuth: false });

export default async function handler(req, res) {
   applySecurityHeaders(res, { https: isHttps(req) || true });
   try {
      const method = (req.method || 'GET').toUpperCase();
      let body = null;
      if (method === 'POST') {
         if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
            body = req.body;
         } else if (typeof req.body === 'string') {
            try {
               body = JSON.parse(req.body);
            } catch {
               body = null;
            }
         } else {
            body = await readJsonBody(req);
         }
      }
      const norm = normalizeReq(req, body);
      norm.raw = req;
      await route(norm, res);
   } catch (error) {
      console.error('[VERCEL API]', error?.message ?? error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Kesalahan server' });
   }
}
