/**
 * system/wa.js — Engine WhatsApp (hanya dipakai di host persistent, TIDAK di Vercel)
 *
 * - Pairing lewat web: startPairing(number) -> kode pairing
 * - Kebijakan disconnect: 'always' (hapus session + balik ke pairing) atau 'auth'
 * - Auto-delete pesan spam dipasang otomatis ke tiap socket
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import pino from 'pino';
import { CONFIG, PATHS, RUNTIME, patchAutoDelete } from './config.js';
import { attachAutoDelete } from './autoDelete.js';

const logger = pino({ level: 'silent' });

// Kode disconnect yang berarti session sudah tidak valid (harus pairing ulang)
const AUTH_FAIL_CODES = new Set([
   DisconnectReason.loggedOut, // 401
   DisconnectReason.badSession, // 500
   DisconnectReason.multideviceMismatch, // 411
   DisconnectReason.forbidden, // 403
]);

function formatCode(code) {
   if (!code) return null;
   return code.match(/.{1,4}/g)?.join('-') ?? code;
}

function sanitizeNumber(input) {
   const digits = String(input || '').replace(/\D/g, '');
   if (digits.length < 8 || digits.length > 15) return null;
   return digits;
}

export class WAEngine extends EventEmitter {
   constructor() {
      super();
      this.state = 'idle'; // idle | pairing | connecting | connected | needsPairing | disconnected | error
      this.sock = null;
      this.jid = null;
      this.number = null;
      this.pairingCode = null;
      this.pairingExpiresAt = null;
      this.lastError = null;
      this.message = 'Siap. Masukkan nomor untuk memulai pairing.';
      this.startedAt = Date.now();
      this._intentionalClose = false;
      this._pairingRequested = false;
      this._pairingInFlight = null;
      this._generation = 0;
      this._detachAutoDelete = null;
      this._reconnectTimer = null;
      this._reconnectTries = 0;
      this._shuttingDown = false;
   }

   status() {
      return {
         ok: true,
         state: this.state,
         jid: this.jid,
         number: this.number,
         pairingCode: this.pairingCode,
         pairingExpiresAt: this.pairingExpiresAt,
         message: this.message,
         lastError: this.lastError,
         uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
         disconnectPolicy: CONFIG.disconnectPolicy,
         autoDelete: RUNTIME.autoDelete,
         now: Math.floor(Date.now() / 1000),
      };
   }

   getConfig() {
      return {
         ok: true,
         autoDelete: RUNTIME.autoDelete,
         disconnectPolicy: CONFIG.disconnectPolicy,
         sessionExists: fs.existsSync(path.join(PATHS.session, 'creds.json')),
      };
   }

   setConfig(patch) {
      const autoDelete = patchAutoDelete(patch?.autoDelete);
      return { ok: true, autoDelete, disconnectPolicy: CONFIG.disconnectPolicy };
   }

   _setState(state, message) {
      this.state = state;
      if (message) this.message = message;
      this.emit('state', this.status());
   }

   _wipeSession() {
      this._generation += 1;
      try {
         fs.rmSync(PATHS.session, { recursive: true, force: true });
      } catch {}
      try {
         fs.mkdirSync(PATHS.session, { recursive: true, mode: 0o700 });
      } catch {}
      this.pairingCode = null;
      this.pairingExpiresAt = null;
   }

   async _teardownSocket() {
      this._intentionalClose = true;
      this._generation += 1;
      this._detachAutoDelete?.();
      this._detachAutoDelete = null;
      const s = this.sock;
      this.sock = null;
      if (s) {
         try {
            s.ev?.removeAllListeners?.('connection.update');
            s.ev?.removeAllListeners?.('creds.update');
            s.end?.(undefined);
            s.ws?.close?.();
         } catch {}
      }
   }

   /** Mulai pairing baru: bersihkan session lama, minta kode pairing untuk nomor tsb */
   async startPairing(numberInput, { refresh = false } = {}) {
      if (this._shuttingDown) return { ok: false, error: 'Engine sedang dimatikan' };
      const number = sanitizeNumber(numberInput);
      if (!number) return { ok: false, error: 'Nomor tidak valid. Gunakan format internasional, contoh: 6281234567890' };

      // Refresh kode pada socket yang sudah berjalan (tanpa hapus session)
      if (refresh && this.sock && this.state === 'pairing' && this.number === number) {
         return this._requestPairingCode();
      }

      await this._teardownSocket();
      this._wipeSession(); // selalu mulai dari keadaan bersih
      this.number = number;
      this._pairingRequested = false;
      this.jid = null;
      this.lastError = null;
      this._reconnectTries = 0;
      this._setState('pairing', 'Meminta kode pairing…');

      const { state, saveCreds } = await useMultiFileAuthState(PATHS.session);
      const sock = makeWASocket({
         auth: state,
         logger,
         markOnlineOnConnect: false,
      });
      this.sock = sock;
      this._intentionalClose = false;

      sock.ev.on('creds.update', saveCreds);
      this._detachAutoDelete = attachAutoDelete(sock);

      sock.ev.on('connection.update', update => {
         this._onConnectionUpdate(update).catch(e => console.error('[ENGINE]', e?.message ?? e));
      });

      // Kode diminta saat socket mulai 'connecting' (pola resmi Baileys pairing code)
      // sekaligus ditunggu di sini supaya langsung dikirim ke dashboard (maks 2 attempt)
      for (let i = 0; i < 2 && this.state === 'pairing' && !this.pairingCode; i++) {
         const r = await this._requestPairingCode();
         if (r.ok || this.state !== 'pairing') break;
      }

      return {
         ok: true,
         state: this.state,
         pairingCode: this.pairingCode,
         message: this.message,
      };
   }

   async _requestPairingCode() {
      if (this._pairingInFlight) return this._pairingInFlight;
      this._pairingInFlight = this._doRequestCode().finally(() => {
         this._pairingInFlight = null;
      });
      return this._pairingInFlight;
   }

   async _doRequestCode() {
      const sock = this.sock;
      const gen = this._generation;
      if (!sock) return { ok: false, error: 'Socket belum siap' };
      try {
         // Beri jeda sejenak setelah socket 'connecting' (pola resmi Baileys: delay(1500))
         await new Promise(r => setTimeout(r, 1500));
         if (gen !== this._generation || this.sock !== sock) return { ok: false, error: 'Dibatalkan' };
         // Timeout 15 detik — requestPairingCode bisa menggantung kalau koneksi
         // ke server WhatsApp bermasalah; jangan sampai memblokir API.
         const code = await Promise.race([
            sock.requestPairingCode(this.number),
            new Promise((_, reject) =>
               setTimeout(() => reject(new Error('Timeout meminta kode pairing (15s)')), 15000)
            ),
         ]);
         // Hasil basi (session sudah dihapus / socket sudah diganti) -> buang
         if (gen !== this._generation || this.sock !== sock || this.state !== 'pairing') {
            return { ok: false, error: 'Dibatalkan' };
         }
         this._pairingRequested = true;
         this.pairingCode = formatCode(code);
         this.pairingExpiresAt = Math.floor(Date.now() / 1000) + 300;
         this._setState('pairing', 'Kode pairing siap. Buka WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.');
         return { ok: true, pairingCode: this.pairingCode };
      } catch (error) {
         if (gen !== this._generation) return { ok: false, error: 'Dibatalkan' };
         this.lastError = error?.message ?? String(error);
         if (this.state === 'pairing') this._setState('pairing', 'Gagal meminta kode pairing. Coba lagi.');
         return { ok: false, error: this.lastError };
      }
   }

   async _onConnectionUpdate(update) {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'connecting' && this.state === 'pairing' && !this._pairingRequested) {
         await this._requestPairingCode();
      }

      // Fallback: kalau WA mengirim QR event, tetap andalkan pairing code
      if (qr && this.state === 'pairing' && !this._pairingRequested) {
         await this._requestPairingCode();
      }

      if (connection === 'open') {
         this.jid = this.sock?.user?.id ?? null;
         if (this.number && this.jid && !this.jid.startsWith(this.number.split(':')[0])) {
            // nomor di device berbeda dari input — tetap lanjut, catat
         }
         this._reconnectTries = 0;
         this.pairingCode = null;
         this.pairingExpiresAt = null;
         this._setState('connected', `Terhubung sebagai ${this.jid ?? 'akun'}`);
         try {
            this.sock?.sendPresenceUpdate('unavailable');
         } catch {}
      }

      if (connection === 'close') {
         if (this._intentionalClose || this._shuttingDown) return;

         const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
         const errText = lastDisconnect?.error?.message ?? 'unknown';
         this.lastError = `${errText}${statusCode ? ` (${statusCode})` : ''}`;

         const authFail = AUTH_FAIL_CODES.has(statusCode) || /logged.?out|bad.?session|replaced/i.test(errText);
         const policy = CONFIG.disconnectPolicy;

         if (policy === 'always' || authFail) {
            // Permintaan: terputus -> hapus session -> kembali ke halaman pairing
            this._wipeSession();
            this.number = null;
            this.jid = null;
            this._pairingRequested = false;
            this._setState('needsPairing', 'Koneksi terputus. Session dihapus — silakan pairing ulang dari halaman web.');
            return;
         }

         // Kebijakan 'auth' & putus biasa: coba sambung ulang dengan backoff
         this._setState('disconnected', `Koneksi terputus (${this.lastError}). Menyambung ulang…`);
         this._scheduleReconnect();
      }
   }

   _scheduleReconnect() {
      if (this._reconnectTimer || this._shuttingDown) return;
      const backoff = [3000, 8000, 20000, 60000];
      const wait = backoff[Math.min(this._reconnectTries, backoff.length - 1)];
      this._reconnectTries += 1;
      this._reconnectTimer = setTimeout(async () => {
         this._reconnectTimer = null;
         if (this._shuttingDown) return;
         if (this._reconnectTries > backoff.length) {
            this._setState('disconnected', 'Gagal menyambung ulang. Gunakan tombol Sambung Ulang di dashboard.');
            return;
         }
         await this.reconnect();
      }, wait);
   }

   /** Sambung ulang memakai session yang ada (tanpa hapus session) */
   async reconnect() {
      if (this._shuttingDown) return { ok: false, error: 'Engine sedang dimatikan' };
      const credsPath = path.join(PATHS.session, 'creds.json');
      if (!fs.existsSync(credsPath)) {
         this._setState('needsPairing', 'Tidak ada session. Silakan pairing dari halaman web.');
         return { ok: false, error: 'Tidak ada session' };
      }
      await this._teardownSocket();
      this._pairingRequested = false;
      this._setState('connecting', 'Menyambungkan…');

      const { state, saveCreds } = await useMultiFileAuthState(PATHS.session);
      const sock = makeWASocket({ auth: state, logger, markOnlineOnConnect: false });
      this.sock = sock;
      this._intentionalClose = false;
      sock.ev.on('creds.update', saveCreds);
      this._detachAutoDelete = attachAutoDelete(sock);
      sock.ev.on('connection.update', update => {
         this._onConnectionUpdate(update).catch(e => console.error('[ENGINE]', e?.message ?? e));
      });
      return { ok: true, state: this.state };
   }

   /** Aksi kontrol dari dashboard */
   async control(action) {
      switch (action) {
         case 'restart':
         case 'reconnect':
            if (fs.existsSync(path.join(PATHS.session, 'creds.json'))) {
               await this.reconnect();
               return { ok: true, state: this.state };
            }
            this._wipeSession();
            this._setState('needsPairing', 'Tidak ada session — silakan pairing ulang.');
            return { ok: true, state: this.state };

         case 'wipe':
            await this._teardownSocket();
            this._wipeSession();
            this.number = null;
            this.jid = null;
            this._pairingRequested = false;
            this._setState('needsPairing', 'Session dihapus. Silakan pairing dari halaman web.');
            return { ok: true, state: this.state };

         case 'logout':
            await this._teardownSocket();
            this._wipeSession();
            this.number = null;
            this.jid = null;
            this._pairingRequested = false;
            this._setState('needsPairing', 'Logout berhasil. Session dihapus — halaman pairing siap.');
            return { ok: true, state: this.state };

         case 'cancel':
            await this._teardownSocket();
            this._pairingRequested = false;
            this.pairingCode = null;
            this._wipeSession();
            this._setState('needsPairing', 'Dibatalkan. Silakan mulai pairing baru.');
            return { ok: true, state: this.state };

         default:
            return { ok: false, error: `Aksi tidak dikenal: ${action}` };
      }
   }

   /** Dipanggil saat boot: sambung ulang otomatis bila session masih ada */
   async resumeIfPossible() {
      const credsPath = path.join(PATHS.session, 'creds.json');
      if (fs.existsSync(credsPath)) {
         await this.reconnect();
      } else {
         this._setState('needsPairing', 'Belum ada session. Buka halaman web untuk pairing.');
      }
   }

   async close() {
      this._shuttingDown = true;
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      await this._teardownSocket();
   }
}

export function createLocalEngine() {
   return new WAEngine();
}
