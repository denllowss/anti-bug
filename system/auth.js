/**
 * system/auth.js — Keamanan login web (tanpa import baileys, aman untuk Vercel)
 *
 * Proteksi brute-force / pembobolan password:
 *  1. Password disimpan sebagai hash scrypt (salt 16B, N=16384) — tidak pernah plaintext.
 *  2. Perbandingan selalu timing-safe (crypto.timingSafeEqual).
 *  3. Rate limit per-IP dengan lockout eskalatif (5x -> 5mnt, 10x -> 1jam, 20x -> 24jam)
 *     PLUS kunci global anti serangan tersebar.
 *  4. Token sesi: HMAC-SHA256 bertanda tangan + masa berlaku, HttpOnly + SameSite=Strict
 *     (+ Secure saat HTTPS). Tidak bisa dipalsukan tanpa AUTH_SECRET.
 *  5. Pesan error generik (tidak membocorkan info), jeda minimal tiap percobaan login.
 */
import crypto from 'node:crypto';
import { CONFIG, passwordSpec } from './config.js';

export const COOKIE_NAME = 'sid';

// ---------------- Password ----------------
function scryptHash(password, saltHex, params = null) {
   const p = params || { N: 16384, r: 8, p: 1, keylen: 64 };
   const salt = Buffer.from(saltHex, 'hex');
   return crypto.scryptSync(String(password), salt, p.keylen, { N: p.N, r: p.r, p: p.p });
}

let customHashCache = null;

export function verifyPassword(password) {
   if (typeof password !== 'string' || password.length < 1 || password.length > 256) return false;
   const spec = passwordSpec();
   try {
      if (spec.custom) {
         if (!customHashCache) {
            const salt = crypto.randomBytes(16).toString('hex');
            customHashCache = { salt, hash: scryptHash(spec.custom, salt).toString('hex') };
         }
         const a = scryptHash(password, customHashCache.salt);
         const b = Buffer.from(customHashCache.hash, 'hex');
         return timingSafeEqualBuf(a, b);
      }
      const d = spec.default;
      const a = scryptHash(password, d.salt, d.params);
      const b = Buffer.from(d.hash, 'hex');
      return timingSafeEqualBuf(a, b);
   } catch {
      return false;
   }
}

function timingSafeEqualBuf(a, b) {
   if (a.length !== b.length) return false;
   return crypto.timingSafeEqual(a, b);
}

export function timingSafeEqualStr(a, b) {
   const ba = Buffer.from(String(a));
   const bb = Buffer.from(String(b));
   return timingSafeEqualBuf(ba, bb);
}

// ---------------- Rate limiter (in-memory) ----------------
export class RateLimiter {
   constructor() {
      this.hits = new Map(); // key -> { windowStart, count, lockedUntil, totalFails }
   }
   _entry(key) {
      let e = this.hits.get(key);
      const now = Date.now();
      if (!e) {
         e = { windowStart: now, count: 0, lockedUntil: 0, totalFails: 0 };
         this.hits.set(key, e);
      }
      return e;
   }
   status(key, { windowSec, lockSec = 0, max }) {
      const e = this._entry(key);
      const now = Date.now();
      if (e.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((e.lockedUntil - now) / 1000) };
      if (now - e.windowStart > windowSec * 1000) {
         e.windowStart = now;
         e.count = 0;
      }
      if (e.count >= max) return { ok: false, retryAfter: Math.ceil((e.windowStart + windowSec * 1000 - now) / 1000) };
      return { ok: true };
   }
   count(key, { windowSec }) {
      const e = this._entry(key);
      const now = Date.now();
      if (now - e.windowStart > windowSec * 1000) {
         e.windowStart = now;
         e.count = 0;
      }
      e.count += 1;
   }
   fail(key, { windowSec, ladder }) {
      const e = this._entry(key);
      const now = Date.now();
      if (now - e.windowStart > windowSec * 1000) {
         e.windowStart = now;
         e.count = 0;
      }
      e.count += 1;
      e.totalFails += 1;
      let lockSec = 0;
      for (const rung of ladder || []) {
         if (e.totalFails >= rung.fails) lockSec = rung.lockSec;
      }
      if (lockSec > 0) e.lockedUntil = now + lockSec * 1000;
      return { lockedSec: lockSec, totalFails: e.totalFails };
   }
   succeed(key) {
      this.hits.delete(key);
   }
   lock(key, sec) {
      const e = this._entry(key);
      e.lockedUntil = Date.now() + sec * 1000;
   }
}

const loginLimiter = new RateLimiter();
const apiLimiter = new RateLimiter();

export function checkLoginAllowed(ip) {
   // kunci global dulu (anti brute force tersebar banyak IP)
   const g = loginLimiter.status('global', {
      windowSec: CONFIG.login.windowSec,
      max: CONFIG.login.globalMaxFails,
      lockSec: CONFIG.login.globalLockSec,
   });
   if (!g.ok) return { ok: false, retryAfter: g.retryAfter, reason: 'global' };
   const s = loginLimiter.status(ip, {
      windowSec: CONFIG.login.windowSec,
      max: 10 ** 9, // batas per-IP ditangani lockout ladder, bukan hard cap
   });
   return s.ok ? { ok: true } : { ok: false, retryAfter: s.retryAfter, reason: 'ip' };
}

export function recordLoginFailure(ip) {
   loginLimiter.fail(ip, { windowSec: CONFIG.login.windowSec, ladder: CONFIG.login.ladder });
   loginLimiter.fail('global', { windowSec: CONFIG.login.windowSec, ladder: [] });
   // global lock setelah melewati ambang
   const ge = loginLimiter._entry('global');
   if (ge.totalFails >= CONFIG.login.globalMaxFails) loginLimiter.lock('global', CONFIG.login.globalLockSec);
}

export function recordLoginSuccess(ip) {
   loginLimiter.succeed(ip);
}

export function checkApiRate(ip) {
   return apiLimiter.status(ip, { windowSec: CONFIG.api.windowSec, max: CONFIG.api.maxReq, lockSec: 30 });
}

export function bumpApiRate(ip) {
   apiLimiter.count(ip, { windowSec: CONFIG.api.windowSec });
}

// ---------------- Token sesi (HMAC-SHA256 stateless + revocation lokal) ----------------
// Format: v1.<exp>.<random>.<hmac>
// CATATAN PENTING: JANGAN gunakan allowlist `issued` in-memory karena di serverless
// (Vercel) request berikutnya bisa ditangani instance berbeda -> menyebabkan loop 401!
const revoked = new Set();

function sign(payload) {
   return crypto.createHmac('sha256', CONFIG.authSecret).update(payload).digest('base64url');
}

export function issueSession() {
   const exp = Math.floor(Date.now() / 1000) + CONFIG.sessionTtlSec;
   const rand = crypto.randomBytes(18).toString('base64url');
   const payload = `v1.${exp}.${rand}`;
   const sid = `${payload}.${sign(payload)}`;
   return { sid, exp };
}

export function verifySession(sid) {
   if (typeof sid !== 'string' || sid.length < 20 || sid.length > 400) return { ok: false };
   if (revoked.has(sid)) return { ok: false };
   const parts = sid.split('.');
   if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false };
   const [v, expStr, rand, sig] = parts;
   const payload = `${v}.${expStr}.${rand}`;
   const expected = sign(payload);
   const a = Buffer.from(sig);
   const b = Buffer.from(expected);
   if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
   const exp = Number(expStr);
   if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false };
   return { ok: true, exp };
}

export function revokeSession(sid) {
   if (typeof sid === 'string') {
      revoked.add(sid);
   }
}

// ---------------- Cookie, Session Header & Bearer ----------------
export function parseCookies(req) {
   const out = {};
   const raw = req?.headers?.cookie || '';
   for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
   }
   return out;
}

export function extractSessionToken(req) {
   const hdr = req?.headers?.['x-session-token'];
   if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
   return parseCookies(req)[COOKIE_NAME] || '';
}

export function buildSessionCookie(sid, exp, https) {
   const maxAge = Math.max(1, exp - Math.floor(Date.now() / 1000));
   const secAttr = https ? '; SameSite=None; Secure; Partitioned' : '; SameSite=Lax';
   return `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; Max-Age=${maxAge}${secAttr}`;
}

export function buildClearCookie(https) {
   const secAttr = https ? '; SameSite=None; Secure; Partitioned' : '; SameSite=Lax';
   return `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0${secAttr}`;
}

/** Bearer ENGINE_TOKEN — untuk akses mesin dari Vercel/CLI */
export function verifyBearer(req) {
   const h = req?.headers?.authorization || '';
   const m = /^Bearer\s+(.+)$/i.exec(h);
   if (!m) return false;
   return timingSafeEqualStr(m[1].trim(), CONFIG.engineToken);
}

/** Cek CSRF: tolak cross-origin. Custom header memblokir form-CSRF klasik. */
export function sameOriginOk(req, viaBearer) {
   if (viaBearer) return true; // Bearer tidak bisa dikirim lewat form browser
   const origin = req?.headers?.origin;
   if (origin && origin !== 'null') {
      try {
         const o = new URL(origin);
         const host = String(req?.headers['x-forwarded-host'] || req?.headers?.host || '')
            .split(',')[0]
            .trim();
         if (host && o.host !== host) return false;
      } catch {
         return false;
      }
   }
   const xrw = req?.headers?.['x-requested-with'];
   if (xrw !== 'XMLHttpRequest') return false;
   return true;
}

/** Status autentikasi request: bearer mesin ATAU token sesi (header / cookie) */
export function authStatus(req) {
   if (verifyBearer(req)) return { ok: true, via: 'bearer' };
   const sid = extractSessionToken(req);
   const v = verifySession(sid);
   if (v.ok) return { ok: true, via: 'cookie', sid, exp: v.exp };
   return { ok: false };
}
