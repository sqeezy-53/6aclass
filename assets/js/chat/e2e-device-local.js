// Chat6A E2E device-local unlock.
// Removes the daily master-password UX by using a per-device random secret stored locally.
// No browser API monkey-patches. No persistent document-wide observers.
// This layer wraps window.E2E.initE2EForUser and adds device/recovery helpers.
(function () {
  'use strict';
  if (window.__chat6aE2EDeviceLocal) return;
  window.__chat6aE2EDeviceLocal = true;

  const DB_NAME = 'e2e_keystore';
  const STORE = 'keys';
  const PBKDF2_ITERATIONS = 600000;
  const LEGACY_ITERATIONS = [310000];
  const HASH = 'SHA-256';
  const RECOVERY_PREFIX = 'CHAT6A-RECOVERY-';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = ev => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = ev => resolve(ev.target.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function bytesToB64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(s);
  }

  function b64ToBytes(b64) {
    return Uint8Array.from(atob(String(b64 || '')), c => c.charCodeAt(0));
  }

  function b64urlFromBytes(bytes) {
    return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function bytesFromB64url(value) {
    let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return b64ToBytes(s);
  }

  function randomSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    return 'chat6a-device-' + b64urlFromBytes(bytes);
  }

  async function getOrCreateDeviceSecret(uid) {
    const key = `e2e_device_secret_${uid}`;
    let secret = await idbGet(key);
    if (typeof secret === 'string' && secret.length >= 32) return secret;
    secret = randomSecret();
    await idbSet(key, secret);
    await idbSet(`e2e_device_secret_created_${uid}`, Date.now());
    return secret;
  }

  async function hasDeviceSecret(uid) {
    const secret = await idbGet(`e2e_device_secret_${uid}`);
    return typeof secret === 'string' && secret.length >= 32;
  }

  async function hasStoredPrivateKey(uid) {
    const blob = await idbGet(`e2e_privkey_${uid}`);
    return blob instanceof Uint8Array && blob.length > 44;
  }

  async function deriveKey(password, salt, iterations) {
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: HASH },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function decryptWrappedBlob(blob, password) {
    if (!(blob instanceof Uint8Array) || blob.length < 44) return null;
    const salt = blob.slice(0, 32);
    const iv = blob.slice(32, 44);
    const cipher = blob.slice(44);
    const attempts = [PBKDF2_ITERATIONS, ...LEGACY_ITERATIONS.filter(v => v !== PBKDF2_ITERATIONS)];
    let last = null;
    for (const iterations of attempts) {
      try {
        const key = await deriveKey(password, salt, iterations);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
        return JSON.parse(new TextDecoder().decode(plain));
      } catch (e) { last = e; }
    }
    throw last || new Error('decrypt_failed');
  }

  async function encryptWrappedJwk(jwk, deviceSecret) {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(deviceSecret, salt, PBKDF2_ITERATIONS);
    const plain = new TextEncoder().encode(JSON.stringify(jwk));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const out = new Uint8Array(32 + 12 + cipher.byteLength);
    out.set(salt, 0);
    out.set(iv, 32);
    out.set(new Uint8Array(cipher), 44);
    return out;
  }

  async function migrateWrappedKey(uid, storageKey, oldPassword, deviceSecret) {
    const blob = await idbGet(storageKey);
    if (!(blob instanceof Uint8Array) || blob.length < 44) return false;
    const jwk = await decryptWrappedBlob(blob, oldPassword);
    await idbSet(storageKey, await encryptWrappedJwk(jwk, deviceSecret));
    return true;
  }

  async function migrateMasterPasswordToDevice(uid, oldPassword, deviceSecret) {
    const keys = [`e2e_privkey_${uid}`, `e2e_sign_priv_${uid}`, `e2e_ecdh_priv_${uid}`];
    let migrated = 0;
    for (const key of keys) {
      try { if (await migrateWrappedKey(uid, key, oldPassword, deviceSecret)) migrated++; }
      catch (e) { console.warn('[e2e-device] key migration skipped:', key, e?.message || e); }
    }
    await idbSet(`e2e_device_secret_${uid}`, deviceSecret);
    await idbSet(`e2e_device_migrated_${uid}`, Date.now());
    return migrated;
  }

  function fillInput(el, value) {
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Temporary polling only while the original E2E prompt is visible. No MutationObserver.
  function startAutoPrompt(secret) {
    let stopped = false;
    let clicked = false;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (stopped || clicked || Date.now() - startedAt > 12000) return;
      const input = document.getElementById('mp-input');
      const ok = document.getElementById('mp-ok');
      if (!input || !ok) return;
      const input2 = document.getElementById('mp-input2');
      fillInput(input, secret);
      if (input2) fillInput(input2, secret);
      clicked = true;
      setTimeout(() => ok.click(), 20);
    }, 80);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      }
    };
  }

  function captureManualPasswordOnce() {
    let password = '';
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > 180000) return;
      const input = document.getElementById('mp-input');
      const ok = document.getElementById('mp-ok');
      if (input) password = input.value || password;
      if (ok && !ok.__chat6aCapture) {
        ok.__chat6aCapture = true;
        ok.addEventListener('pointerdown', () => { const i = document.getElementById('mp-input'); if (i) password = i.value || password; }, true);
        ok.addEventListener('click', () => { const i = document.getElementById('mp-input'); if (i) password = i.value || password; }, true);
      }
    }, 120);
    return {
      getPassword: () => password,
      stop() { clearInterval(timer); }
    };
  }

  function deviceLabel() {
    const ua = navigator.userAgent || '';
    const browser = ua.includes('Firefox') ? 'Firefox' : ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : 'Browser';
    const os = ua.includes('Windows') ? 'Windows' : ua.includes('Android') ? 'Android' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : 'Device';
    return `${browser} ${os}`;
  }

  async function getDeviceId(uid) {
    const key = `e2e_device_id_${uid}`;
    let id = await idbGet(key);
    if (typeof id === 'string' && id.length > 8) return id;
    id = 'dev_' + b64urlFromBytes(crypto.getRandomValues(new Uint8Array(18)));
    await idbSet(key, id);
    return id;
  }

  async function sha256HexText(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  async function getLocalFingerprint(uid) {
    const parts = [
      await idbGet(`e2e_pubkey_${uid}`),
      await idbGet(`e2e_ecdh_pub_${uid}`),
      await idbGet(`e2e_sign_pub_${uid}`)
    ].filter(v => typeof v === 'string' && v.length > 20);
    if (!parts.length) return '';
    const hex = await sha256HexText(parts.join('|'));
    return (hex.match(/.{1,4}/g) || []).slice(0, 6).join('-');
  }

  async function registerDevice(uid, args) {
    try {
      const [firestoreDb, fsDoc, fsGetDoc, fsSetDoc] = args;
      if (!firestoreDb || !fsDoc || !fsSetDoc) return;
      const deviceId = await getDeviceId(uid);
      await fsSetDoc(fsDoc(firestoreDb, 'users', uid, 'devices', deviceId), {
        deviceId,
        name: deviceLabel(),
        userAgent: (navigator.userAgent || '').slice(0, 180),
        e2eMode: 'device-local-key',
        trusted: true,
        fingerprint: await getLocalFingerprint(uid),
        lastSeenAtMs: Date.now(),
        createdAtMs: Number(await idbGet(`e2e_device_secret_created_${uid}`)) || Date.now()
      }, { merge: true });
    } catch (e) {
      console.warn('[e2e-device] device registry skipped:', e?.message || e);
    }
  }

  async function exportRecoveryKey(uid) {
    uid = String(uid || '');
    if (!uid) throw new Error('uid_required');
    const secret = await getOrCreateDeviceSecret(uid);
    const payload = {
      v: 1,
      app: 'chat6a',
      kind: 'device-local-e2e-recovery',
      uid,
      deviceId: await getDeviceId(uid),
      deviceName: deviceLabel(),
      deviceSecret: secret,
      fingerprint: await getLocalFingerprint(uid),
      createdAtMs: Number(await idbGet(`e2e_device_secret_created_${uid}`)) || Date.now(),
      exportedAtMs: Date.now(),
      warning: 'This recovery key unlocks local E2E keys. Keep it private.'
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return RECOVERY_PREFIX + b64urlFromBytes(bytes);
  }

  async function importRecoveryKey(uid, recoveryText) {
    uid = String(uid || '');
    if (!uid) throw new Error('uid_required');
    let raw = String(recoveryText || '').trim();
    if (!raw) throw new Error('empty_recovery_key');
    if (raw.startsWith(RECOVERY_PREFIX)) raw = raw.slice(RECOVERY_PREFIX.length);
    let payload;
    try {
      if (raw.trim().startsWith('{')) payload = JSON.parse(raw);
      else payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(raw)));
    } catch (_) {
      throw new Error('invalid_recovery_key');
    }
    if (payload?.kind !== 'device-local-e2e-recovery' || payload?.app !== 'chat6a') throw new Error('invalid_recovery_key_kind');
    if (payload.uid && String(payload.uid) !== uid) throw new Error('recovery_key_for_another_user');
    if (typeof payload.deviceSecret !== 'string' || payload.deviceSecret.length < 32) throw new Error('recovery_key_missing_secret');
    await idbSet(`e2e_device_secret_${uid}`, payload.deviceSecret);
    if (payload.deviceId) await idbSet(`e2e_device_id_${uid}`, String(payload.deviceId));
    await idbSet(`e2e_device_secret_created_${uid}`, Number(payload.createdAtMs) || Date.now());
    await idbSet(`e2e_device_imported_${uid}`, Date.now());
    return { ok: true, deviceId: await getDeviceId(uid), label: deviceLabel() };
  }

  async function resetLocalE2E(uid) {
    uid = String(uid || '');
    if (!uid) throw new Error('uid_required');
    const keys = [
      `e2e_device_secret_${uid}`,
      `e2e_device_secret_created_${uid}`,
      `e2e_device_migrated_${uid}`,
      `e2e_device_imported_${uid}`,
      `e2e_device_id_${uid}`,
      `e2e_privkey_${uid}`,
      `e2e_sign_priv_${uid}`,
      `e2e_ecdh_priv_${uid}`,
      `e2e_pubkey_${uid}`,
      `e2e_sign_pub_${uid}`,
      `e2e_ecdh_pub_${uid}`,
      `e2e_salt_${uid}`
    ];
    await Promise.all(keys.map(k => idbDelete(k).catch(() => {})));
    return { ok: true };
  }

  function waitForE2E() {
    return new Promise(resolve => {
      const tick = () => {
        if (window.E2E && typeof window.E2E.initE2EForUser === 'function') resolve(window.E2E);
        else setTimeout(tick, 50);
      };
      tick();
    });
  }

  waitForE2E().then(E2E => {
    if (E2E.__deviceLocalWrapped) return;
    const originalInit = E2E.initE2EForUser.bind(E2E);
    const wrapped = { ...E2E };

    wrapped.initE2EForUser = async function(uid, ...args) {
      uid = String(uid || '');
      if (!uid) return originalInit(uid, ...args);

      const hasKey = await hasStoredPrivateKey(uid);
      const alreadyDevice = await hasDeviceSecret(uid);

      if (!hasKey || alreadyDevice) {
        const secret = await getOrCreateDeviceSecret(uid);
        const auto = startAutoPrompt(secret);
        try {
          const result = await originalInit(uid, ...args);
          await registerDevice(uid, args);
          console.info('[e2e-device] E2E unlocked with local device key');
          return result;
        } finally {
          auto.stop();
        }
      }

      // Legacy users: ask the old master password once, then re-wrap local keys to the device secret.
      const capture = captureManualPasswordOnce();
      try {
        const result = await originalInit(uid, ...args);
        const oldPassword = capture.getPassword();
        if (result?.privateKey && oldPassword && oldPassword.length >= 12) {
          const secret = await getOrCreateDeviceSecret(uid);
          const count = await migrateMasterPasswordToDevice(uid, oldPassword, secret);
          console.info('[e2e-device] migrated master-password keys to device-local key:', count);
          await registerDevice(uid, args);
        }
        return result;
      } finally {
        capture.stop();
      }
    };

    wrapped.getDeviceLocalStatus = async function(uid) {
      uid = String(uid || '');
      return {
        enabled: await hasDeviceSecret(uid),
        hasStoredKey: await hasStoredPrivateKey(uid),
        deviceId: await getDeviceId(uid),
        label: deviceLabel(),
        fingerprint: await getLocalFingerprint(uid),
        migratedAtMs: Number(await idbGet(`e2e_device_migrated_${uid}`)) || null,
        importedAtMs: Number(await idbGet(`e2e_device_imported_${uid}`)) || null,
        warning: 'If site data/IndexedDB is cleared, old encrypted DMs may require a recovery key.'
      };
    };
    wrapped.exportRecoveryKey = exportRecoveryKey;
    wrapped.importRecoveryKey = importRecoveryKey;
    wrapped.resetLocalE2E = resetLocalE2E;

    Object.defineProperty(wrapped, '__deviceLocalWrapped', { value: true });
    try { window.E2E = Object.freeze(wrapped); }
    catch (_) { window.E2E = wrapped; }
    console.info('[chat6a] E2E device-local unlock loaded v2 recovery');
  });
})();
