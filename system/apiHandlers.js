/**
 * system/apiHandlers.js — Router API bersama (standalone & Vercel)
 *
 * Semua endpoint (kecuali /api/health & /api/login) butuh autentikasi:
 * token sesi web (header X-Session-Token / cookie) ATAU Bearer ENGINE_TOKEN.
 */
import {
   verifyPassword, checkLoginAllowed, recordLoginFailure, recordLoginSuccess,
   checkApiRate, bumpApiRate, issueSession, revokeSession, extractSessionToken,
   buildSessionCookie, buildClearCookie, authStatus, sameOriginOk,
} from './auth.js';
import { sendJson } from './http.js';
import { CONFIG } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createApiRouter({ engine, statefulAuth = true }) {
   return async function route(req, res) {
      const ip = req.ip;
      const { method, pathname } = req;

      // Rate limit umum
      const rate = checkApiRate(ip);
      if (!rate.ok) {
         return sendJson(res, 429, { ok: false, error: 'Terlalu banyak permintaan', retryAfter: rate.retryAfter }, {
            'Retry-After': String(rate.retryAfter),
         });
      }
      bumpApiRate(ip);

      // Body sudah diparsing oleh host (standalone / Vercel); null = JSON tidak valid
      const body = method === 'POST' ? req.body : null;
      if (method === 'POST' && body === null) {
         return sendJson(res, 400, { ok: false, error: 'Body JSON tidak valid' });
      }

      // ---------- publik ----------
      if (pathname === '/api/health') {
         return sendJson(res, 200, { ok: true, ts: Date.now() });
      }

      if (pathname === '/api/login' && method === 'POST') {
         if (!sameOriginOk(req, false)) return sendJson(res, 403, { ok: false, error: 'Ditolak (origin)' });
         const allowed = checkLoginAllowed(ip);
         if (!allowed.ok) {
            return sendJson(res, 429, { ok: false, error: 'Terlalu banyak percobaan login. Coba lagi nanti.', retryAfter: allowed.retryAfter }, {
               'Retry-After': String(allowed.retryAfter),
            });
         }
         const t0 = Date.now();
         const ok = verifyPassword(body?.password);
         const elapsed = Date.now() - t0;
         if (elapsed < CONFIG.login.minDelayMs) await sleep(CONFIG.login.minDelayMs - elapsed);
         if (!ok) {
            recordLoginFailure(ip);
            return sendJson(res, 401, { ok: false, error: 'Password salah' });
         }
         recordLoginSuccess(ip);
         const { sid, exp } = issueSession();
         return sendJson(res, 200, { ok: true, token: sid, exp }, {
            'Set-Cookie': buildSessionCookie(sid, exp, req.https),
         });
      }

      if (pathname === '/api/logout' && method === 'POST') {
         const sid = extractSessionToken(req);
         if (sid) revokeSession(sid);
         return sendJson(res, 200, { ok: true }, {
            'Set-Cookie': buildClearCookie(req.https),
         });
      }

      // ---------- butuh autentikasi ----------
      const auth = authStatus(req);
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'Belum login' });

      if (pathname === '/api/auth' && method === 'GET') {
         return sendJson(res, 200, { ok: true, exp: auth.exp ?? null });
      }

      if (auth.via === 'cookie' && method === 'POST' && !sameOriginOk(req, false)) {
         return sendJson(res, 403, { ok: false, error: 'Ditolak (origin)' });
      }

      if (pathname === '/api/status' && method === 'GET') {
         const st = await engine.status();
         if (statefulAuth === false && !st.ok) return sendJson(res, 502, st);
         return sendJson(res, 200, st);
      }

      if (pathname === '/api/pair' && method === 'POST') {
         const result = await engine.startPairing(body?.number, { refresh: body?.refresh === true });
         return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (pathname === '/api/control' && method === 'POST') {
         const action = String(body?.action || '');
         if (!/^[a-z-]{2,20}$/.test(action)) return sendJson(res, 400, { ok: false, error: 'Aksi tidak valid' });
         const result = await engine.control(action);
         return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (pathname === '/api/config' && method === 'GET') {
         return sendJson(res, 200, await engine.getConfig());
      }

      if (pathname === '/api/config' && method === 'POST') {
         return sendJson(res, 200, await engine.setConfig(body ?? {}));
      }

      return sendJson(res, 404, { ok: false, error: 'Endpoint tidak dikenal' });
   };
}
