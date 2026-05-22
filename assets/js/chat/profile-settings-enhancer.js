import { getApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, getDocs, updateDoc, deleteDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const LS = {
  theme: 'index6a_theme',
  style: 'index6a_ui_style_v2',
  skin: 'index6a_ui_skin_v2',
  radius: 'index6a_ui_radius_v1',
  density: 'index6a_ui_density_v1',
  motion: 'index6a_ui_motion_v1',
  glass: 'index6a_ui_glass_v1',
  performance: 'index6a_ui_performance_v1',
  textScale: 'index6a_ui_text_scale_v1',
  shadows: 'index6a_ui_shadows_v1',
  accent: 'index6a_ui_accent_v1',
  privacyBlur: 'index6a_privacy_blur_v1',
  hideNotifText: 'index6a_hide_notification_text_v1'
};

let auth = null;
let db = null;
let currentUser = null;
let settingsBtnReady = false;

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
  if (!el) { console.log('[profile-settings]', text); return; }
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-on'), 2600);
}

function setAttr(name, value) {
  document.documentElement.setAttribute(name, value);
}

function systemTheme() {
  return matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyAppearance() {
  const theme = localStorage.getItem(LS.theme) || 'dark';
  setAttr('data-theme', theme === 'system' ? systemTheme() : (theme === 'light' ? 'light' : 'dark'));
  setAttr('data-ui-style', localStorage.getItem(LS.style) || 'minimal');
  setAttr('data-ui-skin', localStorage.getItem(LS.skin) || 'min-obsidian');
  setAttr('data-ui-radius', localStorage.getItem(LS.radius) || 'soft');
  setAttr('data-ui-density', localStorage.getItem(LS.density) || 'comfortable');
  setAttr('data-ui-motion', localStorage.getItem(LS.motion) || 'balanced');
  setAttr('data-ui-glass', localStorage.getItem(LS.glass) || 'on');
  setAttr('data-ui-performance', localStorage.getItem(LS.performance) || 'auto');
  setAttr('data-ui-text-scale', localStorage.getItem(LS.textScale) || 'normal');
  setAttr('data-ui-shadows', localStorage.getItem(LS.shadows) || 'on');
  const accent = localStorage.getItem(LS.accent) || '';
  if (/^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty('--accent', accent);
}

function setSetting(key, value) {
  localStorage.setItem(key, value);
  applyAppearance();
}

function injectCss() {
  if (document.getElementById('profileSettingsEnhancerCss')) return;
  const s = document.createElement('style');
  s.id = 'profileSettingsEnhancerCss';
  s.textContent = `
    .pse-btn{width:30px;height:30px;border-radius:50%;border:1px solid var(--border-strong,rgba(255,255,255,.16));background:var(--surface-2,#202638);color:var(--text,#fff);display:inline-grid;place-items:center;cursor:pointer;font-weight:900}
    .pse-overlay{position:fixed;inset:0;z-index:99992;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;backdrop-filter:blur(6px)}
    .pse-card{width:min(760px,100%);max-height:88vh;display:flex;flex-direction:column;background:var(--surface,#141827);color:var(--text,#fff);border:1px solid var(--border-strong,rgba(255,255,255,.14));border-radius:24px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden}
    .pse-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
    .pse-title{font-size:1.02rem;font-weight:900}.pse-close{border:0;background:transparent;color:var(--muted,#aaa);font-size:26px;cursor:pointer}
    .pse-tabs{display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));overflow-x:auto}.pse-tab{padding:9px 12px;border-radius:999px;border:1px solid var(--border-strong,rgba(255,255,255,.14));background:transparent;color:inherit;cursor:pointer;font-weight:800;white-space:nowrap}.pse-tab.is-on{background:var(--accent,#63b3ff);color:var(--accent-text,#06121d);border-color:transparent}
    .pse-body{padding:16px 18px;overflow:auto}.pse-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.pse-section{padding:14px;border-radius:18px;background:var(--surface-2,#202638);border:1px solid var(--border,rgba(255,255,255,.1));display:grid;gap:10px}.pse-section h3{margin:0;font-size:.95rem}.pse-section p{margin:0;color:var(--muted,#9aa6b2);font-size:.83rem;line-height:1.45}.pse-row{display:grid;gap:6px}.pse-row label{font-size:.78rem;color:var(--muted,#9aa6b2);font-weight:800}.pse-row select,.pse-row input,.pse-row textarea{width:100%;box-sizing:border-box;padding:10px 11px;border-radius:12px;background:var(--surface,#141827);color:inherit;border:1px solid var(--border-strong,rgba(255,255,255,.14));outline:none}.pse-actions{display:flex;flex-wrap:wrap;gap:8px}.pse-action{padding:10px 12px;border-radius:12px;border:1px solid var(--border-strong,rgba(255,255,255,.14));background:var(--surface,#141827);color:inherit;font-weight:800;cursor:pointer}.pse-action.primary{background:var(--accent,#63b3ff);color:var(--accent-text,#06121d);border-color:transparent}.pse-action.danger{color:#fb7185;border-color:rgba(251,113,133,.35)}.pse-device{display:grid;gap:7px;padding:10px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08)}.pse-small{font-size:.77rem;color:var(--muted,#9aa6b2);word-break:break-word}
    [data-ui-motion="off"] *,[data-ui-performance="max"] *{animation:none!important;transition:none!important;scroll-behavior:auto!important}
    [data-ui-glass="off"] .tg-app,[data-ui-glass="off"] .modal,[data-ui-glass="off"] .pse-card{backdrop-filter:none!important}
    [data-ui-shadows="off"] *{box-shadow:none!important;text-shadow:none!important}
    [data-ui-performance="fast"]{--transition:.08s}[data-ui-performance="max"]{--transition:0s}
    [data-ui-text-scale="small"]{font-size:14px}[data-ui-text-scale="large"]{font-size:17px}[data-ui-text-scale="xlarge"]{font-size:18px}
    [data-ui-density="compact"] .msg-bubble{padding-top:7px!important;padding-bottom:7px!important}[data-ui-density="compact"] .chat-list-item{min-height:52px!important}
    [data-ui-radius="sharp"]{--radius-lg:10px;--radius-md:8px;--radius-sm:6px}[data-ui-radius="round"]{--radius-lg:28px;--radius-md:20px;--radius-sm:14px}
    body.pse-privacy-blur:not(:focus-within) #appRoot{filter:blur(4px)}
    @media(max-width:640px){.pse-card{max-height:92vh;border-radius:20px}.pse-grid{grid-template-columns:1fr}.pse-body{padding:12px}.pse-head{padding:14px}.pse-tabs{padding-inline:10px}}
  `;
  document.head.appendChild(s);
}

function hideMoreDesignsButtons() {
  const re = /ещ[её]\s+дизайн/i;
  document.querySelectorAll('button,a').forEach(el => {
    if (re.test((el.textContent || '').trim())) el.style.display = 'none';
  });
}

function ensureSidebarButton() {
  if (settingsBtnReady || document.getElementById('profileSecuritySettingsBtn')) return;
  const host = document.querySelector('.sidebar-footer');
  if (!host) return;
  const btn = document.createElement('button');
  btn.id = 'profileSecuritySettingsBtn';
  btn.className = 'pse-btn';
  btn.type = 'button';
  btn.title = 'Внешний вид и безопасность';
  btn.textContent = '⚙️';
  btn.addEventListener('click', openSettingsModal);
  host.insertBefore(btn, document.getElementById('btnLogout') || null);
  settingsBtnReady = true;
}

function selectHtml(key, options) {
  const cur = localStorage.getItem(key) || options[0][0];
  return `<select data-pse-setting="${esc(key)}">${options.map(([v,t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
}

function appearanceHtml() {
  const accent = localStorage.getItem(LS.accent) || '#63b3ff';
  return `<div class="pse-grid">
    <section class="pse-section"><h3>🎨 Основа</h3>
      <div class="pse-row"><label>Тема</label>${selectHtml(LS.theme, [['dark','Тёмная'],['light','Светлая'],['system','Как в системе']])}</div>
      <div class="pse-row"><label>Стиль</label>${selectHtml(LS.style, [['minimal','Минимализм'],['glass','Стекломорфизм'],['compact','Компактный'],['contrast','Контрастный']])}</div>
      <div class="pse-row"><label>Акцентный цвет</label><input data-pse-accent type="color" value="${esc(accent)}"></div>
    </section>
    <section class="pse-section"><h3>📐 Размеры</h3>
      <div class="pse-row"><label>Размер текста</label>${selectHtml(LS.textScale, [['normal','Обычный'],['small','Мелкий'],['large','Крупный'],['xlarge','Очень крупный']])}</div>
      <div class="pse-row"><label>Плотность</label>${selectHtml(LS.density, [['comfortable','Обычная'],['compact','Компактная'],['spacious','Свободная']])}</div>
      <div class="pse-row"><label>Радиус углов</label>${selectHtml(LS.radius, [['soft','Мягкие'],['sharp','Острые'],['round','Очень круглые']])}</div>
    </section>
    <section class="pse-section"><h3>⚡ Эффекты</h3>
      <div class="pse-row"><label>Анимации</label>${selectHtml(LS.motion, [['balanced','Сбалансированные'],['minimal','Минимальные'],['off','Отключены']])}</div>
      <div class="pse-row"><label>Blur / стекло</label>${selectHtml(LS.glass, [['on','Включено'],['off','Отключено']])}</div>
      <div class="pse-row"><label>Тени</label>${selectHtml(LS.shadows, [['on','Включены'],['off','Отключены']])}</div>
    </section>
    <section class="pse-section"><h3>🚀 Производительность</h3>
      <div class="pse-row"><label>Режим</label>${selectHtml(LS.performance, [['auto','Авто'],['pretty','Красиво'],['fast','Быстро'],['max','Максимально быстро']])}</div>
      <p>“Максимально быстро” отключает лишние анимации и тяжёлые эффекты. Это правильный режим для слабого ПК/Firefox.</p>
      <div class="pse-actions"><button class="pse-action" data-pse-reset-appearance>Сбросить внешний вид</button></div>
    </section>
  </div>`;
}

async function loadDeviceRows(uid) {
  if (!uid || !db) return '<p>Нет входа.</p>';
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'devices'));
    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    rows.sort((a,b) => Number(b.lastSeenAtMs || 0) - Number(a.lastSeenAtMs || 0));
    if (!rows.length) return '<p>Устройства пока не записаны. Открой ЛС, чтобы E2E зарегистрировал это устройство.</p>';
    return rows.map(x => `<div class="pse-device" data-device-id="${esc(x.deviceId || x.id)}">
      <strong>${esc(x.name || 'Устройство')}</strong>
      <span class="pse-small">${esc(x.deviceId || x.id)}</span>
      <span class="pse-small">${x.lastSeenAtMs ? 'Последняя активность: ' + new Date(Number(x.lastSeenAtMs)).toLocaleString('ru-RU') : 'Последняя активность неизвестна'}</span>
      ${x.fingerprint ? `<span class="pse-small">Fingerprint: ${esc(x.fingerprint)}</span>` : ''}
      <div class="pse-actions"><button class="pse-action" data-device-rename>Переименовать</button><button class="pse-action danger" data-device-delete>Удалить</button></div>
    </div>`).join('');
  } catch (e) {
    return `<p>Не удалось загрузить устройства: ${esc(e.message || e)}</p>`;
  }
}

async function securityHtml() {
  const u = currentUser || auth?.currentUser;
  if (!u) return '<p>Нужно войти.</p>';
  let status = null;
  try { status = await window.E2E?.getDeviceLocalStatus?.(u.uid); } catch (e) { status = { error: e.message || String(e) }; }
  const devices = await loadDeviceRows(u.uid);
  return `<div class="pse-grid">
    <section class="pse-section"><h3>🔐 Статус E2E</h3>
      <p>${status?.enabled ? 'ЛС защищены E2E. Режим: ключ устройства.' : 'E2E ещё не активирован на этом устройстве. Открой ЛС для инициализации.'}</p>
      <div class="pse-row"><label>Это устройство</label><input readonly value="${esc(status?.label || '—')}"></div>
      <div class="pse-row"><label>Device ID</label><input readonly value="${esc(status?.deviceId || '—')}"></div>
      <div class="pse-row"><label>Fingerprint</label><input readonly data-pse-fp value="${esc(status?.fingerprint || '—')}"></div>
      <p>Если очистить данные сайта / IndexedDB, старые зашифрованные ЛС могут не открыться без recovery key.</p>
    </section>
    <section class="pse-section"><h3>🧰 Recovery key</h3>
      <p>Recovery key открывает доступ к локальному E2E. Храни его как пароль. Не отправляй в чат.</p>
      <div class="pse-actions"><button class="pse-action primary" data-export-recovery>Экспорт recovery key</button><button class="pse-action" data-import-recovery>Импорт</button><button class="pse-action danger" data-reset-local-e2e>Сбросить E2E на устройстве</button></div>
    </section>
    <section class="pse-section"><h3>📱 Устройства</h3><div id="pseDevicesList">${devices}</div><div class="pse-actions"><button class="pse-action" data-refresh-devices>Обновить</button></div></section>
    <section class="pse-section"><h3>🕶 Приватность</h3>
      <div class="pse-row"><label>Размывать чат при потере фокуса</label>${selectHtml(LS.privacyBlur, [['off','Выкл'],['on','Вкл']])}</div>
      <div class="pse-row"><label>Скрывать текст уведомлений</label>${selectHtml(LS.hideNotifText, [['off','Выкл'],['on','Вкл']])}</div>
      <p>Запрет скриншотов в браузере невозможен. Blur — только мягкая защита от случайных взглядов.</p>
    </section>
  </div>`;
}

function openRecoveryModal(text) {
  const overlay = document.createElement('div');
  overlay.className = 'pse-overlay';
  overlay.innerHTML = `<div class="pse-card"><div class="pse-head"><b>🔑 Recovery key</b><button class="pse-close">×</button></div><div class="pse-body"><p class="pse-small">Скопируй и сохрани. Не показывай другим.</p><textarea rows="7" readonly>${esc(text)}</textarea><div class="pse-actions" style="margin-top:10px"><button class="pse-action primary" data-copy>Скопировать</button></div></div></div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('.pse-close')) overlay.remove(); });
  overlay.querySelector('[data-copy]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); toast('Recovery key скопирован'); } catch (_) {} });
  document.body.appendChild(overlay);
}

async function renderTab(body, tab) {
  body.innerHTML = tab === 'security' ? await securityHtml() : appearanceHtml();
  bindBodyActions(body, tab);
}

function bindBodyActions(body, tab) {
  body.querySelectorAll('[data-pse-setting]').forEach(el => el.addEventListener('change', () => {
    setSetting(el.getAttribute('data-pse-setting'), el.value);
    document.body.classList.toggle('pse-privacy-blur', localStorage.getItem(LS.privacyBlur) === 'on');
    toast('Настройка применена');
  }));
  body.querySelector('[data-pse-accent]')?.addEventListener('input', e => setSetting(LS.accent, e.target.value));
  body.querySelector('[data-pse-reset-appearance]')?.addEventListener('click', () => {
    [LS.theme, LS.style, LS.skin, LS.radius, LS.density, LS.motion, LS.glass, LS.performance, LS.textScale, LS.shadows, LS.accent].forEach(k => localStorage.removeItem(k));
    applyAppearance();
    toast('Внешний вид сброшен');
    renderTab(body, 'appearance');
  });

  if (tab !== 'security') return;
  const uid = currentUser?.uid || auth?.currentUser?.uid;
  body.querySelector('[data-export-recovery]')?.addEventListener('click', async () => {
    try { openRecoveryModal(await window.E2E.exportRecoveryKey(uid)); } catch (e) { toast('Ошибка экспорта: ' + (e.message || e)); }
  });
  body.querySelector('[data-import-recovery]')?.addEventListener('click', async () => {
    const val = prompt('Вставь recovery key:');
    if (!val) return;
    try { await window.E2E.importRecoveryKey(uid, val); toast('Recovery key импортирован. Перезагрузи страницу.'); } catch (e) { toast('Ошибка импорта: ' + (e.message || e)); }
  });
  body.querySelector('[data-reset-local-e2e]')?.addEventListener('click', async () => {
    if (!confirm('Сбросить локальные E2E-ключи на этом устройстве? Старые ЛС могут не открыться без recovery key.')) return;
    try { await window.E2E.resetLocalE2E(uid); toast('Локальный E2E сброшен. Перезагрузи страницу.'); } catch (e) { toast('Ошибка сброса: ' + (e.message || e)); }
  });
  body.querySelector('[data-refresh-devices]')?.addEventListener('click', () => renderTab(body, 'security'));
  body.querySelectorAll('[data-device-rename]').forEach(btn => btn.addEventListener('click', async () => {
    const card = btn.closest('[data-device-id]');
    const id = card?.dataset.deviceId;
    const name = prompt('Новое имя устройства:', card?.querySelector('strong')?.textContent || 'Устройство');
    if (!id || !name) return;
    try { await updateDoc(doc(db, 'users', uid, 'devices', id), { name: name.slice(0, 60), renamedAt: serverTimestamp() }); toast('Устройство переименовано'); renderTab(body, 'security'); } catch (e) { toast('Ошибка: ' + (e.message || e)); }
  }));
  body.querySelectorAll('[data-device-delete]').forEach(btn => btn.addEventListener('click', async () => {
    const card = btn.closest('[data-device-id]');
    const id = card?.dataset.deviceId;
    if (!id || !confirm('Удалить устройство из списка? Это не стирает ключи физически с того браузера.')) return;
    try { await deleteDoc(doc(db, 'users', uid, 'devices', id)); toast('Устройство удалено из списка'); renderTab(body, 'security'); } catch (e) { toast('Ошибка: ' + (e.message || e)); }
  }));
}

function openSettingsModal(start = 'appearance') {
  injectCss();
  document.getElementById('profileSettingsEnhancerModal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'profileSettingsEnhancerModal';
  overlay.className = 'pse-overlay';
  overlay.innerHTML = `<div class="pse-card"><div class="pse-head"><div class="pse-title">⚙️ Настройки профиля</div><button class="pse-close">×</button></div><div class="pse-tabs"><button class="pse-tab" data-tab="appearance">🎨 Внешний вид</button><button class="pse-tab" data-tab="security">🔐 Безопасность</button></div><div class="pse-body">Загрузка...</div></div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('.pse-close')) overlay.remove(); });
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.pse-body');
  const tabs = overlay.querySelectorAll('.pse-tab');
  const activate = async tab => {
    tabs.forEach(t => t.classList.toggle('is-on', t.dataset.tab === tab));
    await renderTab(body, tab);
  };
  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tab)));
  activate(start);
}

function installProfileHooks() {
  ['btnAvatarPicker', 'sidebarUserAv', 'sidebarUserName'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      setTimeout(hideMoreDesignsButtons, 120);
      setTimeout(hideMoreDesignsButtons, 500);
      setTimeout(hideMoreDesignsButtons, 1100);
    }, true);
  });
}

(async function init() {
  injectCss();
  applyAppearance();
  document.body.classList.toggle('pse-privacy-blur', localStorage.getItem(LS.privacyBlur) === 'on');
  try {
    const app = await waitApp();
    auth = getAuth(app);
    db = getFirestore(app);
    onAuthStateChanged(auth, u => {
      currentUser = u;
      if (!u) return;
      setTimeout(ensureSidebarButton, 500);
      setTimeout(ensureSidebarButton, 1600);
    });
  } catch (e) {
    console.warn('[profile-settings] firebase init skipped:', e?.message || e);
  }
  installProfileHooks();
  hideMoreDesignsButtons();
  setTimeout(hideMoreDesignsButtons, 1800);
  if (matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyAppearance);
  window.Chat6AProfileSettings = { open: openSettingsModal, applyAppearance };
  console.info('[chat6a] profile settings enhancer loaded');
})();
