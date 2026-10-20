/**
 * system/http.js — Helper HTTP (aman untuk Vercel & standalone)
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
   '.html': 'text/html; charset=utf-8',
   '.js': 'text/javascript; charset=utf-8',
   '.css': 'text/css; charset=utf-8',
   '.svg': 'image/svg+xml',
   '.png': 'image/png',
   '.ico': 'image/x-icon',
   '.json': 'application/json; charset=utf-8',
   '.webp': 'image/webp',
};

export function isHttps(req) {
   const xf = (req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
   return xf === 'https' || !!req?.socket?.encrypted;
}

export function clientIp(req) {
   const xf = (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
   return xf || req?.socket?.remoteAddress || 'unknown';
}

export function applySecurityHeaders(res, { https } = {}) {
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('X-Frame-Options', 'DENY');
   res.setHeader('Referrer-Policy', 'no-referrer');
   res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
   res.setHeader('X-Robots-Tag', 'noindex, nofollow');
   res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
   );
   res.setHeader('Cache-Control', 'no-store');
   if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function sendJson(res, status, obj, extraHeaders = {}) {
   const body = JSON.stringify(obj);
   res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
   });
   res.end(body);
}

export function readJsonBody(req, limit = 8192) {
   return new Promise(resolve => {
      if (req.bodyAlreadyParsed !== undefined) return resolve(req.bodyAlreadyParsed);
      let size = 0;
      const chunks = [];
      let done = false;
      const finish = v => {
         if (done) return;
         done = true;
         resolve(v);
      };
      req.on('data', c => {
         size += c.length;
         if (size > limit) {
            finish(null);
            req.destroy();
            return;
         }
         chunks.push(c);
      });
      req.on('end', () => {
         if (done) return;
         const raw = Buffer.concat(chunks).toString('utf8');
         if (!raw) return finish({});
         try {
            const v = JSON.parse(raw);
            finish(v && typeof v === 'object' ? v : null);
         } catch {
            finish(null);
         }
      });
      req.on('error', () => finish(null));
   });
}

/** Normalisasi request untuk router API (dipakai server standalone & Vercel) */
export function normalizeReq(req, body) {
   let pathname = '/';
   try {
      const u = new URL(req.url || '/', 'http://localhost');
      pathname = u.pathname;
      if (pathname === '/api/[...path]' || pathname === '/api/%5B...path%5D') {
         const rawSeg =
            u.searchParams.get('path') ??
            u.searchParams.get('...path') ??
            req.query?.path ??
            req.query?.['...path'];
         const seg = Array.isArray(rawSeg) ? rawSeg.join('/') : (rawSeg || '');
         pathname = seg ? `/api/${String(seg).replace(/^\/+/, '')}` : '/api';
      }
   } catch {}
   return {
      method: (req.method || 'GET').toUpperCase(),
      pathname,
      headers: req.headers || {},
      ip: clientIp(req),
      https: isHttps(req),
      body: body ?? null,
   };
}

const STATIC_MAP = {
   '/': 'index.html',
   '/index.html': 'index.html',
   '/app.js': 'app.js',
   '/style.css': 'style.css',
};

/** Hanya file di peta statis yang boleh dilayani — sumber kode & data tidak pernah terekspos */
export function serveStatic(res, pathname, webRoot) {
   const name = STATIC_MAP[pathname];
   if (!name) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
   }
   const file = path.join(webRoot, name);
   try {
      const data = fs.readFileSync(file);
      res.writeHead(200, {
         'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
         'Content-Length': data.length,
         'Cache-Control': 'no-store',
      });
      res.end(data);
   } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
   }
}
