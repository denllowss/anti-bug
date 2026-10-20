/* sly-to-sticker — dashboard client */
(() => {
   const $ = id => document.getElementById(id);
   const views = { login: $('view-login'), pair: $('view-pair'), dash: $('view-dash') };

   let authed = false;
   let lastState = null;
   let pollTimer = null;

   // ---------- util ----------
   async function api(path, method = 'GET', body = null) {
      const res = await fetch(path, {
         method,
         headers: {
            'X-Requested-With': 'XMLHttpRequest',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
         },
         body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
   }

   function log(msg, cls = '') {
      const el = $('log');
      if (!el) return;
      const time = new Date().toLocaleTimeString('id-ID');
      const line = document.createElement('div');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = `[${time}] `;
      line.appendChild(t);
      if (cls) line.classList.add(cls);
      line.appendChild(document.createTextNode(msg));
      el.prepend(line);
      while (el.childNodes.length > 80) el.removeChild(el.lastChild);
   }

   function show(view) {
      for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== view);
      $('user-bar').classList.toggle('hidden', view === 'login');
   }

   function fmtUptime(sec) {
      if (!Number.isFinite(sec)) return '—';
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return `${h}j ${m}m ${s}s`;
   }

   // ---------- login ----------
   $('form-login').addEventListener('submit', async e => {
      e.preventDefault();
      $('login-error').textContent = '';
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const { status, data } = await api('/api/login', 'POST', { password: $('inp-password').value });
      btn.disabled = false;
      if (status === 200 && data?.ok) {
         authed = true;
         $('inp-password').value = '';
         log('Login berhasil', 'ok');
         startPolling();
      } else {
         $('login-error').textContent = data?.error || `Gagal login (${status})`;
      }
   });

   $('btn-eye').addEventListener('click', () => {
      const inp = $('inp-password');
      inp.type = inp.type === 'password' ? 'text' : 'password';
   });

   $('btn-logout').addEventListener('click', async () => {
      await api('/api/logout', 'POST', {});
      authed = false;
      stopPolling();
      show('login');
      log('Logout dari dashboard', 'warn');
   });

   // ---------- pairing ----------
   $('form-pair').addEventListener('submit', async e => {
      e.preventDefault();
      const number = $('inp-number').value.trim();
      localStorage.setItem('lastNumber', number);
      $('pair-status').textContent = 'Meminta kode pairing…';
      $('pair-code-box').classList.add('hidden');
      const { status, data } = await api('/api/pair', 'POST', { number });
      if (data?.ok && data?.pairingCode) {
         showPairCode(data.pairingCode);
         $('pair-status').textContent = data.message || 'Kode siap.';
         log(`Kode pairing dibuat untuk ${number}`, 'ok');
      } else if (data?.ok) {
         $('pair-status').textContent = 'Menyiapkan koneksi… kode akan muncul sebentar lagi.';
      } else {
         $('pair-status').textContent = '';
         $('login-error').textContent = '';
         log(`Pairing gagal: ${data?.error || status}`, 'err');
         $('pair-status').textContent = data?.error || 'Gagal membuat kode pairing.';
      }
   });

   $('btn-refresh-code').addEventListener('click', async () => {
      const number = $('inp-number').value.trim();
      $('pair-status').textContent = 'Memperbarui kode…';
      const { data } = await api('/api/pair', 'POST', { number, refresh: true });
      if (data?.ok && data?.pairingCode) {
         showPairCode(data.pairingCode);
         $('pair-status').textContent = 'Kode baru siap.';
         log('Kode pairing diperbarui', 'ok');
      } else {
         $('pair-status').textContent = data?.error || 'Gagal memperbarui kode.';
      }
   });

   $('btn-copy-code').addEventListener('click', async () => {
      const code = $('pair-code').textContent;
      try {
         await navigator.clipboard.writeText(code);
         $('pair-status').textContent = 'Kode disalin!';
      } catch {
         $('pair-status').textContent = 'Gagal menyalin — salin manual.';
      }
   });

   function showPairCode(code) {
      $('pair-code').textContent = code || '—';
      $('pair-code-box').classList.remove('hidden');
   }

   // ---------- kontrol ----------
   async function control(action, confirmMsg) {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      const { data } = await api('/api/control', 'POST', { action });
      if (data?.ok) {
         log(`Kontrol "${action}" dijalankan`, 'ok');
      } else {
         log(`Kontrol "${action}" gagal: ${data?.error || '?'}`, 'err');
      }
      refreshStatus();
   }

   $('btn-reconnect').addEventListener('click', () => control('restart', null));
   $('btn-wipe').addEventListener('click', () => control('wipe', 'Hapus session WhatsApp sekarang? Bot akan kembali ke halaman pairing.'));
   $('btn-logout-wa').addEventListener('click', () => control('logout', 'Logout WhatsApp & hapus session? Anda harus pairing ulang.'));

   // ---------- auto-delete ----------
   function fillAd(cfg) {
      if (!cfg) return;
      $('ad-enabled').checked = !!cfg.enabled;
      $('ad-own').checked = !!cfg.includeOwn;
      $('ad-history').checked = !!cfg.processHistory;
      $('ad-mode').value = cfg.mode === 'forEveryone' ? 'forEveryone' : 'forMe';
      $('ad-scope').value = cfg.scope === 'all' ? 'all' : 'private';
   }

   $('btn-save-ad').addEventListener('click', async () => {
      const patch = {
         autoDelete: {
            enabled: $('ad-enabled').checked,
            includeOwn: $('ad-own').checked,
            processHistory: $('ad-history').checked,
            mode: $('ad-mode').value,
            scope: $('ad-scope').value,
         },
      };
      const { data } = await api('/api/config', 'POST', patch);
      if (data?.ok) {
         fillAd(data.autoDelete);
         $('ad-status').textContent = 'Pengaturan tersimpan.';
         log('Pengaturan auto-delete disimpan', 'ok');
      } else {
         $('ad-status').textContent = data?.error || 'Gagal menyimpan.';
      }
   });

   // ---------- status polling ----------
   const STATE_LABEL = {
      idle: 'Siap',
      pairing: 'Menunggu pairing',
      connecting: 'Menyambungkan…',
      connected: 'Terhubung',
      needsPairing: 'Perlu pairing',
      disconnected: 'Terputus',
      error: 'Error',
   };

   async function refreshStatus() {
      const { status, data } = await api('/api/status');
      if (status === 401 || (status !== 200 && data?.error === 'Belum login')) {
         authed = false;
         stopPolling();
         show('login');
         return;
      }
      if (!data?.ok) {
         $('conn-pill').textContent = 'OFFLINE';
         $('conn-pill').className = 'pill pill-off';
         if (status === 502 || data?.error) log(`Status: ${data?.error || 'engine tidak terhubung'}`, 'err');
         return;
      }

      authed = true;
      const st = data.state;
      if (st !== lastState) {
         if (lastState !== null) log(`State: ${lastState} → ${st} — ${data.message || ''}`, st === 'connected' ? 'ok' : 'warn');
         lastState = st;
      }

      // pill
      const pill = $('conn-pill');
      if (st === 'connected') { pill.textContent = 'TERHUBUNG'; pill.className = 'pill pill-on'; }
      else if (st === 'pairing' || st === 'needsPairing' || st === 'connecting') { pill.textContent = (STATE_LABEL[st] || st).toUpperCase(); pill.className = 'pill pill-pair'; }
      else { pill.textContent = (STATE_LABEL[st] || st).toUpperCase(); pill.className = 'pill pill-off'; }

      // view routing — saat terputus & perlu pairing, otomatis kembali ke halaman pairing
      if (st === 'needsPairing' || st === 'idle') {
         show('pair');
         $('pair-status').textContent = data.message || '';
      } else if (st === 'pairing') {
         show('pair');
         if (data.pairingCode) showPairCode(data.pairingCode);
         $('pair-status').textContent = data.message || '';
         if (data.number) $('inp-number').value = data.number;
      } else {
         show('dash');
      }

      // isi panel dashboard
      $('st-state').textContent = STATE_LABEL[st] || st;
      $('st-jid').textContent = data.jid || '—';
      $('st-number').textContent = data.number || '—';
      $('st-uptime').textContent = fmtUptime(data.uptimeSec);
      $('st-message').textContent = data.message || '';
      $('st-error').textContent = data.lastError ? `Error terakhir: ${data.lastError}` : '';
      if (!document.querySelector('#ad-mode:focus, #ad-scope:focus, #ad-enabled:focus, #ad-own:focus, #ad-history:focus')) {
         fillAd(data.autoDelete);
      }
   }

   function startPolling() {
      stopPolling();
      refreshStatus();
      pollTimer = setInterval(refreshStatus, 2500);
   }
   function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
   }

   // ---------- init ----------
   const saved = localStorage.getItem('lastNumber');
   if (saved) $('inp-number').value = saved;

   (async () => {
      const { status } = await api('/api/status');
      if (status === 200) {
         authed = true;
         startPolling();
      } else {
         show('login');
      }
   })();
})();
