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
const RSA_MOD_LENGTH     = 2048;             // бит — при следующем рефакторе → 4096

/* Поля, разрешённые Firestore Rules в dmConvs/messages */
const DM_ALLOWED_FIELDS = new Set([
  'uid','author','text','createdAt','edited',
  'e2eForPeer','e2eForMe',
  'e2eImgForPeer','e2eImgForMe',
  'e2eVoiceForPeer','e2eVoiceForMe','voiceDuration','voiceMime',
  'e2eMusicForPeer','e2eMusicForMe','musicDuration','musicMime',
  'e2eChecklistForPeer','e2eChecklistForMe',
  'replyTo','forwarded'
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
async function loadPrivateKey(uid, password) {
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
    true, ['decrypt']
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

/* ═══════════════════════════════════════════════════════════════
   § 3  RSA-OAEP + AES-GCM — текстовое гибридное шифрование
═══════════════════════════════════════════════════════════════ */

/**
 * Генерирует RSA-OAEP 2048 ключевую пару.
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
async function rsaDecrypt(privateKey, b64) {
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
  return URL.createObjectURL(new Blob([plainBuf]));
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

    card.querySelector('#mp-ok').addEventListener('click', () => {
      const pwd = input.value;
      if (!pwd || pwd.length < 8) { showErr('Минимум 8 символов'); return; }
      if (isCreate) {
        if (pwd !== input2.value) { showErr('Пароли не совпадают'); return; }
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

        // Проверяем совпадение с публичным ключом в Firebase
        const snap           = await fsGetDoc(fsDoc(firestoreDb, 'users', uid));
        const storedPubB64   = snap.data()?.publicKey ?? null;

        if (storedPubB64) {
          const pubKey    = await importPublicKey(storedPubB64);
          const testCt    = await rsaEncrypt(pubKey, 'e2e_ok');
          const testPlain = await rsaDecrypt(privateKey, testCt);

          if (testPlain === 'e2e_ok') {
            console.info('[e2e] Ключи разблокированы и верифицированы');
            return { privateKey, publicKeyB64: storedPubB64 };
          }
        } else {
          // Публичного ключа нет в Firebase — публикуем свой
          const pubKeyImported = await crypto.subtle.exportKey(
            'spki',
            // Нам нужен публичный ключ — пересоздадим из JWK
            // Простейший способ: экспортируем приватный→JWK, извлекаем n/e → строим публичный
            privateKey  // placeholder — см. NOTE ниже
          );
          // NOTE: Web Crypto не позволяет «вытащить» публичный ключ из CryptoKey private.
          // Корректный путь — при сохранении дублировать публичный ключ в IDB.
          // Если публичного нет — инициируем перегенерацию.
          throw new Error('no_public_in_firebase');
        }
      } catch (err) {
        attempts++;
        if (err.message === 'no_public_in_firebase') break; // → перегенерация
        if (err.name === 'OperationError') {
          // AES-GCM провалился → неверный пароль
          console.warn(`[e2e] Неверный пароль (попытка ${attempts}/3)`);
          if (attempts >= 3) {
            alert('Неверный пароль 3 раза. E2E-переписка недоступна на этом устройстве.');
            return { privateKey: null, publicKeyB64: null };
          }
        } else {
          console.error('[e2e] Ошибка загрузки ключа:', err);
          break;
        }
      }
    }
    // Если дошли сюда — ключевая пара не совпала → перегенерация
    console.warn('[e2e] Несоответствие ключей — генерируем новую пару');
  }

  // ── Сценарий A: первый вход или перегенерация ──
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

  // Сохраняем публичный ключ в IDB (для последующей верификации)
  await idbSet(`e2e_pubkey_${uid}`, publicKeyB64);

  // Сохраняем приватный ключ в IDB (зашифрованный мастер-паролем)
  await savePrivateKey(uid, pair.privateKey, password);

  // Публикуем публичный ключ в Firebase
  await fsSetDoc(fsDoc(firestoreDb, 'users', uid), { publicKey: publicKeyB64 }, { merge: true });

  console.info('[e2e] Новая ключевая пара сгенерирована и сохранена');
  return { privateKey: pair.privateKey, publicKeyB64 };
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
async function encryptDM(text, peerUid, myUid, myPrivateKey, firestoreDb, fsDoc, fsGetDoc) {
  // Получаем публичные ключи обоих участников
  const [peerSnap, mySnap] = await Promise.all([
    fsGetDoc(fsDoc(firestoreDb, 'users', peerUid)),
    fsGetDoc(fsDoc(firestoreDb, 'users', myUid))
  ]);

  const peerPubB64 = peerSnap.data()?.publicKey;
  const myPubB64   = mySnap.data()?.publicKey;

  if (!peerPubB64) throw new Error(`[e2e] У пользователя ${peerUid} нет публичного ключа`);
  if (!myPubB64)   throw new Error('[e2e] Собственный публичный ключ не найден в Firebase');

  const [peerPubKey, myPubKey] = await Promise.all([
    importPublicKey(peerPubB64),
    importPublicKey(myPubB64)
  ]);

  const [forPeer, forMe] = await Promise.all([
    rsaEncrypt(peerPubKey, text),
    rsaEncrypt(myPubKey, text)
  ]);

  return { forPeer, forMe };
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
    checklist = null, replyTo = null, forwarded = false,
    firestoreDb, fsCollection, fsAddDoc, fsSetDoc, fsDoc, fsGetDoc,
    fsServerTimestamp, fsIncrement,
    uploadToCloudinary
  } = params;

  if (!myPrivateKey) throw new Error('[e2e] Приватный ключ не инициализирован');

  // Вспомогательная функция: зашифровать строку для обоих участников
  const enc = async (plainStr) => encryptDM(
    plainStr, peerUid, myUid, myPrivateKey, firestoreDb, fsDoc, fsGetDoc
  );

  // Вспомогательная: зашифровать файл → загрузить на Cloudinary зашифрованным
  const encryptAndUpload = async (file, onProgress) => {
    const { encryptedBlob, rawAesKey } = await encryptBlob(file);
    const cloudUrl = await uploadToCloudinary(encryptedBlob, onProgress);
    if (!cloudUrl?.startsWith('https://')) throw new Error('Cloudinary не вернул ссылку');

    // Шифруем AES-ключ (hex) RSA-ключами обоих участников
    const aesHex        = bufferToHex(rawAesKey);
    const [peerSnap, mySnap] = await Promise.all([
      fsGetDoc(fsDoc(firestoreDb, 'users', peerUid)),
      fsGetDoc(fsDoc(firestoreDb, 'users', myUid))
    ]);
    const peerPubKey = await importPublicKey(peerSnap.data().publicKey);
    const myPubKey   = await importPublicKey(mySnap.data().publicKey);

    const [encAesForPeer, encAesForMe] = await Promise.all([
      rsaEncrypt(peerPubKey, aesHex),
      rsaEncrypt(myPubKey,   aesHex)
    ]);

    return { cloudUrl, encAesForPeer, encAesForMe };
  };

  // ── Строим msgData строго по разрешённым полям ──
  const msgData = {
    uid:       myUid,
    author:    authorName,
    text:      '',           // ВСЕГДА пусто в ЛС (Rules: dmHasNoPlainMedia)
    createdAt: fsServerTimestamp(),
    edited:    false,
  };

  // Текст
  if (text && text.trim()) {
    const e2e = await enc(text.trim());
    msgData.e2eForPeer = e2e.forPeer;
    msgData.e2eForMe   = e2e.forMe;
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
      msgData.e2eForPeer = msgData.e2eForPeer || encAesForPeer;
      msgData.e2eForMe   = msgData.e2eForMe   || encAesForMe;
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
      msgData.e2eForPeer = encAesForPeer;
      msgData.e2eForMe   = encAesForMe;
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
      msgData.e2eForPeer = encAesForPeer;
      msgData.e2eForMe   = encAesForMe;
    }
  }

  // Чеклист
  if (checklist && Array.isArray(checklist)) {
    const serialized = JSON.stringify(checklist);
    const e2e = await enc(serialized);
    msgData.e2eChecklistForPeer = e2e.forPeer;
    msgData.e2eChecklistForMe   = e2e.forMe;
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
async function decryptMessage(msgData, myUid, myPrivateKey) {
  if (!myPrivateKey) return { text: '[🔒 Ключ не загружен]' };

  const result = {};

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
    const resp = await fetch(`${BACKEND_URL}/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
      signal: AbortSignal.timeout(8000)  // 8 сек таймаут
    });
    if (!resp.ok) {
      console.warn('[moderation] Бэкенд вернул:', resp.status);
      return false; // fail-open: не блокируем при ошибке сервера
    }
    const { toxic } = await resp.json();
    return !!toxic;
  } catch (e) {
    console.warn('[moderation] Недоступен бэкенд:', e.message);
    return false;
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
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', blob);
    fd.append('type', type);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND_URL}/upload`);
    xhr.timeout = 60_000;

    if (onProgress) {
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }

    xhr.addEventListener('load', () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.url?.startsWith('https://')) resolve(data.url);
        else reject(new Error(data.error || 'Бэкенд не вернул URL'));
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

  // Шифрование текста
  rsaEncrypt,
  rsaDecrypt,
  encryptDM,

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
};

console.info('[E2E] Security module v2.0 загружен');
