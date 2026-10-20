# sly-to-sticker — Dashboard & Control WhatsApp

Bot WhatsApp (Sticker.ly → sticker pack) dengan **dashboard web**, **pairing lewat web**, dan **auto-delete** pesan button/rich/interactive/payment.

## Struktur folder

```
├── index.js            # Entrypoint standalone: web server + engine WhatsApp
├── system/             # Modul backend
│   ├── config.js       # Konfigurasi pusat (password hanya dalam bentuk hash scrypt)
│   ├── auth.js         # Login scrypt + rate-limit/lockout + token sesi HMAC + CSRF
│   ├── http.js         # Helper HTTP (security headers, body limit, static map)
│   ├── wa.js           # Engine WhatsApp (pairing, session, disconnect policy)
│   ├── autoDelete.js   # Auto-delete pesan spam (button/rich/interactive/payment)
│   ├── engineClient.js # Klien engine remote (mode Vercel)
│   └── apiHandlers.js  # Router API bersama
├── web/                # Dashboard (login, pairing, kontrol) — vanilla JS, tanpa CDN
├── api/                # Handler serverless untuk Vercel (catch-all /api/*)
└── vercel.json         # Konfigurasi deploy Vercel
```

## Menjalankan (standalone — semua host Node)

```bash
npm install
npm start          # dashboard + engine di http://localhost:3000
```

Buka `http://<host>:3000`, login, masukkan nomor (format `628xxxx`), masukkan kode pairing di HP:
**WhatsApp → Perangkat tertaut → Tautkan perangkat → Tautkan dengan nomor telepon**.

> **Penting — soal Vercel:** koneksi WhatsApp memakai WebSocket yang harus hidup **24 jam**.
> Vercel serverless **tidak bisa** menampungnya. Maka:
> - **Engine** (`node index.js`) jalan di host yang selalu hidup: VPS, Railway, Render, Fly.io, Termux, atau PC.
> - **Dashboard** bisa di-deploy ke **Vercel** sebagai control plane yang memanggil engine.

## Deploy ke Vercel (dashboard)

1. Jalankan engine dulu di host persistent, catat `ENGINE_TOKEN` yang tercetak (atau isi env `ENGINE_TOKEN` sendiri).
2. `vercel deploy`, lalu set env:
   - `AUTH_SECRET` — rahasia token sesi (wajib, ≥16 karakter, acak)
   - `ENGINE_URL` — alamat engine, contoh `https://bot.example.com`
   - `ENGINE_TOKEN` — token mesin yang sama dengan engine
3. Buka URL Vercel → login → pairing & kontrol seperti biasa.

Di mode Vercel, login/logout ditangani Vercel; status/pairing/kontrol diteruskan ke engine.

## Perilaku saat terputus

- `DISCONNECT_POLICY=always` *(default, sesuai permintaan)* — **semua** disconnect →
  session **dihapus otomatis** dan dashboard **kembali ke halaman pairing**.
- `DISCONNECT_POLICY=auth` — hanya saat logout/session rusak yang menghapus session;
  putus jaringan biasa mencoba **auto-reconnect** (disarankan untuk operasional harian).

## Konfigurasi (env)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port web server |
| `WEB_PASSWORD` | `denji##123` | Password dashboard (ditimpa bila diisi) |
| `AUTH_SECRET` | dibuat otomatis di `data/auth-secret` | Rahasia token sesi — **wajib** di Vercel |
| `ENGINE_TOKEN` | dibuat otomatis di `data/engine-token` | Token akses mesin (Bearer) |
| `ENGINE_URL` | — | (Vercel) alamat engine |
| `DISCONNECT_POLICY` | `always` | `always` \| `auth` |
| `SESSION_DIR` | `./session` | Folder session WhatsApp (otomatis dihapus saat disconnect) |
| `DATA_DIR` | `./data` | Folder data/rahasia (tidak ikut dihapus) |
| `SESSION_TTL_SEC` | `28800` | Masa berlaku login web (8 jam) |

## Keamanan login web

- Password disimpan sebagai **hash scrypt** (salt acak, N=16384) — plaintext tidak pernah ada di kode/disk.
- Perbandingan **timing-safe**; pesan error generik; jeda minimal tiap percobaan login.
- **Rate limit + lockout eskalatif**: 5 gagal → terkunci 5 menit, 10 → 1 jam, 20 → 24 jam,
  plus kunci global anti brute-force dari banyak IP.
- Token sesi **HMAC-SHA256** bertanda tangan + masa berlaku; cookie `HttpOnly; SameSite=Strict; Secure`.
- **CSRF**: cek `Origin` + wajib header `X-Requested-With` (memblokir form-CSRF klasik).
- **CSP** kencang, `X-Frame-Options: DENY`, tanpa CDN/eksternal, body JSON dibatasi 8 KB.
- Path sensitif (`/system`, `/data`, `/session`) tidak pernah dilayani (di Vercel diblokir via redirect).
- Ganti password default lewat env `WEB_PASSWORD`; ganti `AUTH_SECRET`/`ENGINE_TOKEN` bila perlu.

## API (ringkas)

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| POST | `/api/login` | — | Login (body: `{password}`) |
| POST | `/api/logout` | cookie | Hapus sesi login |
| GET | `/api/health` | — | Cek kesehatan |
| GET | `/api/status` | ✔ | Status koneksi + auto-delete |
| POST | `/api/pair` | ✔ | `{number}` → kode pairing (`{number, refresh:true}` = kode baru) |
| POST | `/api/control` | ✔ | `{action}`: `restart` \| `wipe` \| `logout` \| `cancel` |
| GET/POST | `/api/config` | ✔ | Baca/ubah pengaturan auto-delete |

Auth = cookie sesi web **atau** `Authorization: Bearer <ENGINE_TOKEN>` (untuk Vercel/CLI).
