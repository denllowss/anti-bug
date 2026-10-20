/**
 * system/autoDelete.js — Auto-delete pesan button/rich/interactive/payment
 * (dipasang ke tiap socket Baileys; konfigurasi bisa diubah dari dashboard)
 */
import { DEFAULT_AUTO_DELETE, RUNTIME } from './config.js';

// Wrapper (pembungkus) yang harus dibuka sebelum deteksi jenis pesan aslinya
const WRAPPER_TYPES = new Set([
   'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
   'documentWithCaptionMessage', 'editedMessage', 'deviceSentMessage',
   'botInvokeMessage', 'botForwardedMessage', 'associatedChildMessage',
   'statusMentionMessage', 'groupStatusMentionMessage', 'groupMentionedMessage', 'questionReplyMessage',
]);

function getMessageType(message) {
   if (!message || typeof message !== 'object') return null;
   for (const key of Object.keys(message)) {
      if (key === 'messageContextInfo') continue;
      if (message[key] === null || message[key] === undefined) continue;
      return key;
   }
   return null;
}

function unwrapContent(message) {
   let current = message;
   for (let i = 0; i < 10 && current && typeof current === 'object'; i++) {
      const type = getMessageType(current);
      if (!type || !WRAPPER_TYPES.has(type)) break;
      const inner = current[type]?.message;
      if (inner && typeof inner === 'object') current = inner;
      else break;
   }
   return current;
}

function isPrivateJid(jid) {
   return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function isSkippableJid(jid) {
   if (typeof jid !== 'string') return true;
   return jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

async function deleteForMe(sock, msg) {
   const jid = msg.key.remoteJid;
   const entry = {
      id: msg.key.id,
      fromMe: !!msg.key.fromMe,
      timestamp: String(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
   };
   try {
      await sock.chatModify({ clear: { messages: [entry] } }, jid);
   } catch {
      await sock.chatModify({ clear: { message: { id: entry.id, fromMe: entry.fromMe } } }, jid);
   }
}

async function deleteMessage(sock, msg, mode) {
   const canRevoke = !!msg.key.fromMe || msg.key.remoteJid?.endsWith('@g.us');
   if (mode === 'forEveryone' && canRevoke) {
      try {
         await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
         return 'forEveryone';
      } catch {}
   }
   await deleteForMe(sock, msg);
   return 'forMe';
}

/**
 * Pasang listener auto-delete pada socket.
 * @returns {() => void} fungsi detach
 */
export function attachAutoDelete(sock) {
   const processed = new Set();
   const MAX = 1000;

   const onUpsert = async ({ messages, type: upsertType }) => {
      const cfg = RUNTIME.autoDelete;
      if (!cfg.enabled) return;
      if (!cfg.processHistory && upsertType !== 'notify') return;

      for (const msg of messages) {
         try {
            if (!msg?.message || !msg.key?.remoteJid || !msg.key?.id) continue;
            const jid = msg.key.remoteJid;
            if (isSkippableJid(jid)) continue;
            const inScope = cfg.scope === 'all' || (cfg.scope === 'private' && isPrivateJid(jid));
            if (!inScope) continue;
            if (msg.key.fromMe && !cfg.includeOwn) continue;

            const content = unwrapContent(msg.message);
            const type = getMessageType(content);
            if (type === 'protocolMessage') continue;
            const spamTypes = new Set(cfg.types?.length ? cfg.types : DEFAULT_AUTO_DELETE.types);
            if (!spamTypes.has(type)) continue;

            const dedupe = `${jid}|${msg.key.fromMe ? 1 : 0}|${msg.key.id}`;
            if (processed.has(dedupe)) continue;
            processed.add(dedupe);
            if (processed.size > MAX) processed.delete(processed.values().next().value);

            const done = await deleteMessage(sock, msg, cfg.mode);
            console.log(`[AUTO-DELETE] ${done} | ${type} | ${jid} | ${msg.key.id}`);
         } catch (error) {
            console.error('[AUTO-DELETE] error:', error?.message ?? error);
         }
      }
   };

   sock.ev.on('messages.upsert', onUpsert);
   return () => {
      try {
         sock.ev.off?.('messages.upsert', onUpsert);
      } catch {}
   };
}
