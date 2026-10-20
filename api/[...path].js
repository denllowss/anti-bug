/**
 * api/[...path].js — Handler serverless Vercel (catch-all /api/*)
 *
 * Mendukung 2 mode otomatis:
 *   1. Jika env ENGINE_URL diset -> proxy ke engine persistent (VPS/Railway/Render)
 *   2. Jika env ENGINE_URL kosong -> jalankan WAEngine langsung di container warm
 *      Vercel (/tmp/anti-bug/session) sehingga login, pairing code & kontrol
 *      langsung berfungsi tanpa wajib setup server tambahan terlebih dahulu.
 */
import { CONFIG } from '../system/config.js';
import { createApiRouter } from '../system/apiHandlers.js';
import { createRemoteEngine } from '../system/engineClient.js';
import { WAEngine } from '../system/wa.js';
import { normalizeReq, readJsonBody, sendJson, applySecurityHeaders, isHttps } from '../system/http.js';

function getEngine() {
   if (process.env.ENGINE_URL) {
      return createRemoteEngine({
         baseUrl: process.env.ENGINE_URL,
         token: process.env.ENGINE_TOKEN || CONFIG.engineToken,
      });
   }
   if (!globalThis.__antiBugWaEngine) {
      const e = new WAEngine();
      e.resumeIfPossible().catch(() => {});
      globalThis.__antiBugWaEngine = e;
   }
   return globalThis.__antiBugWaEngine;
}

const route = createApiRouter({
   engine: getEngine(),
   statefulAuth: false,
});

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
