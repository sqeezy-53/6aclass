// Load device-local E2E before media compatibility when this file is parser-loaded.
// This avoids editing the huge restored index5.html directly.
(function(){
  if (!window.__chat6aE2EDeviceLocalLoader) {
    window.__chat6aE2EDeviceLocalLoader = true;
    try {
      document.write('<script src="assets/js/chat/e2e-device-local.js?v=20260522-p2"><\/script>');
    } catch (e) {
      console.warn('[e2e-device] loader skipped:', e && (e.message || e));
    }
  }
})();

// E2E media compatibility layer.
// Purpose: DM media must decrypt on the other device even when ratchet local state is missing/out of sync.
// This wraps only the app-level E2E.sendDirectMessage; it does NOT patch browser APIs.
(function(){
  if (window.__chat6aE2EMediaCompat) return;
  window.__chat6aE2EMediaCompat = true;

  function waitForE2E() {
    return new Promise(resolve => {
      const tick = () => {
        if (window.E2E && typeof window.E2E.sendDirectMessage === 'function' && typeof window.E2E.decryptMessage === 'function') resolve(window.E2E);
        else setTimeout(tick, 60);
      };
      tick();
    });
  }

  function bytesToB64(bytes) {
    let s = '';
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  function bufferToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function importRsaPublicKeyB64(b64) {
    const clean = String(b64 || '').trim();
    if (!clean) throw new Error('У пользователя нет E2E publicKey');
    const bin = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
    return crypto.subtle.importKey('spki', bin, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
  }

  async function rsaEncryptLegacyB64(publicKeyB64, text) {
    const publicKey = await importRsaPublicKeyB64(publicKeyB64);
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(String(text ?? ''));
    const cipherText = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
    const rawAes = await crypto.subtle.exportKey('raw', aesKey);
    const encryptedAes = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAes);
    const keyLen = new Uint8Array(2);
    new DataView(keyLen.buffer).setUint16(0, encryptedAes.byteLength);
    const packed = new Uint8Array(2 + encryptedAes.byteLength + 12 + cipherText.byteLength);
    packed.set(keyLen, 0);
    packed.set(new Uint8Array(encryptedAes), 2);
    packed.set(iv, 2 + encryptedAes.byteLength);
    packed.set(new Uint8Array(cipherText), 2 + encryptedAes.byteLength + 12);
    return bytesToB64(packed);
  }

  async function encryptBlobForUpload(blob) {
    const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await blob.arrayBuffer();
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
    const packed = new Uint8Array(12 + cipher.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(cipher), 12);
    const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
    return {
      encryptedBlob: new Blob([packed], { type: 'application/octet-stream' }),
      aesHex: bufferToHex(rawAesKey)
    };
  }

  async function getPublicKeys(params) {
    const { firestoreDb, fsDoc, fsGetDoc, peerUid, myUid } = params;
    const [peerSnap, mySnap] = await Promise.all([
      fsGetDoc(fsDoc(firestoreDb, 'users', peerUid)),
      fsGetDoc(fsDoc(firestoreDb, 'users', myUid))
    ]);
    const peerKey = peerSnap.data()?.publicKey || '';
    const myKey = mySnap.data()?.publicKey || '';
    if (!peerKey) throw new Error('У получателя не настроен E2E-ключ');
    if (!myKey) throw new Error('У тебя не настроен E2E-ключ');
    return { peerKey, myKey };
  }

  async function encryptForBoth(plain, keys) {
    const [forPeer, forMe] = await Promise.all([
      rsaEncryptLegacyB64(keys.peerKey, plain),
      rsaEncryptLegacyB64(keys.myKey, plain)
    ]);
    return { forPeer, forMe };
  }

  function previewText(params) {
    if (params.imageFile) return '🖼 Изображение';
    if (params.voiceFile) return '🎙 Голосовое';
    if (params.musicFile) return '🎵 Музыка';
    if (params.checklist) return '✅ Чек-лист';
    return '🔒 Сообщение';
  }

  async function sendMediaCompat(params, originalSend) {
    const {
      convId, peerUid, myUid, authorName,
      text = '', imageFile = null, voiceFile = null, voiceDuration = null, voiceMime = null,
      musicFile = null, musicDuration = null, musicMime = null,
      checklist = null, replyTo = null, forwarded = false,
      firestoreDb, fsCollection, fsAddDoc, fsSetDoc, fsDoc, fsGetDoc, fsServerTimestamp, fsIncrement,
      uploadToCloudinary
    } = params;

    const hasMedia = !!(imageFile || voiceFile || musicFile);
    if (!hasMedia && !checklist) return originalSend(params);
    if (!firestoreDb || !fsCollection || !fsAddDoc || !fsDoc || !fsGetDoc) throw new Error('E2E media compat: нет Firestore helpers');

    const keys = await getPublicKeys(params);
    const msgData = {
      uid: myUid,
      author: authorName,
      convId,
      text: '',
      createdAt: fsServerTimestamp(),
      edited: false
    };

    const encryptMedia = async (file, kind) => {
      const { encryptedBlob, aesHex } = await encryptBlobForUpload(file);
      const uploader = uploadToCloudinary || window.E2E?.uploadViaBackend;
      if (typeof uploader !== 'function') throw new Error('Загрузчик медиа не найден');
      const cloudUrl = await uploader(encryptedBlob, null, 'raw');
      if (!String(cloudUrl || '').startsWith('https://')) throw new Error('Cloudinary не вернул ссылку');
      const [aesForPeer, aesForMe, urlForPeer, urlForMe] = await Promise.all([
        rsaEncryptLegacyB64(keys.peerKey, aesHex),
        rsaEncryptLegacyB64(keys.myKey, aesHex),
        rsaEncryptLegacyB64(keys.peerKey, cloudUrl),
        rsaEncryptLegacyB64(keys.myKey, cloudUrl)
      ]);
      msgData['e2e' + kind + 'ForPeer'] = JSON.stringify({ aes: aesForPeer, url: urlForPeer });
      msgData['e2e' + kind + 'ForMe'] = JSON.stringify({ aes: aesForMe, url: urlForMe });
    };

    if (imageFile) await encryptMedia(imageFile, 'Img');
    if (voiceFile) {
      await encryptMedia(voiceFile, 'Voice');
      if (voiceDuration != null) msgData.voiceDuration = voiceDuration;
      if (voiceMime) msgData.voiceMime = String(voiceMime).split(';')[0] || 'audio/webm';
    }
    if (musicFile) {
      await encryptMedia(musicFile, 'Music');
      if (musicDuration != null) msgData.musicDuration = musicDuration;
      if (musicMime) msgData.musicMime = String(musicMime).split(';')[0] || 'audio/mpeg';
    }

    if (checklist) {
      const normalized = Array.isArray(checklist) ? { title: '', items: checklist, done: {} } : checklist;
      const e = await encryptForBoth(JSON.stringify(normalized), keys);
      msgData.e2eChecklistForPeer = e.forPeer;
      msgData.e2eChecklistForMe = e.forMe;
    }

    const textToEncrypt = String(text || '').trim() || previewText(params);
    const eText = await encryptForBoth(textToEncrypt, keys);
    msgData.e2eForPeer = eText.forPeer;
    msgData.e2eForMe = eText.forMe;

    if (replyTo) {
      const eReply = await encryptForBoth(String(replyTo.text || '').slice(0, 100), keys);
      msgData.replyTo = { id: replyTo.id, author: replyTo.author, text: '', e2eForPeer: eReply.forPeer, e2eForMe: eReply.forMe };
    }
    if (forwarded) msgData.forwarded = true;

    await fsAddDoc(fsCollection(firestoreDb, 'dmConvs', convId, 'messages'), msgData);

    try {
      await fsSetDoc(
        fsDoc(firestoreDb, 'dmConvs', convId),
        { members: [myUid, peerUid], lastText: previewText(params), lastAt: fsServerTimestamp(), [`unread.${peerUid}`]: fsIncrement(1) },
        { merge: true }
      );
    } catch (e) {
      console.debug('[e2e-media-compat] metadata skipped', e?.message || e);
    }
  }

  waitForE2E().then(original => {
    if (original.__mediaCompatWrapped) return;
    const wrapped = { ...original };
    wrapped.sendDirectMessage = function(params) {
      if (params && (params.imageFile || params.voiceFile || params.musicFile || params.checklist)) {
        return sendMediaCompat(params, original.sendDirectMessage.bind(original));
      }
      return original.sendDirectMessage(params);
    };
    Object.defineProperty(wrapped, '__mediaCompatWrapped', { value: true });
    window.E2E = Object.freeze(wrapped);
    console.log('[chat6a] E2E media compat loaded: RSA media envelopes');
  }).catch(err => console.warn('[e2e-media-compat] init failed', err?.message || err));
})();
