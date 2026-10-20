/**
 * system/config.js — Konfigurasi pusat (tanpa import baileys, aman untuk Vercel)
 * Tidak menyimpan password plaintext — hanya hash scrypt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const IS_VERCEL = Boolean(process.env.VERCEL);
const DEFAULT_RUNTIME_DIR = IS_VERCEL ? '/tmp/anti-bug' : ROOT_DIR;

// ---------- Path ----------
export const PATHS = {
   session: process.env.SESSION_DIR || path.join(DEFAULT_RUNTIME_DIR, 'session'),
   data: process.env.DATA_DIR || path.join(DEFAULT_RUNTIME_DIR, 'data'),
   web: path.join(ROOT_DIR, 'web'),
};

function ensureDataDir() {
   try {
      fs.mkdirSync(PATHS.data, { recursive: true, mode: 0o700 });
   } catch {}
}

function loadOrCreateSecret(file, envName) {
   const fromEnv = process.env[envName];
   if (fromEnv && fromEnv.length >= 16) return fromEnv;

   // Di Vercel serverless tanpa env AUTH_SECRET/ENGINE_TOKEN manual:
   // turunkan kunci 256-bit deterministik dari identitas internal project Vercel
   // agar SEMUA instance & cold-start punya kunci HMAC yang SAMA (tidak mental ke login lagi).
   if (IS_VERCEL) {
      const seed = [
         'anti-bug-vercel-secret-v1',
         file,
         process.env.VERCEL_PROJECT_ID || '',
         process.env.VERCEL_ORG_ID || '',
         process.env.VERCEL_GIT_REPO_ID || '',
         process.env.WEB_PASSWORD || DEFAULT_PASSWORD_HASH.hash,
      ].join('|');
      return crypto.scryptSync(seed, `salt:${file}:anti-bug-v1`, 32).toString('hex');
   }

   ensureDataDir();
   const p = path.join(PATHS.data, file);
   try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v.length >= 32) return v;
   } catch {}
   const v = crypto.randomBytes(32).toString('hex');
   try {
      fs.writeFileSync(p, v, { mode: 0o600 });
   } catch {}
   return v;
}

// ---------- Password web ----------
// Hash scrypt dari password default "denji##123" — plaintext TIDAK disimpan.
// Timpa dengan env WEB_PASSWORD untuk mengganti password.
export const DEFAULT_PASSWORD_HASH = {
   salt: '0b2bb2019fb9cd1188ea1ce507578f63',
   hash: '96f7c58e6a44376653cc234cf3e4c85b0e8b2364c2f45a5f604cf81e86f987c32a91ecbf0a65ca1434ce3cab27e9cd34b927a14ba4666ffae08d228abd37ef68',
   params: { N: 16384, r: 8, p: 1, keylen: 64 },
};

// ---------- Auto-delete (dari modul sebelumnya) ----------
export const DEFAULT_AUTO_DELETE = {
   enabled: true,
   mode: 'forMe', // 'forMe' | 'forEveryone'
   includeOwn: true,
   scope: 'private', // 'private' | 'all'
   processHistory: false,
   types: [
      'buttonsMessage', 'buttonsResponseMessage', 'templateMessage', 'templateButtonReplyMessage',
      'listMessage', 'listResponseMessage',
      'interactiveMessage', 'interactiveResponseMessage', 'highlyStructuredMessage', 'productMessage',
      'richResponseMessage',
      'paymentInviteMessage', 'requestPaymentMessage', 'cancelPaymentRequestMessage',
      'declinePaymentRequestMessage', 'sendPaymentMessage', 'orderMessage', 'invoiceMessage', 'paymentMessage',
   ],
};

const AUTO_DELETE_KEYS = ['enabled', 'mode', 'includeOwn', 'scope', 'processHistory', 'types'];

function readJsonSafe(p) {
   try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
   } catch {
      return null;
   }
}

function writeJsonSafe(p, obj) {
   ensureDataDir();
   fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

// ---------- Config runtime (auto-delete bisa diubah dari dashboard) ----------
const overridesPath = () => path.join(PATHS.data, 'config.json');

function loadAutoDelete() {
   const saved = readJsonSafe(overridesPath());
   const cfg = { ...DEFAULT_AUTO_DELETE };
   if (saved && typeof saved === 'object') {
      for (const k of AUTO_DELETE_KEYS) {
         if (saved[k] !== undefined) cfg[k] = saved[k];
      }
   }
   if (!Array.isArray(cfg.types) || cfg.types.length === 0) cfg.types = [...DEFAULT_AUTO_DELETE.types];
   return cfg;
}

export const RUNTIME = {
   autoDelete: loadAutoDelete(),
};

export function patchAutoDelete(patch) {
   if (!patch || typeof patch !== 'object') return RUNTIME.autoDelete;
   for (const k of AUTO_DELETE_KEYS) {
      if (patch[k] === undefined) continue;
      if (k === 'types') {
         if (Array.isArray(patch[k])) RUNTIME.autoDelete.types = patch[k].filter(t => typeof t === 'string');
      } else if (k === 'mode') {
         if (['forMe', 'forEveryone'].includes(patch[k])) RUNTIME.autoDelete[k] = patch[k];
      } else if (k === 'scope') {
         if (['private', 'all'].includes(patch[k])) RUNTIME.autoDelete[k] = patch[k];
      } else if (k === 'processHistory' || k === 'enabled' || k === 'includeOwn') {
         RUNTIME.autoDelete[k] = !!patch[k];
      }
   }
   try {
      writeJsonSafe(overridesPath(), RUNTIME.autoDelete);
   } catch {}
   return RUNTIME.autoDelete;
}

// ---------- Konfigurasi utama ----------
export const CONFIG = {
   port: Number(process.env.PORT) || 3000,
   host: process.env.HOST || '0.0.0.0',

   // Rahasia sesi login web (HMAC token). Di Vercel WAJIB set env AUTH_SECRET agar
   // konsisten antar serverless instance.
   authSecret: loadOrCreateSecret('auth-secret', 'AUTH_SECRET'),

   // Token mesin: dipakai dashboard-Vercel untuk bicara ke engine (Bearer).
   engineToken: loadOrCreateSecret('engine-token', 'ENGINE_TOKEN'),

   // Masa berlaku sesi login (detik)
   sessionTtlSec: Number(process.env.SESSION_TTL_SEC) || 8 * 3600,

   // Kebijakan saat koneksi WhatsApp terputus:
   //  'always' = SEMUA disconnect -> hapus session + kembali ke halaman pairing
   //  'auth'   = hanya saat logout/session rusak -> hapus session; sisanya auto-reconnect
   disconnectPolicy: process.env.DISCONNECT_POLICY === 'auth' ? 'auth' : 'always',

   // Rate limit login
   login: {
      windowSec: 15 * 60,
      ladder: [
         { fails: 5, lockSec: 5 * 60 },
         { fails: 10, lockSec: 60 * 60 },
         { fails: 20, lockSec: 24 * 60 * 60 },
      ],
      globalMaxFails: 40, // total percobaan gagal semua IP dalam window
      globalLockSec: 10 * 60,
      minDelayMs: 300, // jeda minimal tiap percobaan (perlambat brute force)
   },

   // Rate limit umum untuk seluruh /api
   api: {
      windowSec: 60,
      maxReq: 120,
   },
};

export function passwordSpec() {
   if (process.env.WEB_PASSWORD && process.env.WEB_PASSWORD.length >= 6) {
      return { custom: process.env.WEB_PASSWORD };
   }
   return { default: DEFAULT_PASSWORD_HASH };
}
