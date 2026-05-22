import { getApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, addDoc, updateDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const ADMINS = new Set(['iMey77WyBccVB1wVFlqdWlrviLx2']);
let auth = null;
let db = null;
let lastReportRow = null;
let reportsUnsub = null;
let inboxUnsub = null;
let lastInjectAt = 0;

function waitApp() {
  return new Promise(resolve => {
    const tick = () => getApps().length ? resolve(getApp()) : setTimeout(tick, 80);
    tick();
  });
}

function esc(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function toast(text) {
  const el = document.getElementById('toast');
  if (!el) { console.log('[reports]', text); return; }
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-on'), 2600);
}

function modal(id, title, html) {
  document.getElementById(id)?.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99991;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;backdrop-filter:blur(6px)';
  overlay.innerHTML = `<div style="width:min(580px,100%);max-height:86vh;overflow:auto;background:var(--surface,#141827);color:var(--text,#fff);border:1px solid var(--border-strong,rgba(255,255,255,.14));border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.55)"><div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.1))"><b>${esc(title)}</b><button data-close style="border:0;background:transparent;color:var(--muted,#aaa);font-size:24px;cursor:pointer">×</button></div><div style="padding:18px 20px">${html}</div></div>`;
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-close]')) overlay.remove();
  });
  document.body.appendChild(overlay);
  return overlay;
}

function rememberTarget(e) {
  const bubble = e.target?.closest?.('.msg-bubble');
  const row = bubble?.closest?.('.msg-row[data-id],.msg-row[data-msg-id]');
  if (row) lastReportRow = row;
}

function injectReportButton() {
  const now = Date.now();
  if (now - lastInjectAt < 60) return;
  lastInjectAt = now;

  const menu = document.getElementById('ctxMenu');
  if (!menu || !menu.classList.contains('is-open') || !lastReportRow) return;
  if (menu.querySelector('[data-report-message]')) return;

  const divider = document.createElement('div');
  divider.className = 'ctx-menu__divider';
  divider.setAttribute('data-report-divider', '1');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-menu__btn danger';
  btn.setAttribute('data-report-message', '1');
  btn.innerHTML = '<span class="ctx-ico">🚩</span><span>Пожаловаться</span>';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.remove('is-open');
    document.getElementById('sheetBackdrop')?.classList.remove('is-on');
    openReport(lastReportRow);
  });

  menu.append(divider, btn);
}

// No MutationObserver: inject only immediately after the user opens a message menu.
document.addEventListener('contextmenu', e => {
  rememberTarget(e);
  setTimeout(injectReportButton, 40);
  setTimeout(injectReportButton, 120);
}, true);

document.addEventListener('pointerdown', e => {
  rememberTarget(e);
  setTimeout(injectReportButton, 650);
}, true);

async function openReport(row) {
  const u = auth?.currentUser;
  if (!u) return toast('Нужно войти');
  const id = row?.dataset?.id || row?.dataset?.msgId;
  if (!id) return toast('Сообщение не найдено');

  let snap;
  try { snap = await getDoc(doc(db, 'messages', id)); }
  catch (_) { return toast('Ошибка чтения сообщения'); }
  if (!snap.exists()) return toast('Сообщение удалено');

  const m = snap.data() || {};
  if (String(m.uid || '') === String(u.uid)) return toast('На своё сообщение жалоба не нужна');
  const text = String(row.dataset.plain || m.text || '').slice(0, 700);

  const overlay = modal('reportModal', '🚩 Жалоба', `<div style="display:grid;gap:12px"><div><b>На кого:</b> ${esc(m.author || m.uid || '')}</div><div style="white-space:pre-wrap;padding:12px;border-radius:14px;background:var(--surface-2,#202638);border:1px solid var(--border,rgba(255,255,255,.12))">${esc(text || 'Сообщение без текста')}</div><select id="rpReason" style="padding:11px;border-radius:12px;background:var(--surface-2,#202638);color:inherit;border:1px solid var(--border-strong,rgba(255,255,255,.16))"><option value="insult">Оскорбление</option><option value="threat">Угроза</option><option value="spam">Спам</option><option value="other">Другое</option></select><textarea id="rpNote" maxlength="700" rows="4" placeholder="Комментарий" style="resize:vertical;padding:12px;border-radius:12px;background:var(--surface-2,#202638);color:inherit;border:1px solid var(--border-strong,rgba(255,255,255,.16))"></textarea><button id="rpSend" style="padding:12px;border:0;border-radius:14px;background:var(--accent,#63b3ff);color:var(--accent-text,#06121d);font-weight:800;cursor:pointer">Отправить ADMIN</button></div>`);

  overlay.querySelector('#rpSend').addEventListener('click', async () => {
    try {
      await addDoc(collection(db, 'reports'), {
        reporterUid: u.uid,
        reporterName: u.displayName || u.email || 'user',
        reportedUid: String(m.uid || ''),
        reportedName: String(m.author || ''),
        messageId: id,
        messageText: text,
        reason: overlay.querySelector('#rpReason').value,
        note: overlay.querySelector('#rpNote').value.trim(),
        chatType: 'group',
        status: 'open',
        createdAt: serverTimestamp()
      });
      overlay.remove();
      toast('🚩 Жалоба отправлена');
    } catch (e) {
      toast('Ошибка жалобы: ' + (e.message || e));
    }
  });
}

function ensureAdminButton() {
  const u = auth?.currentUser;
  if (!u || !ADMINS.has(u.uid) || document.getElementById('adminReportsBtn')) return;
  const host = document.querySelector('.sidebar-footer') || document.getElementById('tgSidebar') || document.body;
  const btn = document.createElement('button');
  btn.id = 'adminReportsBtn';
  btn.type = 'button';
  btn.textContent = '🚩 Жалобы';
  btn.style.cssText = 'margin-left:6px;padding:8px 10px;border-radius:12px;border:1px solid var(--border-strong,rgba(255,255,255,.16));background:var(--surface-2,#202638);color:var(--text,#fff);font-weight:800;cursor:pointer';
  btn.addEventListener('click', openAdmin);
  host.appendChild(btn);
}

function openAdmin() {
  const u = auth?.currentUser;
  if (!u || !ADMINS.has(u.uid)) return;
  const overlay = modal('adminReportsModal', '🚩 Жалобы', '<div id="reportsList">Загрузка...</div>');
  const list = overlay.querySelector('#reportsList');
  reportsUnsub?.();
  reportsUnsub = onSnapshot(query(collection(db, 'reports'), orderBy('createdAt', 'desc'), limit(80)), snap => {
    const arr = snap.docs.map(x => ({ id: x.id, ...x.data() }));
    list.innerHTML = arr.length ? arr.map(r => `<div data-r="${esc(r.id)}" style="display:grid;gap:8px;margin-bottom:10px;padding:12px;border-radius:16px;background:var(--surface-2,#202638);border:1px solid var(--border,rgba(255,255,255,.12))"><b>${esc(r.reportedName || r.reportedUid)}</b><small>от ${esc(r.reporterName || r.reporterUid)} · ${esc(r.status || 'open')}</small><div style="white-space:pre-wrap">${esc(r.messageText || '')}</div>${r.note ? `<small>Комментарий: ${esc(r.note)}</small>` : ''}<button data-limit>Ограничить аккаунт</button><button data-ok>Оставить</button><button data-reply>Ответить</button></div>`).join('') : 'Жалоб нет';
    list.querySelectorAll('[data-r]').forEach(card => {
      const r = arr.find(x => x.id === card.dataset.r);
      card.querySelector('[data-limit]').onclick = () => limitUser(r);
      card.querySelector('[data-ok]').onclick = () => closeReport(r);
      card.querySelector('[data-reply]').onclick = () => reply(r);
    });
  }, err => { list.textContent = 'Ошибка загрузки жалоб: ' + err.message; });
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { reportsUnsub?.(); reportsUnsub = null; }
  });
}

async function limitUser(r) {
  if (!r?.reportedUid) return toast('Нет UID нарушителя');
  try {
    await updateDoc(doc(db, 'users', r.reportedUid), { banned: true });
    await updateDoc(doc(db, 'reports', r.id), { status: 'restricted', handledAt: serverTimestamp(), adminUid: auth.currentUser.uid });
    toast('Аккаунт ограничен');
  } catch (e) { toast('Ошибка: ' + e.message); }
}

async function closeReport(r) {
  try {
    await updateDoc(doc(db, 'reports', r.id), { status: 'dismissed', handledAt: serverTimestamp(), adminUid: auth.currentUser.uid });
    toast('Жалоба закрыта');
  } catch (e) { toast('Ошибка: ' + e.message); }
}

async function reply(r) {
  const text = prompt('Ответ автору жалобы:');
  if (!text?.trim()) return;
  try {
    await addDoc(collection(db, 'adminInbox', r.reporterUid, 'messages'), { reportId: r.id, text: text.trim().slice(0, 900), read: false, createdAt: serverTimestamp() });
    await updateDoc(doc(db, 'reports', r.id), { adminMessage: text.trim().slice(0, 900), answeredAt: serverTimestamp(), adminUid: auth.currentUser.uid });
    toast('Ответ отправлен');
  } catch (e) { toast('Ошибка: ' + e.message); }
}

function inbox(uid) {
  inboxUnsub?.();
  inboxUnsub = onSnapshot(query(collection(db, 'adminInbox', uid, 'messages'), orderBy('createdAt', 'desc'), limit(10)), snap => {
    snap.docs.forEach(async d => {
      const m = d.data();
      if (m.read) return;
      modal('adminReplyModal', '✉️ Ответ ADMIN', `<p style="white-space:pre-wrap">${esc(m.text || '')}</p><button data-close>Понятно</button>`);
      try { await updateDoc(doc(db, 'adminInbox', uid, 'messages', d.id), { read: true }); } catch (_) {}
    });
  }, () => {});
}

(async function initReports() {
  const app = await waitApp();
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, u => {
    if (!u) return;
    setTimeout(ensureAdminButton, 700);
    setTimeout(ensureAdminButton, 2000);
    inbox(u.uid);
  });
  console.log('[chat6a] reports UI loaded safely');
})();
