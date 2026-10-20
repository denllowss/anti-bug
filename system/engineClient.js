/**
 * system/engineClient.js — Klien engine remote (dipakai mode Vercel)
 * Berbicara ke engine (server.js di host persistent) lewat HTTP + Bearer ENGINE_TOKEN.
 */
export function createRemoteEngine({ baseUrl, token }) {
   async function request(method, apiPath, body) {
      if (!baseUrl) {
         return {
            ok: false,
            error: 'ENGINE_URL belum diset di Vercel. Jalankan engine (node index.js) di host persistent lalu set env ENGINE_URL + ENGINE_TOKEN.',
         };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
         const res = await fetch(new URL(apiPath, baseUrl), {
            method,
            headers: {
               authorization: `Bearer ${token}`,
               'content-type': 'application/json',
               'x-requested-with': 'XMLHttpRequest',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
         });
         const text = await res.text();
         try {
            return JSON.parse(text);
         } catch {
            return { ok: false, error: `Engine mengirim respons tidak valid (${res.status})` };
         }
      } catch (error) {
         return { ok: false, error: `Tidak bisa menghubungi engine: ${error?.message ?? error}` };
      } finally {
         clearTimeout(timer);
      }
   }

   return {
      status: () => request('GET', '/api/status'),
      startPairing: number => request('POST', '/api/pair', { number }),
      control: action => request('POST', '/api/control', { action }),
      getConfig: () => request('GET', '/api/config'),
      setConfig: patch => request('POST', '/api/config', patch),
   };
}
