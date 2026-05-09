import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCtVaVgIvQot9SJpwKyUKrClNwar6xX9fo',
  authDomain: 'class6a-chat.firebaseapp.com',
  projectId: 'class6a-chat',
  storageBucket: 'class6a-chat.firebasestorage.app',
  messagingSenderId: '656933440681',
  appId: '1:656933440681:web:e7a8c2ae22181ec98f2db8'
};

const FAKE_DOMAIN = '@6a.ru';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUid = null;
// localStorage key — используется как fallback / кэш пока грузится Firestore
function userKey(uid) { return 'cv3_u_' + uid; }

// ── СОХРАНИТЬ в Firestore + localStorage (кэш) ────────
async function saveUser() {
  if (!currentUid) return;
  // Сохраняем всё кроме coins в localStorage (ставки, статистика игр)
  try { localStorage.setItem(userKey(currentUid), JSON.stringify(S)); } catch(e) {}
  // Синхронизируем ТОЛЬКО звёзды в Firestore — единый баланс для всех страниц
  try {
    await setDoc(doc(db, 'users', currentUid), { stars: S.coins }, { merge: true });
  } catch(e) { console.warn('Firestore save error:', e); }
}

// ── ЗАГРУЗИТЬ из Firestore + localStorage ─────────────
async function loadUser(uid) {
  // 1. Сначала сбрасываем к дефолтам
  S.coins = 1000;
  S.owned = ['blackjack','lucky','slots','roulette','hilo'];
  S.lastDaily = 0;
  S.bj = {bet:25,wins:0,losses:0,draws:0,gain:0};
  S.pk = {wins:0,losses:0};
  S.kosBet=50; S.paukBet=75; S.dkBet=40; S.luckyBet=25; S.slotsBet=25; S.rouletteBet=25; S.hiloBet=25;
  // 2. Грузим локальные данные (ставки, статы) из localStorage
  try {
    const d = localStorage.getItem(userKey(uid));
    if (d) Object.assign(S, JSON.parse(d));
  } catch(e) {}
  // Fix types
  const defBj={bet:25,wins:0,losses:0,draws:0,gain:0};
  S.bj=(S.bj&&typeof S.bj==='object')?Object.assign({},defBj,S.bj):defBj;
  S.pk=(S.pk&&typeof S.pk==='object')?Object.assign({wins:0,losses:0},S.pk):{wins:0,losses:0};
  if(!Array.isArray(S.owned))S.owned=['blackjack','lucky','slots','roulette','hilo'];
  S.owned=[...new Set(S.owned)];
  ['blackjack','lucky','slots','roulette','hilo'].forEach(id=>{if(!S.owned.includes(id))S.owned.push(id);});
  S.bj.bet=Math.min(1000,Math.max(10,S.bj.bet==null?25:+S.bj.bet));
  // 3. ГЛАВНОЕ: перезаписываем coins из Firestore (единый баланс!)
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists() && snap.data().stars != null) {
      S.coins = snap.data().stars;
    } else if (!snap.exists()) {
      // Новый пользователь — создаём документ с начальным балансом
      await setDoc(doc(db, 'users', uid), { stars: S.coins }, { merge: true });
    }
  } catch(e) { console.warn('Firestore load error:', e); }
  // Обновляем UI
  syncCoins(false);
  renderHome();
  renderShop();
  paintAllBets();
  bjStats();
  luckyRender();
  hiloEnsure();
  try{rlInit();}catch(_){}
}

// Patch global save() — теперь вызывает async saveUser
const _origSave = window.save;
window.save = function() {
  if (_origSave) _origSave();
  saveUser(); // fire-and-forget async
};

// ── HELPERS ──────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function nickFromInput(raw) {
  let n = String(raw || '').trim();
  if (n.toLowerCase().endsWith(FAKE_DOMAIN.toLowerCase()))
    n = n.slice(0, n.length - FAKE_DOMAIN.length).trim();
  return n;
}
function nickToEmail(raw) {
  const n = nickFromInput(raw);
  if (!n) throw new Error('Введите ник');
  return n + FAKE_DOMAIN;
}
function displayNick(u) {
  if (!u) return '?';
  if (u.displayName) return u.displayName;
  const em = u.email || '';
  if (em.toLowerCase().endsWith(FAKE_DOMAIN.toLowerCase()))
    return em.slice(0, em.length - FAKE_DOMAIN.length) || '?';
  const at = em.indexOf('@');
  return at > 0 ? em.slice(0, at) : (em || '?');
}
function avatarGrad(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return `linear-gradient(135deg,hsl(${h%360} 65% 48%) 0%,hsl(${(h%360+38)%360} 58% 42%) 100%)`;
}
function initials(name) { return ([...String(name || '?')][0] || '?').toUpperCase(); }

// ── AUTH BUTTONS ─────────────────────────────────────
el('btn-register-mode').onclick = () => {
  el('btn-register').style.display = 'block';
  el('btn-back-login').style.display = 'block';
  el('btn-login').style.display = 'none';
  el('btn-register-mode').parentElement.style.display = 'none';
  el('auth-error').textContent = '';
};
el('btn-back-login').onclick = () => {
  el('btn-register').style.display = 'none';
  el('btn-back-login').style.display = 'none';
  el('btn-login').style.display = 'block';
  el('btn-register-mode').parentElement.style.display = 'flex';
  el('auth-error').textContent = '';
};

el('btn-login').onclick = async () => {
  el('auth-error').textContent = '';
  el('btn-login').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, nickToEmail(el('auth-nick').value), el('auth-pass').value);
  } catch(e) {
    el('auth-error').textContent = e.code === 'auth/invalid-credential' ? 'Неверный ник или пароль' : (e.message || String(e));
  } finally { el('btn-login').disabled = false; }
};

el('btn-register').onclick = async () => {
  el('auth-error').textContent = '';
  el('btn-register').disabled = true;
  try {
    const nick = nickFromInput(el('auth-nick').value);
    if (!nick) { el('auth-error').textContent = 'Введите ник'; return; }
    if (el('auth-pass').value.length < 6) { el('auth-error').textContent = 'Пароль мин. 6 символов'; return; }
    const cred = await createUserWithEmailAndPassword(auth, nickToEmail(nick), el('auth-pass').value);
    await updateProfile(cred.user, { displayName: nick });
    // Сохраняем displayName в Firestore сразу при регистрации
    try {
      await setDoc(doc(db, 'users', cred.user.uid), { displayName: nick, uid: cred.user.uid, stars: 1000, email: cred.user.email || '' }, { merge: true });
    } catch(_) {}
  } catch(e) {
    el('auth-error').textContent = e.code === 'auth/email-already-in-use' ? 'Этот ник уже занят' : (e.message || String(e));
  } finally { el('btn-register').disabled = false; }
};

el('auth-nick').addEventListener('keydown', e => { if(e.key==='Enter') el('auth-pass').focus(); });
el('auth-pass').addEventListener('keydown', e => { if(e.key==='Enter') el('btn-login').click(); });

// ── LOGOUT ───────────────────────────────────────────
window.doLogout = () => signOut(auth);

// ── ADMIN ────────────────────────────────────────────
window.adminGetMillion = async function() {
  if (!currentUid) return;
  const btn = document.getElementById('btn-admin-million');
  const msg = document.getElementById('admin-msg');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = 'Зачисляем...';
  try {
    const snap = await getDoc(doc(db, 'users', currentUid));
    const currentStars = snap.exists() && snap.data().stars != null ? snap.data().stars : S.coins;
    const newStars = currentStars + 1000000;
    await setDoc(doc(db, 'users', currentUid), { stars: newStars }, { merge: true });
    S.coins = newStars;
    if (window.syncCoins) window.syncCoins(false);
    else { const el = document.getElementById('coins-display'); if(el) el.textContent = newStars.toLocaleString('ru'); }
    if (msg) msg.textContent = '✓ +1 000 000 ⭐ зачислено!';
    // Re-enable after 5 seconds
    setTimeout(() => { if (btn) btn.disabled = false; if (msg) msg.textContent = ''; }, 5000);
  } catch(e) {
    if (msg) msg.textContent = 'Ошибка: ' + (e.message || e);
    if (btn) btn.disabled = false;
  }
};

// ── AUTH STATE ───────────────────────────────────────
let _banUnsubscribe4 = null;

function showBanned4() {
  if (_banUnsubscribe4) { _banUnsubscribe4(); _banUnsubscribe4 = null; }
  currentUid = null;
  // Скрыть всё приложение
  el('auth-gate').style.display = 'none';
  el('main-app').style.display = 'none';
  // Показать экран бана
  el('banned-screen').classList.add('is-visible');

  el('banned-logout-btn').onclick = async () => {
    await signOut(auth).catch(() => {});
    el('banned-sub-text').innerHTML = 'Ты вышел из аккаунта.<br>Можешь создать новый.';
    el('banned-logout-btn').style.display = 'none';
    el('banned-register-btn').style.display = 'block';
  };
  el('banned-register-btn').onclick = () => {
    el('banned-screen').classList.remove('is-visible');
    el('auth-gate').style.display = 'block';
    // Сразу переключить на режим регистрации
    el('btn-register-mode').click();
  };
}

onAuthStateChanged(auth, async user => {
  if (_banUnsubscribe4) { _banUnsubscribe4(); _banUnsubscribe4 = null; }
  if (!user) {
    currentUid = null;
    el('auth-gate').style.display = 'block';
    el('main-app').style.display = 'none';
    return;
  }

  // ── ПРОВЕРКА БАНА при входе ────────────────────────────
  try {
    const banSnap = await getDoc(doc(db, 'users', user.uid));
    if (banSnap.exists() && banSnap.data().banned === true) {
      showBanned4(); return;
    }
  } catch(e) { console.warn('ban check error:', e); }
  // ── REALTIME: мгновенно реагируем на ликвидацию ───────
  _banUnsubscribe4 = onSnapshot(doc(db, 'users', user.uid), snap => {
    if (snap.exists() && snap.data().banned === true) showBanned4();
  });
  // ───────────────────────────────────────────────────────

  currentUid = user.uid;

  // Гарантируем что displayName сохранён в Firestore (важно для ликвидации)
  const nick = displayNick(user);
  try {
    await setDoc(doc(db, 'users', user.uid), { displayName: nick, uid: user.uid, email: user.email || '' }, { merge: true });
  } catch(_) {}

  // Update nav immediately (не ждём загрузки звёзд)
  const av = el('nav-avatar');
  av.style.background = avatarGrad(user.uid);
  av.textContent = initials(nick);
  el('nav-username').textContent = nick;
  el('auth-gate').style.display = 'none';
  el('main-app').style.display = 'block';

  // Загружаем звёзды из Firestore (async — UI обновится внутри loadUser)
  await loadUser(user.uid);

  // ADMIN panel — show only for user with name "ADMIN"
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) {
    const isAdmin = nick.toUpperCase() === 'ADMIN';
    adminPanel.style.display = isAdmin ? 'block' : 'none';
  }
});
