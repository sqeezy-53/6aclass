/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          E2E SECURITY REFACTOR — Чат 6А / 6aclass.online        ║
 * ║                                                                  ║
 * ║  Устраняет критические уязвимости, выявленные в аудите:          ║
 * ║  1. Мастер-пароль вместо uid как ключ PBKDF2                    ║
 * ║  2. E2E-шифрование медиафайлов (img / voice / music)            ║
 * ║  3. Строгое соответствие Firestore Rules (dmHasE2EPayload)      ║
 * ║  4. API-ключи вынесены на бэкенд (Perspective → server.py)      ║
 * ║  5. IndexedDB для крупных бинарных данных                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Подключение: вставь этот файл в <head> или <body> после Firebase SDK,
 * но ДО основного скрипта чата. Все функции экспортируются в window.E2E.
 *
 * Зависимости: Firebase Auth, Firebase Firestore, Web Crypto API
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   § 0  КОНСТАНТЫ
═══════════════════════════════════════════════════════════════ */

const E2E_IDB_NAME       = 'e2e_keystore';   // IndexedDB база
const E2E_IDB_STORE      = 'keys';           // хранилище ключей
const E2E_IDB_VERSION    = 1;
const PBKDF2_ITERATIONS  = 310_000;          // OWASP 2023 рекомендация для SHA-256
const PBKDF2_HASH        = 'SHA-256';
const AES_KEY_LENGTH     = 256;              // бит
const RSA_MOD_LENGTH     = 4096;             // бит — новые RSA-OAEP ключи, legacy 2048 продолжают читаться
const E2E_SIGN_CURVE    = 'P-384';          // ECDSA P-384 для подписей сообщений
const E2E_ECDH_CURVE    = 'P-384';          // ECDH P-384 для новых сообщений
const E2E_CIPHER_V3     = 'ECDH-P384-AES-GCM';
const E2E_CIPHER_V4     = 'RATCHET-LITE-P384-HKDF-AESGCM';
const E2E_RATCHET_MAX_SKIP = 64;          // сколько пропущенных message-keys держим для out-of-order сообщений
const E2E_TRUSTED_ORIGINS = new Set(['https://6aclass.online']);
const E2E_STRICT_NEW_MESSAGES = false;     // Transitional: Ratchet/ECDH when available; RSA fallback only for old accounts without ECDH
const E2E_MASTER_MIN_LENGTH = 12;
const E2E_AUTOLOCK_MS = 15 * 60 * 1000;    // 15 минут бездействия
const E2E_DEVICE_ID_KEY = 'chat6a_e2e_device_id_v1';
const E2E_TRUST_STORE_PREFIX = 'chat6a_e2e_trust_';

/* Поля, разрешённые Firestore Rules в dmConvs/messages */
const DM_ALLOWED_FIELDS = new Set([
  'uid','author','text','createdAt','edited',
  'e2eForPeer','e2eForMe',
  'e2eImgForPeer','e2eImgForMe',
  'e2eVoiceForPeer','e2eVoiceForMe','voiceDuration','voiceMime',
  'e2eMusicForPeer','e2eMusicForMe','musicDuration','musicMime',
  'e2eChecklistForPeer','e2eChecklistForMe',
  'replyTo','forwarded','convId','e2eDeviceId','deleteAt','e2eSig','e2eSigAlg','e2eCipherAlg','e2eRatchetAlg','e2eRatchetN','e2eRatchetPN'
]);

/* URL Python-бэкенда (server.py) */
const BACKEND_URL = window.BACKEND_URL || '/api';

/* ═══════════════════════════════════════════════════════════════
   § 1  IndexedDB — хранилище ключей и зашифрованных данных
═══════════════════════════════════════════════════════════════ */

/**
 * Возвращает открытое соединение с IndexedDB (ленивая инициализация).
 * @returns {Promise<IDBDatabase>}
 */
let _idbPromise = null;
function openIDB() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(E2E_IDB_NAME, E2E_IDB_VERSION);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(E2E_IDB_STORE)) {
        db.createObjectStore(E2E_IDB_STORE); // key-value: ключ → Uint8Array
      }
    };
    req.onsuccess = ev => resolve(ev.target.result);
    req.onerror   = ev => reject(ev.target.error);
  });
  return _idbPromise;
}

/**
 * Читает значение из IndexedDB.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(E2E_IDB_STORE, 'readonly');
    const req = tx.objectStore(E2E_IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Записывает значение в IndexedDB.
 * @param {string} key
 * @param {any} value
 */
async function idbSet(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(E2E_IDB_STORE, 'readwrite');
    const req = tx.objectStore(E2E_IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Удаляет запись из IndexedDB.
 * @param {string} key
 */
async function idbDelete(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(E2E_IDB_STORE, 'readwrite');
    const req = tx.objectStore(E2E_IDB_STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Возвращает все ключи локального E2E-хранилища IndexedDB.
 * Нужен для безопасного локального сброса E2E-данных на устройстве.
 * @returns {Promise<string[]>}
 */
async function idbKeys() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(E2E_IDB_STORE, 'readonly');
    const store = tx.objectStore(E2E_IDB_STORE);
    const req = store.getAllKeys ? store.getAllKeys() : null;
    if (!req) { resolve([]); return; }
    req.onsuccess = () => resolve(Array.from(req.result || []));
    req.onerror = () => reject(req.error);
  });
}

/**
 * Удаляет локальные E2E-ключи и ratchet-состояние с текущего устройства.
 * Это НЕ удаляет сообщения из Firebase и НЕ восстанавливает старые ЛС.
 * После сброса старые E2E-сообщения на этом устройстве могут стать нечитаемыми.
 */
async function resetLocalE2EStorage(options = {}) {
  const requireConfirm = options.confirmReset !== false;
  if (requireConfirm && typeof confirm === 'function') {
    const ok1 = confirm('Сбросить локальные E2E-ключи на этом устройстве?\n\nСтарые личные сообщения могут перестать открываться без старого мастер-пароля/ключей.');
    if (!ok1) return false;
    const ok2 = confirm('Последнее подтверждение: это действие нельзя отменить. Продолжить?');
    if (!ok2) return false;
  }

  lockE2EKeys('local-reset');
  const keys = await idbKeys();
  const prefixes = [
    'e2e_privkey_', 'e2e_sign_priv_', 'e2e_ecdh_priv_',
    'e2e_pubkey_', 'e2e_sign_pub_', 'e2e_ecdh_pub_',
    'e2e_salt_', 'e2e_ratchet_'
  ];
  await Promise.all(
    keys
      .map(String)
      .filter(k => prefixes.some(prefix => k.startsWith(prefix)))
      .map(k => idbDelete(k))
  );

  try {
    localStorage.removeItem(E2E_DEVICE_ID_KEY);
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(E2E_TRUST_STORE_PREFIX)) localStorage.removeItem(k);
    }
  } catch (_) {}

  return true;
}

/**
 * Меняет мастер-пароль локального E2E-хранилища без смены публичных ключей.
 * Старый пароль нужен, потому что приватные ключи надо сначала расшифровать.
 * @param {string} uid
 * @param {string} oldPassword
 * @param {string} newPassword
 */
async function changeMasterPassword(uid, oldPassword, newPassword) {
  const strength = validateMasterPasswordStrength(newPassword);
  if (!strength.ok) throw new Error('Слабый новый мастер-пароль: ' + strength.reasons.join(', '));

  const [rsaPrivateKey, signingPrivateKey, ecdhPrivateKey] = await Promise.all([
    loadPrivateKey(uid, oldPassword, { extractable: true }),
    loadSigningPrivateKey(uid, oldPassword, { extractable: true }),
    loadEcdhPrivateKey(uid, oldPassword, { extractable: true })
  ]);

  if (!rsaPrivateKey || !signingPrivateKey || !ecdhPrivateKey) {
    throw new Error('Не удалось загрузить все локальные E2E-ключи. Проверьте старый мастер-пароль.');
  }

  await savePrivateKey(uid, rsaPrivateKey, newPassword);
  await saveSigningPrivateKey(uid, signingPrivateKey, newPassword);
  await saveEcdhPrivateKey(uid, ecdhPrivateKey, newPassword);
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   § 2  МАСТЕР-ПАРОЛЬ — PBKDF2 → AES-GCM (обёртка приватного RSA)
═══════════════════════════════════════════════════════════════ */

/**
 * Выводит AES-256-GCM ключ из мастер-пароля + соли (PBKDF2/SHA-256).
 * Пароль НИКОГДА не сохраняется — только соль (в IndexedDB).
 *
 * @param {string}     password   — мастер-пароль пользователя
 * @param {Uint8Array} salt       — 32 случайных байта, хранятся в IDB
 * @returns {Promise<CryptoKey>}
 */
async function deriveKeyFromPassword(password, salt) {
  const enc     = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Сохраняет приватный RSA-ключ в IndexedDB, зашифрованный мастер-паролем.
 *
 * Формат блоба: [32 байта соли][12 байт IV][AES-GCM(JWK)]
 *
 * @param {string}     uid
 * @param {CryptoKey}  privateKey
 * @param {string}     password   — мастер-пароль (не хранится)
 */
async function savePrivateKey(uid, privateKey, password) {
  // 1. Экспортируем RSA-ключ в JWK
  const jwk   = await crypto.subtle.exportKey('jwk', privateKey);
  const plain = new TextEncoder().encode(JSON.stringify(jwk));

  // 2. Получаем или генерируем соль
  const saltKey = `e2e_salt_${uid}`;
  let salt = await idbGet(saltKey);
  if (!(salt instanceof Uint8Array) || salt.length !== 32) {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await idbSet(saltKey, salt);
  }

  // 3. Выводим AES-ключ из пароля
  const aesKey = await deriveKeyFromPassword(password, salt);

  // 4. Шифруем JWK
  const iv     = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);

  // 5. Пакуем: [32 соли][12 IV][шифртекст]
  const blob = new Uint8Array(32 + 12 + cipher.byteLength);
  blob.set(salt, 0);
  blob.set(iv,   32);
  blob.set(new Uint8Array(cipher), 44);

  await idbSet(`e2e_privkey_${uid}`, blob);
}

/**
 * Загружает и расшифровывает приватный RSA-ключ из IndexedDB.
 * Выбрасывает ошибку при неверном пароле (AES-GCM не пройдёт).
 *
 * @param {string} uid
 * @param {string} password
 * @returns {Promise<CryptoKey>}  RSA-OAEP privateKey
 */
async function loadPrivateKey(uid, password, options = {}) {
  const extractable = options.extractable === true;
  const blob = await idbGet(`e2e_privkey_${uid}`);
  if (!(blob instanceof Uint8Array) || blob.length < 44) return null;

  const salt    = blob.slice(0, 32);
  const iv      = blob.slice(32, 44);
  const cipher  = blob.slice(44);

  const aesKey  = await deriveKeyFromPassword(password, salt);

  // Если пароль неверный — subtle.decrypt выбросит DOMException
  const plain   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  const jwk     = JSON.parse(new TextDecoder().decode(plain));

  return crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    extractable, ['decrypt']
  );
}

/**
 * Проверяет, существует ли зашифрованный приватный ключ для uid.
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function hasStoredPrivateKey(uid) {
  const blob = await idbGet(`e2e_privkey_${uid}`);
  return blob instanceof Uint8Array && blob.length > 44;
}


/**
 * Подписной ключ нужен не для шифрования, а для доказательства автора.
 * Сообщение шифруется ключом получателя, а подпись доказывает,
 * что текст подписал владелец uid.
 */
let _activeSigningPrivateKey = null;
let _activeSigningPublicKeyB64 = null;

function bytesToB64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function bufferToB64(buf) { return bytesToB64(new Uint8Array(buf)); }
function b64ToBytes(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
function escapeTextForHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}
function isTrustedE2EOrigin() {
  const origin = window.location.origin;
  if (E2E_TRUSTED_ORIGINS.has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
async function exportSpkiB64(publicKey) { return bufferToB64(await crypto.subtle.exportKey('spki', publicKey)); }
async function importSigningPublicKey(b64) {
  return crypto.subtle.importKey('spki', b64ToBytes(b64), { name: 'ECDSA', namedCurve: E2E_SIGN_CURVE }, true, ['verify']);
}
async function generateSigningKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: E2E_SIGN_CURVE }, true, ['sign', 'verify']);
}
async function saveSigningPrivateKey(uid, privateKey, password) {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const plain = new TextEncoder().encode(JSON.stringify(jwk));
  const saltKey = `e2e_salt_${uid}`;
  let salt = await idbGet(saltKey);
  if (!(salt instanceof Uint8Array) || salt.length !== 32) {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await idbSet(saltKey, salt);
  }
  const aesKey = await deriveKeyFromPassword(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
  const blob = new Uint8Array(32 + 12 + cipher.byteLength);
  blob.set(salt, 0); blob.set(iv, 32); blob.set(new Uint8Array(cipher), 44);
  await idbSet(`e2e_sign_priv_${uid}`, blob);
}
async function loadSigningPrivateKey(uid, password, options = {}) {
  const extractable = options.extractable === true;
  const blob = await idbGet(`e2e_sign_priv_${uid}`);
  if (!(blob instanceof Uint8Array) || blob.length < 44) return null;
  const salt = blob.slice(0, 32), iv = blob.slice(32, 44), cipher = blob.slice(44);
  const aesKey = await deriveKeyFromPassword(password, salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  const jwk = JSON.parse(new TextDecoder().decode(plain));
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: E2E_SIGN_CURVE }, extractable, ['sign']);
}
async function fingerprintPublicKeyB64(b64) {
  const digest = await crypto.subtle.digest('SHA-256', b64ToBytes(b64));
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,4}/g).slice(0, 8).join('-');
}
function canonicalSignaturePayload(uid, text) {
  return JSON.stringify({ v: 1, purpose: 'chat6a-dm-text-signature', uid: String(uid || ''), text: String(text || '') });
}
async function signDMPlaintext(uid, text) {
  if (!_activeSigningPrivateKey) return null;
  const payload = new TextEncoder().encode(canonicalSignaturePayload(uid, text));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, _activeSigningPrivateKey, payload);
  return bufferToB64(sig);
}
async function verifyDMPlaintextSignature(msgData, plaintext, firestoreDb, fsDoc, fsGetDoc) {
  if (!msgData?.e2eSig) return { ok: null, reason: 'no_signature' };
  if (!firestoreDb || !fsDoc || !fsGetDoc) return { ok: null, reason: 'no_firestore_context' };
  try {
    const senderUid = String(msgData.uid || '');
    const snap = await fsGetDoc(fsDoc(firestoreDb, 'users', senderUid));
    const signingPublicKey = snap.data()?.signingPublicKey;
    if (!signingPublicKey) return { ok: null, reason: 'sender_has_no_signing_key' };
    const pub = await importSigningPublicKey(signingPublicKey);
    const payload = new TextEncoder().encode(canonicalSignaturePayload(senderUid, plaintext));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, pub, b64ToBytes(msgData.e2eSig), payload);
    return { ok, reason: ok ? 'verified' : 'bad_signature', fingerprint: await fingerprintPublicKeyB64(signingPublicKey) };
  } catch (e) { return { ok: false, reason: 'verify_error' }; }
}
async function ensureSigningKeyPair(uid, firestoreDb, fsDoc, fsSetDoc, password) {
  let privateKey = null;
  let publicKeyB64 = await idbGet(`e2e_sign_pub_${uid}`);
  try { privateKey = await loadSigningPrivateKey(uid, password); } catch (e) { privateKey = null; }
  if (!privateKey || typeof publicKeyB64 !== 'string' || publicKeyB64.length < 40) {
    const pair = await generateSigningKeyPair();
    privateKey = pair.privateKey;
    publicKeyB64 = await exportSpkiB64(pair.publicKey);
    await saveSigningPrivateKey(uid, privateKey, password);
    await idbSet(`e2e_sign_pub_${uid}`, publicKeyB64);
    privateKey = await loadSigningPrivateKey(uid, password);
  }
  _activeSigningPrivateKey = privateKey;
  _activeSigningPublicKeyB64 = publicKeyB64;
  try {
    await fsSetDoc(fsDoc(firestoreDb, 'users', uid), {
      signingPublicKey: publicKeyB64,
      signingAlg: 'ECDSA-P384-SHA384',
      e2eKeyFingerprint: await fingerprintPublicKeyB64(publicKeyB64)
    }, { merge: true });
  } catch (e) { console.warn('[e2e] Не удалось опубликовать signingPublicKey:', e); }
  return { privateKey, publicKeyB64 };
}

let _activeEcdhPrivateKey = null;
let _activeEcdhPublicKeyB64 = null;

async function generateEcdhKeyPair() {
  // Generate extractable so the private JWK can be wrapped by the master password.
  // After saving, persistent working keys are re-imported as non-extractable by loadEcdhPrivateKey().
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: E2E_ECDH_CURVE }, true, ['deriveKey']);
}
async function importEcdhPublicKey(b64) {
  return crypto.subtle.importKey('spki', b64ToBytes(b64), { name: 'ECDH', namedCurve: E2E_ECDH_CURVE }, true, []);
}
async function saveEcdhPrivateKey(uid, privateKey, password) {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const plain = new TextEncoder().encode(JSON.stringify(jwk));
  const saltKey = `e2e_salt_${uid}`;
  let salt = await idbGet(saltKey);
  if (!(salt instanceof Uint8Array) || salt.length !== 32) {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await idbSet(saltKey, salt);
  }
  const aesKey = await deriveKeyFromPassword(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
  const blob = new Uint8Array(32 + 12 + cipher.byteLength);
  blob.set(salt, 0); blob.set(iv, 32); blob.set(new Uint8Array(cipher), 44);
  await idbSet(`e2e_ecdh_priv_${uid}`, blob);
}
async function loadEcdhPrivateKey(uid, password, options = {}) {
  const extractable = options.extractable === true;
  const blob = await idbGet(`e2e_ecdh_priv_${uid}`);
  if (!(blob instanceof Uint8Array) || blob.length < 44) return null;
  const salt = blob.slice(0, 32), iv = blob.slice(32, 44), cipher = blob.slice(44);
  const aesKey = await deriveKeyFromPassword(password, salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
  const jwk = JSON.parse(new TextDecoder().decode(plain));
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: E2E_ECDH_CURVE }, extractable, ['deriveKey']);
}
async function ensureEcdhKeyPair(uid, firestoreDb, fsDoc, fsSetDoc, password) {
  let privateKey = null;
  let publicKeyB64 = await idbGet(`e2e_ecdh_pub_${uid}`);
  try { privateKey = await loadEcdhPrivateKey(uid, password); } catch (e) { privateKey = null; }
  if (!privateKey || typeof publicKeyB64 !== 'string' || publicKeyB64.length < 40) {
    const pair = await generateEcdhKeyPair();
    privateKey = pair.privateKey;
    publicKeyB64 = await exportSpkiB64(pair.publicKey);
    await saveEcdhPrivateKey(uid, privateKey, password);
    await idbSet(`e2e_ecdh_pub_${uid}`, publicKeyB64);
    privateKey = await loadEcdhPrivateKey(uid, password);
  }
  _activeEcdhPrivateKey = privateKey;
  _activeEcdhPublicKeyB64 = publicKeyB64;
  try {
    await fsSetDoc(fsDoc(firestoreDb, 'users', uid), {
      ecdhPublicKey: publicKeyB64,
      ecdhAlg: 'ECDH-P384-AES-GCM',
      ecdhKeyFingerprint: await fingerprintPublicKeyB64(publicKeyB64)
    }, { merge: true });
  } catch (e) { console.warn('[e2e] Не удалось опубликовать ecdhPublicKey:', e); }
  return { privateKey, publicKeyB64 };
}
async function ecdhEncryptForPublicKeyB64(publicKeyB64, text) {
  const peerPub = await importEcdhPublicKey(publicKeyB64);
  const eph = await generateEcdhKeyPair();
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub },
    eph.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(String(text ?? '')));
  return JSON.stringify({
    v: 3,
    alg: E2E_CIPHER_V3,
    epk: await exportSpkiB64(eph.publicKey),
    iv: bytesToB64(iv),
    ct: bufferToB64(ct)
  });
}
async function encryptForUserPublicKeys({ ecdhPublicKey, rsaPublicKey }, text, options = {}) {
  const strict = options.strictNewMessages !== false && E2E_STRICT_NEW_MESSAGES;
  if (!ecdhPublicKey) {
    if (!strict && rsaPublicKey) return rsaEncrypt(await importPublicKey(rsaPublicKey), text);
    throw new Error('У пользователя нет современного E2E ECDH-ключа. RSA разрешён только для чтения старых сообщений.');
  }
  if (!options.convId && strict) throw new Error('Новые E2E-сообщения требуют convId для Ratchet-Lite.');
  if (options.convId) return ratchetEncryptForPublicKeyB64(ecdhPublicKey, text, options);
  if (!strict) return ecdhEncryptForPublicKeyB64(ecdhPublicKey, text);
  throw new Error('Ratchet-Lite обязателен для новых сообщений.');
}
function detectCipherAlg(value) {
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { const env = JSON.parse(value); if (env?.alg) return env.alg; } catch (_) {}
  }
  return 'RSA-OAEP-AES-GCM-LEGACY';
}
function canonicalEncryptedPayload(msgData) {
  const keys = [
    'uid','author','text','edited','e2eForPeer','e2eForMe',
    'e2eImgForPeer','e2eImgForMe',
    'e2eVoiceForPeer','e2eVoiceForMe','voiceDuration','voiceMime',
    'e2eMusicForPeer','e2eMusicForMe','musicDuration','musicMime',
    'e2eChecklistForPeer','e2eChecklistForMe','replyTo','forwarded','convId','e2eDeviceId','deleteAt','e2eCipherAlg','e2eRatchetAlg','e2eRatchetN','e2eRatchetPN'
  ];
  const out = { v: 2, purpose: 'chat6a-dm-encrypted-payload-signature' };
  for (const key of keys) if (msgData[key] !== undefined) out[key] = msgData[key];
  return JSON.stringify(out, Object.keys(out).sort());
}
async function signEncryptedMessagePayload(msgData) {
  if (!_activeSigningPrivateKey) return null;
  const payload = new TextEncoder().encode(canonicalEncryptedPayload(msgData));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, _activeSigningPrivateKey, payload);
  return bufferToB64(sig);
}
async function verifyEncryptedMessageSignature(msgData, firestoreDb, fsDoc, fsGetDoc) {
  if (!msgData?.e2eSig) return { ok: null, reason: 'no_signature' };
  if (!firestoreDb || !fsDoc || !fsGetDoc) return { ok: null, reason: 'no_firestore_context' };
  try {
    const senderUid = String(msgData.uid || '');
    const snap = await fsGetDoc(fsDoc(firestoreDb, 'users', senderUid));
    const signingPublicKey = snap.data()?.signingPublicKey;
    if (!signingPublicKey) return { ok: null, reason: 'sender_has_no_signing_key' };
    const pub = await importSigningPublicKey(signingPublicKey);
    const payload = new TextEncoder().encode(canonicalEncryptedPayload(msgData));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, pub, b64ToBytes(msgData.e2eSig), payload);
    return { ok, reason: ok ? 'verified' : 'bad_signature', fingerprint: await fingerprintPublicKeyB64(signingPublicKey) };
  } catch (e) { return { ok: false, reason: 'verify_error' }; }
}

const _e2eObjectUrls = new Set();
function rememberObjectUrl(url) { if (url && url.startsWith('blob:')) _e2eObjectUrls.add(url); return url; }
function revokeE2EObjectUrls() { for (const url of _e2eObjectUrls) { try { URL.revokeObjectURL(url); } catch (_) {} } _e2eObjectUrls.clear(); }
window.addEventListener('beforeunload', revokeE2EObjectUrls);


/* ═══════════════════════════════════════════════════════════════
   § 2.5  RATCHET-LITE — локальная KDF-цепочка поверх ECDH
═══════════════════════════════════════════════════════════════

Это НЕ полный Signal Double Ratchet. Это практичный промежуточный слой:
- для новых сообщений добавляется локальная chain-key KDF;
- старые message-key после использования не сохраняются;
- out-of-order сообщения поддерживаются через маленький skipped-key буфер;
- если локальное состояние потеряно, часть старых сообщений может не открыться.

Зачем это нужно: если украли текущее состояние устройства, старые удалённые
message-key не должны лежать готовыми. Для настоящего Signal-level нужен
отдельный X3DH/Double Ratchet протокол.
*/

function ratchetHexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function ratchetBytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function ratchetRandomHex(len = 32) {
  return ratchetBytesToHex(crypto.getRandomValues(new Uint8Array(len)));
}
async function ratchetSha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
async function ratchetImportHkdfKey(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
}
async function ratchetDeriveAesKey(chainKeyHex, label, convId, counter) {
  const base = await ratchetImportHkdfKey(ratchetHexToBytes(chainKeyHex));
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(`chat6a:${convId}:${counter}`),
      info: new TextEncoder().encode(label)
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function ratchetNextChainKey(chainKeyHex) {
  const input = new Uint8Array([...new TextEncoder().encode('chat6a-ratchet-next:'), ...ratchetHexToBytes(chainKeyHex)]);
  return ratchetBytesToHex(await ratchetSha256Bytes(input));
}
function ratchetStateKey(kind, convId, uid) {
  return `e2e_ratchet_${kind}_${convId}_${uid}`;
}
async function loadRatchetState(kind, convId, uid) {
  const raw = await idbGet(ratchetStateKey(kind, convId, uid));
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
async function saveRatchetState(kind, convId, uid, state) {
  await idbSet(ratchetStateKey(kind, convId, uid), JSON.stringify(state));
}
async function clearRatchetState(kind, convId, uid) {
  await idbDelete(ratchetStateKey(kind, convId, uid));
}

async function ratchetEncryptForPublicKeyB64(publicKeyB64, text, options = {}) {
  const convId = String(options.convId || 'global');
  const targetUid = String(options.targetUid || 'peer');
  const senderUid = String(options.senderUid || 'me');
  const stateKind = 'send';
  let state = await loadRatchetState(stateKind, convId, targetUid);
  let seedEnvelope = null;

  if (!state || !state.chainKey || typeof state.n !== 'number') {
    state = { v: 1, alg: E2E_CIPHER_V4, chainKey: ratchetRandomHex(32), n: 0, pn: 0, skipped: {} };
    // Первый пакет цепочки переносит seed через ECDH. Последующие seed не несут,
    // чтобы компрометация долгоживущего ключа не открывала всю историю цепочки.
    seedEnvelope = await ecdhEncryptForPublicKeyB64(publicKeyB64, state.chainKey);
  }

  const n = state.n;
  const aesKey = await ratchetDeriveAesKey(state.chainKey, 'message-key', convId, n);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(String(text ?? ''))
  );

  state.chainKey = await ratchetNextChainKey(state.chainKey);
  state.n = n + 1;
  await saveRatchetState(stateKind, convId, targetUid, state);

  return JSON.stringify({
    v: 4,
    alg: E2E_CIPHER_V4,
    conv: convId,
    from: senderUid,
    to: targetUid,
    n,
    pn: state.pn || 0,
    seed: seedEnvelope,
    iv: bytesToB64(iv),
    ct: bufferToB64(ct)
  });
}

async function ratchetDecryptEnvelope(privateKey, env) {
  const convId = String(env.conv || 'global');
  const senderUid = String(env.from || 'peer');
  const n = Number(env.n || 0);
  let state = await loadRatchetState('recv', convId, senderUid);

  if (!state || !state.chainKey || typeof state.n !== 'number') {
    if (!env.seed) throw new Error('ratchet_state_missing');
    const seedHex = await rsaDecrypt(privateKey, env.seed);
    state = { v: 1, alg: E2E_CIPHER_V4, chainKey: seedHex, n: 0, pn: 0, skipped: {} };
  }

  state.skipped = state.skipped || {};
  let msgKeyHex = state.skipped[String(n)] || null;
  let aesKey = null;

  if (msgKeyHex) {
    aesKey = await ratchetDeriveAesKey(msgKeyHex, 'message-key', convId, n);
    delete state.skipped[String(n)];
  } else {
    if (n < state.n) throw new Error('ratchet_message_key_expired');
    while (state.n < n) {
      if (Object.keys(state.skipped).length < E2E_RATCHET_MAX_SKIP) {
        state.skipped[String(state.n)] = state.chainKey;
      }
      state.chainKey = await ratchetNextChainKey(state.chainKey);
      state.n += 1;
    }
    aesKey = await ratchetDeriveAesKey(state.chainKey, 'message-key', convId, n);
    state.chainKey = await ratchetNextChainKey(state.chainKey);
    state.n = n + 1;
  }

  await saveRatchetState('recv', convId, senderUid, state);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, aesKey, b64ToBytes(env.ct));
  return new TextDecoder().decode(plain);
}


/* ═══════════════════════════════════════════════════════════════
   § 3  RSA-OAEP + AES-GCM — текстовое гибридное шифрование
═══════════════════════════════════════════════════════════════ */

/**
 * Генерирует RSA-OAEP ключевую пару. Новые ключи — 4096 бит; старые 2048 остаются legacy.
 * @returns {Promise<CryptoKeyPair>}
 */
async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: RSA_MOD_LENGTH,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Экспортирует публичный ключ в base64 (SPKI) для Firebase.
 * @param {CryptoKey} publicKey
 * @returns {Promise<string>}
 */
async function exportPublicKey(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(spki)));
}

/**
 * Импортирует публичный ключ из base64 (SPKI).
 * @param {string} b64
 * @returns {Promise<CryptoKey>}
 */
async function importPublicKey(b64) {
  const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'spki', binary,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true, ['encrypt']
  );
}

/**
 * Гибридное шифрование строки публичным RSA-ключом.
 * RSA шифрует одноразовый AES-256-GCM ключ, AES шифрует текст.
 *
 * Формат блоба: [2 байта len_rsa][RSA(AES-key)][12 байт IV][AES(text)]
 *
 * @param {CryptoKey} publicKey
 * @param {string}    text
 * @returns {Promise<string>}   base64
 */
async function rsaEncrypt(publicKey, text) {
  // Одноразовый AES-256-GCM ключ
  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Шифруем текст AES
  const cipherText = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey,
    new TextEncoder().encode(text)
  );

  // Экспортируем AES-ключ и шифруем RSA
  const rawAes         = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedAes   = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawAes);

  // Пакуем всё
  const keyLen = new Uint8Array(2);
  new DataView(keyLen.buffer).setUint16(0, encryptedAes.byteLength);

  const blob = new Uint8Array(2 + encryptedAes.byteLength + 12 + cipherText.byteLength);
  blob.set(keyLen, 0);
  blob.set(new Uint8Array(encryptedAes), 2);
  blob.set(iv, 2 + encryptedAes.byteLength);
  blob.set(new Uint8Array(cipherText), 2 + encryptedAes.byteLength + 12);

  return btoa(String.fromCharCode(...blob));
}

/**
 * Гибридная расшифровка base64 приватным RSA-ключом.
 * @param {CryptoKey} privateKey
 * @param {string}    b64
 * @returns {Promise<string>}   plaintext
 */
async function rsaDecryptLegacy(privateKey, b64) {
  const blob   = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const keyLen = new DataView(blob.buffer).getUint16(0);
  const encAes = blob.slice(2, 2 + keyLen);
  const iv     = blob.slice(2 + keyLen, 2 + keyLen + 12);
  const ct     = blob.slice(2 + keyLen + 12);

  const rawAes = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, encAes);
  const aesKey = await crypto.subtle.importKey(
    'raw', rawAes, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const plain  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
  return new TextDecoder().decode(plain);
}


/**
 * Универсальная расшифровка поля ЛС.
 * Новый формат: JSON-конверт ECDH-P384-AES-GCM.
 * Старый формат: base64 RSA-OAEP hybrid. Старые ЛС продолжают читаться.
 */
async function rsaDecrypt(privateKey, value) {
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const env = JSON.parse(value);
      if (env && env.v === 4 && env.alg === E2E_CIPHER_V4) {
        return ratchetDecryptEnvelope(privateKey, env);
      }
      if (env && env.v === 3 && env.alg === E2E_CIPHER_V3) {
        if (!_activeEcdhPrivateKey) throw new Error('ecdh_private_key_not_loaded');
        const peerEphemeralPub = await importEcdhPublicKey(env.epk);
        const aesKey = await crypto.subtle.deriveKey(
          { name: 'ECDH', public: peerEphemeralPub },
          _activeEcdhPrivateKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(env.iv) },
          aesKey,
          b64ToBytes(env.ct)
        );
        return new TextDecoder().decode(plain);
      }
    } catch (e) {
      // Если это был похожий JSON, но не наш формат — не маскируем ошибку.
      if (String(value).includes(E2E_CIPHER_V3)) throw e;
    }
  }
  return rsaDecryptLegacy(privateKey, value);
}

/* ═══════════════════════════════════════════════════════════════
   § 4  ШИФРОВАНИЕ БИНАРНЫХ ДАННЫХ (медиафайлы)
═══════════════════════════════════════════════════════════════ */

/**
 * Шифрует бинарный Blob симметричным AES-256-GCM ключом.
 *
 * Возвращает:
 *   - encryptedBlob : Blob  — зашифрованные байты (IV + cipher)
 *   - rawAesKey     : ArrayBuffer — экспортированный AES-ключ (32 байта)
 *
 * @param {Blob} blob
 * @returns {Promise<{encryptedBlob: Blob, rawAesKey: ArrayBuffer}>}
 */
async function encryptBlob(blob) {
  const aesKey  = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const plain   = await blob.arrayBuffer();
  const cipher  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);

  // Пакуем: [12 байт IV][шифртекст]
  const packed  = new Uint8Array(12 + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), 12);

  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  return {
    encryptedBlob: new Blob([packed], { type: 'application/octet-stream' }),
    rawAesKey
  };
}

/**
 * Расшифровывает бинарный ответ (ArrayBuffer) симметричным AES-ключом.
 * @param {ArrayBuffer} encryptedBuffer  — [12 IV][cipher]
 * @param {ArrayBuffer} rawAesKey
 * @returns {Promise<ArrayBuffer>}
 */
async function decryptBuffer(encryptedBuffer, rawAesKey) {
  const packed = new Uint8Array(encryptedBuffer);
  const iv     = packed.slice(0, 12);
  const cipher = packed.slice(12);

  const aesKey = await crypto.subtle.importKey(
    'raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']
  );
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
}

/**
 * Расшифровывает медиафайл из Cloudinary-URL, возвращает Object URL для src.
 *
 * 1. Расшифровываем зашифрованный AES-ключ (RSA) из поля e2eXxxForMe/Peer
 * 2. Скачиваем зашифрованный Blob с Cloudinary
 * 3. Расшифровываем AES-GCM
 * 4. Создаём Object URL (revokeable)
 *
 * @param {CryptoKey}  myPrivateKey
 * @param {string}     encryptedUrl   — base64 от rsaEncrypt(cloudinaryUrl)
 *                                      ** только если шифруется URL, не файл **
 * @param {string}     encryptedAesB64 — base64 от rsaEncrypt(rawHex(aesKey))
 *                                       используется при шифровании файла
 * @param {'url'|'file'} mode          — 'url' для старой схемы, 'file' для новой
 * @returns {Promise<string>}  Object URL или data URL
 */
async function decryptMediaUrl(myPrivateKey, encryptedAesB64, cloudinaryRawUrl) {
  // 1. RSA-расшифровываем AES-ключ (hex → ArrayBuffer)
  const aesHex    = await rsaDecrypt(myPrivateKey, encryptedAesB64);
  const rawAesKey = hexToBuffer(aesHex);

  // 2. Скачиваем зашифрованный файл
  const resp = await fetch(cloudinaryRawUrl);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
  const encBuf = await resp.arrayBuffer();

  // 3. Расшифровываем
  const plainBuf = await decryptBuffer(encBuf, rawAesKey);

  // 4. Возвращаем Object URL — не забудь вызвать revokeObjectURL после использования
  return rememberObjectUrl(URL.createObjectURL(new Blob([plainBuf])));
}

/* ═══════════════════════════════════════════════════════════════
   § 5  УТИЛИТЫ
═══════════════════════════════════════════════════════════════ */

/** ArrayBuffer → hex-строка */
function bufferToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** hex-строка → ArrayBuffer */
function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}


function validateMasterPasswordStrength(password) {
  const reasons = [];
  const pwd = String(password || '');
  if (pwd.length < E2E_MASTER_MIN_LENGTH) reasons.push(`минимум ${E2E_MASTER_MIN_LENGTH} символов`);
  if (!/[a-zа-яё]/i.test(pwd)) reasons.push('добавьте буквы');
  if (!/\d/.test(pwd)) reasons.push('добавьте цифры');
  if (!/[^A-Za-zА-Яа-яЁё0-9]/.test(pwd)) reasons.push('добавьте спецсимвол');
  const lower = pwd.toLowerCase();
  const weak = ['password','qwerty','йцукен','123456','12345678','111111','000000','chat6a','6aclass','пароль'];
  if (weak.some(w => lower.includes(w))) reasons.push('слишком похож на популярный пароль');
  return { ok: reasons.length === 0, reasons };
}

function getOrCreateDeviceId() {
  let id = localStorage.getItem(E2E_DEVICE_ID_KEY);
  if (!id || id.length < 24) {
    id = 'dev_' + ratchetBytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(E2E_DEVICE_ID_KEY, id);
  }
  return id;
}

async function currentDeviceFingerprint() {
  const deviceId = getOrCreateDeviceId();
  const raw = new TextEncoder().encode(`${location.origin}:${navigator.userAgent}:${deviceId}`);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.match(/.{1,4}/g).slice(0, 8).join('-');
}

async function registerCurrentDevice(uid, firestoreDb, fsDoc, fsSetDoc) {
  if (!uid || !firestoreDb || !fsDoc || !fsSetDoc) return null;
  const deviceId = getOrCreateDeviceId();
  const fingerprint = await currentDeviceFingerprint();
  const now = new Date().toISOString();
  try {
    await fsSetDoc(fsDoc(firestoreDb, 'users', uid, 'devices', deviceId), {
      deviceId,
      fingerprint,
      userAgent: navigator.userAgent.slice(0, 240),
      origin: location.origin,
      lastSeenAtClient: now,
      revoked: false,
      signingPublicKey: _activeSigningPublicKeyB64 || null,
      ecdhPublicKey: _activeEcdhPublicKeyB64 || null,
      ecdhKeyFingerprint: _activeEcdhPublicKeyB64 ? await fingerprintPublicKeyB64(_activeEcdhPublicKeyB64) : null,
    }, { merge: true });
  } catch (e) { console.warn('[e2e] Не удалось зарегистрировать устройство:', e); }
  return { deviceId, fingerprint };
}

function getTrustedPeerKey(peerUid) {
  try { return JSON.parse(localStorage.getItem(E2E_TRUST_STORE_PREFIX + peerUid) || 'null'); }
  catch (_) { return null; }
}
function setTrustedPeerKey(peerUid, data) {
  localStorage.setItem(E2E_TRUST_STORE_PREFIX + peerUid, JSON.stringify({ ...data, trustedAt: new Date().toISOString() }));
}
async function ensurePeerKeyTrusted(peerUid, peerData) {
  const current = peerData.ecdhKeyFingerprint || (peerData.ecdhPublicKey ? await fingerprintPublicKeyB64(peerData.ecdhPublicKey) : null);
  if (!current) {
    if (!E2E_STRICT_NEW_MESSAGES && peerData.publicKey) {
      return { ok: true, legacy: true, fingerprint: 'legacy-rsa' };
    }
    throw new Error('У собеседника нет современного E2E-ключа. Попросите его обновить ключи.');
  }
  const prev = getTrustedPeerKey(peerUid);
  if (!prev) {
    setTrustedPeerKey(peerUid, { ecdhKeyFingerprint: current });
    return { ok: true, firstTrust: true, fingerprint: current };
  }
  if (prev.ecdhKeyFingerprint !== current) {
    const msg = `Ключ безопасности собеседника изменился.\n\nСтарый: ${prev.ecdhKeyFingerprint}\nНовый: ${current}\n\nОтправлять сообщение только если вы лично подтвердили новый отпечаток.`;
    const approved = typeof confirm === 'function' ? confirm(msg) : false;
    if (!approved) throw new Error('Отправка остановлена: ключ собеседника изменился и не подтверждён.');
    setTrustedPeerKey(peerUid, { ecdhKeyFingerprint: current, replaced: prev.ecdhKeyFingerprint });
    try { window.dispatchEvent(new CustomEvent('e2e-key-change-approved', { detail: { peerUid, old: prev.ecdhKeyFingerprint, current } })); } catch (_) {}
  }
  return { ok: true, fingerprint: current };
}

let _e2eAutoLockTimer = null;
function lockE2EKeys(reason = 'manual') {
  _activeSigningPrivateKey = null;
  _activeSigningPublicKeyB64 = null;
  _activeEcdhPrivateKey = null;
  _activeEcdhPublicKeyB64 = null;
  try { revokeE2EObjectUrls(); } catch (_) {}
  try { window.dispatchEvent(new CustomEvent('e2e-lock', { detail: { reason } })); } catch (_) {}
}
function resetE2EAutoLockTimer() {
  if (_e2eAutoLockTimer) clearTimeout(_e2eAutoLockTimer);
  _e2eAutoLockTimer = setTimeout(() => lockE2EKeys('idle-timeout'), E2E_AUTOLOCK_MS);
}
function setupE2EAutoLock() {
  const events = ['click','keydown','mousemove','touchstart','visibilitychange'];
  for (const ev of events) window.addEventListener(ev, resetE2EAutoLockTimer, { passive: true });
  window.addEventListener('beforeunload', () => lockE2EKeys('beforeunload'));
  resetE2EAutoLockTimer();
}

/**
 * Показывает модальное окно для ввода мастер-пароля.
 * Возвращает Promise<string> — введённый пароль.
 * При отмене выбрасывает Error('cancelled').
 *
 * @param {'create'|'unlock'} mode
 * @returns {Promise<string>}
 */
function promptMasterPassword(mode) {
  return new Promise((resolve, reject) => {
    // Создаём модалку программно, чтобы не зависеть от существующей разметки
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.7);
      display:flex;align-items:center;justify-content:center;
      z-index:99999;backdrop-filter:blur(4px);
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background:var(--surface,#1a1a2e);color:var(--text,#e8edf8);
      border-radius:20px;padding:32px 28px;max-width:380px;width:90%;
      box-shadow:0 24px 72px rgba(0,0,0,.6);font-family:var(--font-body,'DM Sans',sans-serif);
    `;

    const isCreate = mode === 'create';
    card.innerHTML = `
      <h3 style="margin:0 0 8px;font-size:1.2rem;font-weight:700;">
        ${isCreate ? '🔑 Создать мастер-пароль' : '🔐 Введите мастер-пароль'}
      </h3>
      <p style="margin:0 0 20px;font-size:.88rem;color:var(--muted,#7d8da6);line-height:1.5;">
        ${isCreate
          ? 'Этот пароль защищает ваши E2E-ключи. Он <strong style="color:var(--danger,#f87171)">не восстанавливается</strong> — сохраните его в надёжном месте.'
          : 'Для доступа к переписке введите мастер-пароль, заданный при регистрации.'}
      </p>
      <input id="mp-input" type="password" autocomplete="current-password"
        placeholder="Мастер-пароль"
        style="width:100%;box-sizing:border-box;padding:12px 16px;border-radius:12px;
               border:1.5px solid var(--border-strong,rgba(255,255,255,.1));
               background:var(--surface-2,#141927);color:var(--text,#e8edf8);
               font-size:1rem;outline:none;margin-bottom:${isCreate ? '12px' : '20px'}">
      ${isCreate ? `
        <input id="mp-input2" type="password" autocomplete="new-password"
          placeholder="Повторите пароль"
          style="width:100%;box-sizing:border-box;padding:12px 16px;border-radius:12px;
                 border:1.5px solid var(--border-strong,rgba(255,255,255,.1));
                 background:var(--surface-2,#141927);color:var(--text,#e8edf8);
                 font-size:1rem;outline:none;margin-bottom:20px">
      ` : ''}
      <p id="mp-err" style="color:var(--danger,#f87171);font-size:.82rem;margin:0 0 12px;display:none;"></p>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="mp-cancel" style="padding:10px 20px;border-radius:12px;border:1.5px solid var(--border-strong,rgba(255,255,255,.1));background:transparent;color:var(--muted,#7d8da6);cursor:pointer;font-size:.9rem;">
          Отмена
        </button>
        <button id="mp-ok" style="padding:10px 22px;border-radius:12px;border:none;background:var(--accent,#63b3ff);color:#030b18;font-weight:700;cursor:pointer;font-size:.9rem;">
          ${isCreate ? 'Создать' : 'Войти'}
        </button>
      </div>
      ${!isCreate ? `
        <button id="mp-reset-local" style="margin-top:14px;width:100%;padding:10px 14px;border-radius:12px;border:1px solid rgba(248,113,113,.35);background:rgba(248,113,113,.08);color:var(--danger,#f87171);cursor:pointer;font-size:.82rem;font-weight:700;">
          Сбросить E2E-ключи на этом устройстве
        </button>
        <p style="margin:8px 0 0;font-size:.72rem;color:var(--muted,#7d8da6);line-height:1.35;">
          Используйте только если забыли мастер-пароль. Старые ЛС на этом устройстве могут стать нечитаемыми.
        </p>
      ` : ''}
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const input  = card.querySelector('#mp-input');
    const input2 = card.querySelector('#mp-input2');
    const errEl  = card.querySelector('#mp-err');

    const showErr = msg => { errEl.textContent = msg; errEl.style.display = 'block'; };
    const hideErr = ()  => { errEl.style.display = 'none'; };

    const cleanup = () => overlay.remove();

    card.querySelector('#mp-cancel').addEventListener('click', () => {
      cleanup(); reject(new Error('cancelled'));
    });

    const resetBtn = card.querySelector('#mp-reset-local');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        try {
          const didReset = await resetLocalE2EStorage({ confirmReset: true });
          if (didReset) {
            cleanup();
            alert('Локальные E2E-ключи сброшены. Войдите заново и создайте новый мастер-пароль.');
            location.reload();
          }
        } catch (e) {
          showErr('Не удалось сбросить E2E-ключи: ' + (e?.message || e));
        }
      });
    }

    card.querySelector('#mp-ok').addEventListener('click', () => {
      const pwd = input.value;

      // ВАЖНО: проверка силы пароля применяется только при СОЗДАНИИ
      // нового мастер-пароля. При разблокировке старого хранилища нельзя
      // блокировать пароль новыми правилами сложности: иначе пользователи
      // со старыми паролями потеряют доступ к уже созданным E2E-ключам.
      if (isCreate) {
        const strength = validateMasterPasswordStrength(pwd);
        if (!strength.ok) { showErr('Слабый мастер-пароль: ' + strength.reasons.join(', ')); return; }
        if (pwd !== input2.value) { showErr('Пароли не совпадают'); return; }
      } else {
        if (!pwd) { showErr('Введите мастер-пароль'); return; }
      }

      hideErr();
      cleanup();
      resolve(pwd);
    });

    // Enter submit
    [input, input2].filter(Boolean).forEach(el =>
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') card.querySelector('#mp-ok').click();
      })
    );

    input.focus();
  });
}

/* ═══════════════════════════════════════════════════════════════
   § 6  initE2EForUser — РЕФАКТОРИНГ (мастер-пароль)
═══════════════════════════════════════════════════════════════ */

/**
 * Инициализация E2E-шифрования при входе пользователя.
 *
 * Сценарии:
 *  A) Первый вход / нет ключей → генерация пары + запрос мастер-пароля (create)
 *  B) Есть ключи в IDB → запрос пароля (unlock) → расшифровка
 *  C) Ключи есть, но пара не совпадает с Firebase → повтор генерации
 *
 * Записывает в myPrivateKey, myPublicKeyB64 (глобальные переменные чата).
 *
 * @param {string}   uid          — Firebase Auth UID
 * @param {object}   firestoreDb  — Firestore db instance
 * @param {object}   fsDoc        — Firestore doc() function
 * @param {object}   fsGetDoc     — Firestore getDoc() function
 * @param {object}   fsSetDoc     — Firestore setDoc() function
 * @returns {Promise<{privateKey: CryptoKey, publicKeyB64: string}>}
 */
async function initE2EForUser(uid, firestoreDb, fsDoc, fsGetDoc, fsSetDoc) {
  const hasKey = await hasStoredPrivateKey(uid);

  // ── Сценарий B: ключ сохранён — разблокируем паролем ──
  if (hasKey) {
    let attempts = 0;
    while (attempts < 3) {
      let password;
      try {
        password = await promptMasterPassword('unlock');
      } catch (e) {
        // Пользователь нажал «Отмена» — работаем без E2E (только чтение)
        console.warn('[e2e] Пользователь отменил ввод пароля — E2E недоступен');
        return { privateKey: null, publicKeyB64: null };
      }

      try {
        const privateKey = await loadPrivateKey(uid, password);
        if (!privateKey) throw new Error('null key');

        // Проверяем совпадение с публичным ключом в Firebase или локальной копией.
        // ВАЖНО: privateKey загружается как non-extractable, поэтому нельзя пытаться экспортировать
        // из него public key. Публичный ключ должен храниться отдельно в Firebase/IndexedDB.
        const snap = await fsGetDoc(fsDoc(firestoreDb, 'users', uid));
        const localPubB64 = await idbGet(`e2e_pubkey_${uid}`);
        const storedPubB64 = snap.data()?.publicKey || localPubB64 || null;

        if (storedPubB64) {
          const pubKey = await importPublicKey(storedPubB64);
          const testCt = await rsaEncrypt(pubKey, 'e2e_ok');
          const testPlain = await rsaDecrypt(privateKey, testCt);
          if (testPlain !== 'e2e_ok') throw new Error('e2e_keypair_mismatch');
        } else {
          console.warn('[e2e] RSA publicKey отсутствует в Firebase/IDB; пароль верный, продолжаем без RSA-проверки legacy-ключа.');
        }

        await ensureSigningKeyPair(uid, firestoreDb, fsDoc, fsSetDoc, password);
        await ensureEcdhKeyPair(uid, firestoreDb, fsDoc, fsSetDoc, password);
        await registerCurrentDevice(uid, firestoreDb, fsDoc, fsSetDoc);
        setupE2EAutoLock();
        console.info('[e2e] Ключи разблокированы');
        return { privateKey, publicKeyB64: storedPubB64 };
      } catch (err) {
        if (err?.name === 'OperationError') {
          // AES-GCM провалился → неверный мастер-пароль.
          attempts++;
          console.warn(`[e2e] Неверный пароль (попытка ${attempts}/3)`);
          if (attempts >= 3) {
            alert('Неверный пароль 3 раза. E2E-переписка недоступна на этом устройстве.');
            return { privateKey: null, publicKeyB64: null };
          }
          continue;
        }
        console.error('[e2e] Ошибка разблокировки E2E-ключей:', err);
        alert('Мастер-пароль принят, но E2E-ключи не удалось подготовить: ' + (err?.message || err));
        return { privateKey: null, publicKeyB64: null };
      }
    }
    return { privateKey: null, publicKeyB64: null };
  }

  // ── Сценарий A: первый вход — ключей на устройстве ещё нет ──
  let password;
  try {
    password = await promptMasterPassword('create');
  } catch (e) {
    console.warn('[e2e] Генерация ключей отменена пользователем');
    return { privateKey: null, publicKeyB64: null };
  }

  // Генерируем новую пару RSA-OAEP 2048
  const pair         = await generateKeyPair();
  const publicKeyB64 = await exportPublicKey(pair.publicKey);
  const signPair = await generateSigningKeyPair();
  const signingPublicKeyB64 = await exportSpkiB64(signPair.publicKey);
  const ecdhPair = await generateEcdhKeyPair();
  const ecdhPublicKeyB64 = await exportSpkiB64(ecdhPair.publicKey);

  // Сохраняем публичные ключи в IDB (для последующей верификации)
  await idbSet(`e2e_pubkey_${uid}`, publicKeyB64);
  await idbSet(`e2e_sign_pub_${uid}`, signingPublicKeyB64);
  await idbSet(`e2e_ecdh_pub_${uid}`, ecdhPublicKeyB64);

  // Сохраняем приватный ключ в IDB (зашифрованный мастер-паролем)
  await savePrivateKey(uid, pair.privateKey, password);
  await saveSigningPrivateKey(uid, signPair.privateKey, password);
  await saveEcdhPrivateKey(uid, ecdhPair.privateKey, password);
  // Рабочие ключи импортируем обратно как non-extractable.
  const nonExtractablePrivateKey = await loadPrivateKey(uid, password);
  _activeSigningPrivateKey = await loadSigningPrivateKey(uid, password);
  _activeSigningPublicKeyB64 = signingPublicKeyB64;
  _activeEcdhPrivateKey = await loadEcdhPrivateKey(uid, password);
  _activeEcdhPublicKeyB64 = ecdhPublicKeyB64;

  // Публикуем публичный ключ в Firebase
  await fsSetDoc(fsDoc(firestoreDb, 'users', uid), {
    publicKey: publicKeyB64,
    signingPublicKey: signingPublicKeyB64,
    signingAlg: 'ECDSA-P384-SHA384',
    e2eKeyFingerprint: await fingerprintPublicKeyB64(signingPublicKeyB64),
    ecdhPublicKey: ecdhPublicKeyB64,
    ecdhAlg: 'ECDH-P384-AES-GCM',
    ecdhKeyFingerprint: await fingerprintPublicKeyB64(ecdhPublicKeyB64)
  }, { merge: true });

  await registerCurrentDevice(uid, firestoreDb, fsDoc, fsSetDoc);
  setupE2EAutoLock();
  console.info('[e2e] Новая ключевая пара сгенерирована и сохранена');
  return { privateKey: nonExtractablePrivateKey, publicKeyB64 };
}

/* ═══════════════════════════════════════════════════════════════
   § 7  encryptDM — шифрование для обоих участников ЛС
═══════════════════════════════════════════════════════════════ */

/**
 * Шифрует текст для обоих участников диалога (peer + me).
 * Возвращает поля строго по Firestore Rules (dmHasE2EPayload).
 *
 * @param {string}   text
 * @param {string}   peerUid
 * @param {string}   myUid
 * @param {CryptoKey} myPrivateKey
 * @param {object}   firestoreDb
 * @param {Function} fsDoc
 * @param {Function} fsGetDoc
 * @returns {Promise<{forPeer: string, forMe: string}>}
 */
async function encryptDM(text, peerUid, myUid, myPrivateKey, firestoreDb, fsDoc, fsGetDoc, options = {}) {
  const [peerSnap, mySnap] = await Promise.all([
    fsGetDoc(fsDoc(firestoreDb, 'users', peerUid)),
    fsGetDoc(fsDoc(firestoreDb, 'users', myUid))
  ]);

  const peerData = peerSnap.data() || {};
  const myData = mySnap.data() || {};
  if (E2E_STRICT_NEW_MESSAGES && !options.convId) throw new Error('Новые ЛС требуют convId для Ratchet-Lite.');
  await ensurePeerKeyTrusted(peerUid, peerData);

  const [forPeer, forMe] = await Promise.all([
    encryptForUserPublicKeys({ ecdhPublicKey: peerData.ecdhPublicKey, rsaPublicKey: peerData.publicKey }, text, { convId: options.convId, targetUid: peerUid, senderUid: myUid }),
    encryptForUserPublicKeys({ ecdhPublicKey: myData.ecdhPublicKey || _activeEcdhPublicKeyB64, rsaPublicKey: myData.publicKey }, text, { convId: options.convId, targetUid: myUid, senderUid: myUid })
  ]);

  const peerAlg = detectCipherAlg(forPeer);
  const myAlg = detectCipherAlg(forMe);
  return {
    forPeer,
    forMe,
    alg: peerAlg === myAlg ? peerAlg : 'MIXED-LEGACY-COMPAT'
  };
}
/* ═══════════════════════════════════════════════════════════════
   § 8  sendDirectMessage — строгое соответствие Firestore Rules
═══════════════════════════════════════════════════════════════ */

/**
 * Отправляет E2E-зашифрованное сообщение в ЛС.
 * Строго соответствует dmHasE2EPayload() + dmHasNoPlainMedia() из Rules.
 *
 * Поддерживаемые типы: text, image, voice, music, checklist.
 * Для медиа: файл шифруется локально, на Cloudinary уходит зашифрованный blob.
 *
 * @param {object} params
 * @param {string}        params.convId          — ID диалога (dmConvs/)
 * @param {string}        params.peerUid
 * @param {string}        params.myUid
 * @param {string}        params.authorName
 * @param {CryptoKey}     params.myPrivateKey
 * @param {string|null}   params.text            — plaintext
 * @param {File|Blob|null} params.imageFile
 * @param {File|Blob|null} params.voiceFile
 * @param {number|null}   params.voiceDuration
 * @param {string|null}   params.voiceMime
 * @param {File|Blob|null} params.musicFile
 * @param {number|null}   params.musicDuration
 * @param {string|null}   params.musicMime
 * @param {Array|null}    params.checklist
 * @param {object|null}   params.replyTo
 * @param {boolean}       params.forwarded
 * @param {object}        params.firestoreDb
 * @param {Function}      params.fsCollection
 * @param {Function}      params.fsAddDoc
 * @param {Function}      params.fsSetDoc
 * @param {Function}      params.fsDoc
 * @param {Function}      params.fsGetDoc
 * @param {Function}      params.fsServerTimestamp
 * @param {Function}      params.fsIncrement
 * @param {Function}      params.uploadToCloudinary — async (blob, onProgress?) → url
 * @returns {Promise<void>}
 */
async function sendDirectMessage(params) {
  const {
    convId, peerUid, myUid, authorName, myPrivateKey,
    text = '', imageFile = null, voiceFile = null,
    voiceDuration = null, voiceMime = null,
    musicFile = null, musicDuration = null, musicMime = null,
    checklist = null, replyTo = null, forwarded = false, deleteAfterSeconds = 0,
    firestoreDb, fsCollection, fsAddDoc, fsSetDoc, fsDoc, fsGetDoc,
    fsServerTimestamp, fsIncrement,
    uploadToCloudinary
  } = params;

  if (!myPrivateKey) throw new Error('[e2e] Приватный ключ не инициализирован');

  // Вспомогательная функция: зашифровать строку для обоих участников
  const enc = async (plainStr) => encryptDM(
    plainStr, peerUid, myUid, myPrivateKey, firestoreDb, fsDoc, fsGetDoc, { convId }
  );

  // Вспомогательная: зашифровать файл → загрузить на Cloudinary зашифрованным
  const encryptAndUpload = async (file, onProgress) => {
    const { encryptedBlob, rawAesKey } = await encryptBlob(file);
    const cloudUrl = await uploadToCloudinary(encryptedBlob, onProgress);
    if (!cloudUrl?.startsWith('https://')) throw new Error('Cloudinary не вернул ссылку');

    // AES-ключ медиа заворачивается тем же современным E2E-слоем, что и текст.
    // В strict-режиме это требует convId и идёт через Ratchet-Lite, без RSA fallback.
    const aesHex = bufferToHex(rawAesKey);
    const aesE2e = await enc(aesHex);

    return { cloudUrl, encAesForPeer: aesE2e.forPeer, encAesForMe: aesE2e.forMe };
  };

  // ── Строим msgData строго по разрешённым полям ──
  const msgData = {
    uid:       myUid,
    author:    authorName,
    convId:    convId,
    e2eDeviceId: getOrCreateDeviceId(),
    text:      '',           // ВСЕГДА пусто в ЛС (Rules: dmHasNoPlainMedia)
    createdAt: fsServerTimestamp(),
    edited:    false,
  };
  if (deleteAfterSeconds && Number(deleteAfterSeconds) > 0) {
    msgData.deleteAt = new Date(Date.now() + Number(deleteAfterSeconds) * 1000).toISOString();
  }

  // Текст
  if (text && text.trim()) {
    const e2e = await enc(text.trim());
    msgData.e2eForPeer = e2e.forPeer;
    msgData.e2eForMe   = e2e.forMe;
    if (e2e.sig) { msgData.e2eSig = e2e.sig; msgData.e2eSigAlg = e2e.alg || 'ECDSA-P384-SHA384'; }
  }

  // Изображение
  if (imageFile) {
    const { cloudUrl, encAesForPeer, encAesForMe } = await encryptAndUpload(imageFile);
    // Шифруем Cloudinary URL (нужен для загрузки при расшифровке)
    const urlE2e = await enc(cloudUrl);
    msgData.e2eImgForPeer = JSON.stringify({ aes: encAesForPeer, url: urlE2e.forPeer });
    msgData.e2eImgForMe   = JSON.stringify({ aes: encAesForMe,   url: urlE2e.forMe  });
    // Если нет текста — Rules требуют хоть одно e2e-поле с непустой строкой
    if (!msgData.e2eForPeer) {
      const placeholder = await enc(''); // пустой текст — Rules допускают
      msgData.e2eForPeer = placeholder.forPeer;
      msgData.e2eForMe   = placeholder.forMe;
    }
  }

  // Голосовое сообщение
  if (voiceFile) {
    const { encAesForPeer, encAesForMe, cloudUrl } = await encryptAndUpload(voiceFile);
    const urlE2e = await enc(cloudUrl);
    msgData.e2eVoiceForPeer = JSON.stringify({ aes: encAesForPeer, url: urlE2e.forPeer });
    msgData.e2eVoiceForMe   = JSON.stringify({ aes: encAesForMe,   url: urlE2e.forMe  });
    if (voiceDuration != null) msgData.voiceDuration = voiceDuration;
    if (voiceMime)             msgData.voiceMime     = voiceMime;
    if (!msgData.e2eForPeer) {
      const placeholder = await enc(''); // пустой текст — Rules допускают
      msgData.e2eForPeer = placeholder.forPeer;
      msgData.e2eForMe   = placeholder.forMe;
    }
  }

  // Музыка
  if (musicFile) {
    const { encAesForPeer, encAesForMe, cloudUrl } = await encryptAndUpload(musicFile);
    const urlE2e = await enc(cloudUrl);
    msgData.e2eMusicForPeer = JSON.stringify({ aes: encAesForPeer, url: urlE2e.forPeer });
    msgData.e2eMusicForMe   = JSON.stringify({ aes: encAesForMe,   url: urlE2e.forMe  });
    if (musicDuration != null) msgData.musicDuration = musicDuration;
    if (musicMime)             msgData.musicMime     = musicMime;
    if (!msgData.e2eForPeer) {
      const placeholder = await enc(''); // пустой текст — Rules допускают
      msgData.e2eForPeer = placeholder.forPeer;
      msgData.e2eForMe   = placeholder.forMe;
    }
  }

  // Чеклист
  if (checklist && (Array.isArray(checklist) || typeof checklist === 'object')) {
    const normalizedChecklist = Array.isArray(checklist) ? { title: '', items: checklist, done: {} } : checklist;
    const serialized = JSON.stringify(normalizedChecklist);
    const e2e = await enc(serialized);
    msgData.e2eChecklistForPeer = e2e.forPeer;
    msgData.e2eChecklistForMe   = e2e.forMe;
    if (e2e.sig && !msgData.e2eSig) { msgData.e2eSig = e2e.sig; msgData.e2eSigAlg = e2e.alg || 'ECDSA-P384-SHA384'; }
    if (!msgData.e2eForPeer) {
      msgData.e2eForPeer = e2e.forPeer;
      msgData.e2eForMe   = e2e.forMe;
    }
  }

  // Цитата — шифруем текст цитаты
  if (replyTo) {
    const snippet   = (replyTo.text || '').slice(0, 100);
    const replyE2e  = await enc(snippet);
    msgData.replyTo = {
      id:         replyTo.id,
      author:     replyTo.author,
      text:       '',
      e2eForPeer: replyE2e.forPeer,
      e2eForMe:   replyE2e.forMe,
    };
  }

  if (forwarded) msgData.forwarded = true;

  // ── Подписываем весь зашифрованный payload ──
  // В отличие от подписи plaintext, это покрывает текст, медиа, чеклисты и replyTo.
  msgData.e2eCipherAlg = msgData.e2eCipherAlg || detectCipherAlg(msgData.e2eForPeer || msgData.e2eImgForPeer || msgData.e2eVoiceForPeer || msgData.e2eMusicForPeer || msgData.e2eChecklistForPeer || '');
  if (msgData.e2eCipherAlg === E2E_CIPHER_V4) {
    msgData.e2eRatchetAlg = E2E_CIPHER_V4;
    try {
      const env = JSON.parse(msgData.e2eForPeer || msgData.e2eImgForPeer || msgData.e2eVoiceForPeer || msgData.e2eMusicForPeer || msgData.e2eChecklistForPeer || '{}');
      if (typeof env.n === 'number') msgData.e2eRatchetN = env.n;
      if (typeof env.pn === 'number') msgData.e2eRatchetPN = env.pn;
    } catch (_) {}
  }
  {
    // Подпись ставится после сборки ВСЕХ полей: текст, медиа, чеклист, replyTo, ratchet metadata.
    const sig = await signEncryptedMessagePayload(msgData);
    if (sig) {
      msgData.e2eSig = sig;
      msgData.e2eSigAlg = 'ECDSA-P384-SHA384-PAYLOAD-V3';
    }
  }

  // ── Проверяем соответствие Firestore Rules ──
  const unknownFields = Object.keys(msgData).filter(k => !DM_ALLOWED_FIELDS.has(k));
  if (unknownFields.length)
    throw new Error(`[e2e] Недопустимые поля: ${unknownFields.join(', ')}`);

  // ── Сохраняем в Firestore ──
  await fsAddDoc(fsCollection(firestoreDb, 'dmConvs', convId, 'messages'), msgData);

  // Обновляем метаданные диалога
  const previewText = imageFile ? '🖼 Изображение'
                    : voiceFile ? '🎙 Голосовое'
                    : musicFile ? '🎵 Музыка'
                    : '🔒 Сообщение';
  await fsSetDoc(
    fsDoc(firestoreDb, 'dmConvs', convId),
    {
      lastText: previewText,
      lastAt:   fsServerTimestamp(),
      [`unread.${peerUid}`]: fsIncrement(1)
    },
    { merge: true }
  );
}

/* ═══════════════════════════════════════════════════════════════
   § 9  decryptMessage — универсальная расшифровка входящего ЛС
═══════════════════════════════════════════════════════════════ */

/**
 * Расшифровывает поля входящего DM-сообщения.
 *
 * Возвращает объект с расшифрованными полями (undefined если поля нет).
 *
 * @param {object}    msgData      — сырые данные из Firestore
 * @param {string}    myUid
 * @param {CryptoKey} myPrivateKey
 * @returns {Promise<{text?, imageObjectUrl?, voiceObjectUrl?, musicObjectUrl?, checklist?}>}
 */
async function decryptMessage(msgData, myUid, myPrivateKey, firestoreDb = null, fsDoc = null, fsGetDoc = null) {
  if (!myPrivateKey) return { text: '[🔒 Ключ не загружен]' };

  const result = {};
  if (msgData?.e2eSig) result.signature = await verifyEncryptedMessageSignature(msgData, firestoreDb, fsDoc, fsGetDoc);

  // Выбираем поле «для меня» или «для пира» (мы всегда расшифровываем своим ключом)
  const pick = (forPeerField, forMeField) => {
    const isMine = msgData.uid === myUid;
    // Если мы отправитель — берём forMe (он зашифрован нашим публичным ключом)
    // Если мы получатель — берём forPeer
    return isMine
      ? (msgData[forMeField]   || msgData[forPeerField])
      : (msgData[forPeerField] || msgData[forMeField]);
  };

  // ── Текст ──
  const textCipher = pick('e2eForPeer', 'e2eForMe');
  if (textCipher) {
    try {
      result.text = await rsaDecrypt(myPrivateKey, textCipher);
    } catch {
      result.text = '[🔒 Не удалось расшифровать]';
    }
  }

  // ── Изображение ──
  const imgRaw = pick('e2eImgForPeer', 'e2eImgForMe');
  if (imgRaw) {
    try {
      const { aes, url: encUrl } = JSON.parse(imgRaw);
      // Расшифровываем Cloudinary URL
      const cloudUrl   = await rsaDecrypt(myPrivateKey, encUrl);
      // Расшифровываем AES-ключ
      const aesHex     = await rsaDecrypt(myPrivateKey, aes);
      // Загружаем и расшифровываем файл
      result.imageObjectUrl = await decryptMediaUrl(myPrivateKey, aes, cloudUrl);
    } catch {
      result.imageObjectUrl = null; // отображать заглушку
    }
  }

  // ── Голосовое ──
  const voiceRaw = pick('e2eVoiceForPeer', 'e2eVoiceForMe');
  if (voiceRaw) {
    try {
      const { aes, url: encUrl } = JSON.parse(voiceRaw);
      const cloudUrl = await rsaDecrypt(myPrivateKey, encUrl);
      result.voiceObjectUrl = await decryptMediaUrl(myPrivateKey, aes, cloudUrl);
    } catch {
      result.voiceObjectUrl = null;
    }
  }

  // ── Музыка ──
  const musicRaw = pick('e2eMusicForPeer', 'e2eMusicForMe');
  if (musicRaw) {
    try {
      const { aes, url: encUrl } = JSON.parse(musicRaw);
      const cloudUrl = await rsaDecrypt(myPrivateKey, encUrl);
      result.musicObjectUrl = await decryptMediaUrl(myPrivateKey, aes, cloudUrl);
    } catch {
      result.musicObjectUrl = null;
    }
  }

  // ── Чеклист ──
  const checklistCipher = pick('e2eChecklistForPeer', 'e2eChecklistForMe');
  if (checklistCipher) {
    try {
      const json = await rsaDecrypt(myPrivateKey, checklistCipher);
      result.checklist = JSON.parse(json);
    } catch {
      result.checklist = null;
    }
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════
   § 10  МОДЕРАЦИЯ через бэкенд (убираем Perspective API из фронта)
═══════════════════════════════════════════════════════════════ */

/**
 * Проверяет текст на токсичность через Python-бэкенд (server.py).
 * API-ключ Perspective хранится ТОЛЬКО на сервере.
 *
 * Эндпоинт: POST /api/moderate
 * Body:      { text: string }
 * Response:  { toxic: boolean, score: number }
 *
 * @param {string} text
 * @returns {Promise<boolean>}  true = токсично
 */
async function checkToxicity(text) {
  if (!text || text.trim().length < 3) return false;
  try {
    const getToken = window.firebaseAuthCurrentUserToken || window.getFirebaseIdToken;
    let idToken = '';
    if (typeof getToken === 'function') {
      try { idToken = await getToken(); } catch (_) { idToken = ''; }
    }
    const headers = { 'Content-Type': 'application/json' };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    const resp = await fetch(`${BACKEND_URL}/moderate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: text.trim() }),
      signal: AbortSignal.timeout(8000)  // 8 сек таймаут
    });
    if (!resp.ok) {
      console.warn('[moderation] Бэкенд вернул:', resp.status);
      return true; // fail-closed: если проверка сломалась, блокируем отправку
    }
    const { toxic } = await resp.json();
    return !!toxic;
  } catch (e) {
    console.warn('[moderation] Недоступен бэкенд:', e.message);
    return true;
  }
}

/**
 * Загружает файл на Cloudinary через бэкенд-прокси (убираем upload_preset из фронта).
 *
 * Эндпоинт: POST /api/upload
 * Body:      FormData { file: Blob, type: 'image'|'video'|'raw' }
 * Response:  { url: string }
 *
 * @param {Blob}      blob
 * @param {Function}  [onProgress]  — (percent: number) => void
 * @param {string}    [type]        — mime category
 * @returns {Promise<string>}  Cloudinary secure_url
 */
async function uploadViaBackend(blob, onProgress, type = 'raw') {
  const fd = new FormData();
  fd.append('file', blob);
  fd.append('type', type);

  const getToken = window.firebaseAuthCurrentUserToken || window.getFirebaseIdToken;
  let idToken = '';
  if (typeof getToken === 'function') {
    try { idToken = await getToken(); } catch (_) { idToken = ''; }
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND_URL}/upload`);
    xhr.timeout = 60_000;
    if (idToken) xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);

    if (onProgress) {
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && data.url?.startsWith('https://')) resolve(data.url);
        else reject(new Error(data.detail || data.error || 'Бэкенд не вернул URL'));
      } catch { reject(new Error('Ответ бэкенда не является JSON')); }
    });
    xhr.addEventListener('error',   () => reject(new Error('Ошибка сети при загрузке')));
    xhr.addEventListener('timeout', () => reject(new Error('Загрузка превысила 60 секунд')));
    xhr.send(fd);
  });
}

/* ═══════════════════════════════════════════════════════════════
   § 11  ЭКСПОРТ В ГЛОБАЛЬНЫЙ ОБЪЕКТ window.E2E
═══════════════════════════════════════════════════════════════ */

window.E2E = {
  // Ключи
  initE2EForUser,
  savePrivateKey,
  loadPrivateKey,
  hasStoredPrivateKey,
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  fingerprintPublicKeyB64,
  verifyDMPlaintextSignature,
  signDMPlaintext,
  revokeE2EObjectUrls,

  // Шифрование текста
  rsaEncrypt,
  rsaDecrypt,
  rsaDecryptLegacy,
  encryptDM,
  verifyEncryptedMessageSignature,
  signEncryptedMessagePayload,
  ensureEcdhKeyPair,
  ratchetEncryptForPublicKeyB64,
  ratchetDecryptEnvelope,
  loadRatchetState,
  clearRatchetState,

  // Шифрование медиа
  encryptBlob,
  decryptBuffer,
  decryptMediaUrl,

  // Сообщения
  sendDirectMessage,
  decryptMessage,

  // Модерация и загрузка (через бэкенд)
  checkToxicity,
  uploadViaBackend,

  // Утилиты
  bufferToHex,
  hexToBuffer,
  openIDB,
  idbGet,
  idbSet,
  idbDelete,
  idbKeys,
  resetLocalE2EStorage,
  changeMasterPassword,
  detectCipherAlg,
  getOrCreateDeviceId,
  currentDeviceFingerprint,
  registerCurrentDevice,
  getTrustedPeerKey,
  setTrustedPeerKey,
  ensurePeerKeyTrusted,
  lockE2EKeys,
  setupE2EAutoLock,
  validateMasterPasswordStrength,
};

console.info('[E2E] Security module v2.0 загружен');
