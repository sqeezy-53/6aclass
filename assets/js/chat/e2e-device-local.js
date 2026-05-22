// Chat6A E2E device-local unlock.
// Removes the daily master-password UX by using a per-device random secret stored locally.
// No browser API monkey-patches. Only wraps window.E2E.initE2EForUser.
(function () {
  'use strict';
  if (window.__chat6aE2EDeviceLocal) return;
  window.__chat6aE2EDeviceLocal = true;

  const DB_NAME = 'e2e_keystore';
  const STORE = 'keys';
  const PBKDF2_ITERATIONS = 600000;
  const LEGACY_ITERATIONS = [310000];
  const HASH = 'SHA-256';
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

  function bytesToB64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(s);
  }

  function randomSecret() {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    return 'chat6a-device-' + bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

  function startAutoPrompt(secret, capture) {
    let stopped = false;
    let clicked = false;
    let observer = null;
    let timer = null;

    const tick = () => {
      if (stopped || clicked) return;
      const input = document.getElementById('mp-input');
      const ok = document.getElementById('mp-ok');
      if (!input || !ok) return;
      const input2 = document.getElementById('mp-input2');
      fillInput(input, secret);
      if (input2) fillInput(input2, secret);
      clicked = true;
      setTimeout(() => ok.click(), 20);
    };

    const start = () => {
      observer = new MutationObserver(tick);
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      timer = setInterval(tick, 80);
      tick();
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });

    return {
      stop() {
        stopped = true;
        if (observer) observer.disconnect();
        if (timer) clearInterval(timer);
      }
    };
  }

  function captureManualPasswordOnce() {
    let password = '';
    let observer = null;
    let timer = null;
    const tick = () => {
      const input = document.getElementById('mp-input');
      const ok = document.getElementById('mp-ok');
      if (input) password = input.value || password;
      if (ok && !ok.__chat6aCapture) {
        ok.__chat6aCapture = true;
        ok.addEventListener('pointerdown', () => { const i = document.getElementById('mp-input'); if (i) password = i.value || password; }, true);
        ok.addEventListener('click', () => { const i = document.getElementById('mp-input'); if (i) password = i.value || password; }, true);
      }
    };
    observer = new MutationObserver(tick);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    timer = setInterval(tick, 120);
    tick();
    return {
      getPassword: () => password,
      stop() { if (observer) observer.disconnect(); if (timer) clearInterval(timer); }
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
    id = 'dev_' + bytesToB64(crypto.getRandomValues(new Uint8Array(18))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    await idbSet(key, id);
    return id;
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
        lastSeenAtMs: Date.now(),
        createdAtMs: Number(await idbGet(`e2e_device_secret_created_${uid}`)) || Date.now()
      }, { merge: true });
    } catch (e) {
      console.warn('[e2e-device] device registry skipped:', e?.message || e);
    }
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
      return {
        enabled: await hasDeviceSecret(String(uid || '')),
        hasStoredKey: await hasStoredPrivateKey(String(uid || '')),
        deviceId: await getDeviceId(String(uid || '')),
        label: deviceLabel()
      };
    };

    Object.defineProperty(wrapped, '__deviceLocalWrapped', { value: true });
    try { window.E2E = Object.freeze(wrapped); }
    catch (_) { window.E2E = wrapped; }
    console.info('[chat6a] E2E device-local unlock loaded');
  });
})();
