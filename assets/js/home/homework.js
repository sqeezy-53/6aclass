import { initializeApp, getApps }   from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
    getFirestore, collection, addDoc, deleteDoc, doc,
    onSnapshot, orderBy, query, serverTimestamp, getDocs
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
    apiKey: 'AIzaSyCtVaVgIvQot9SJpwKyUKrClNwar6xX9fo',
    authDomain: 'class6a-chat.firebaseapp.com',
    projectId: 'class6a-chat',
    storageBucket: 'class6a-chat.firebasestorage.app',
    messagingSenderId: '656933440681',
    appId: '1:656933440681:web:e7a8c2ae22181ec98f2db8'
};
const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ADMIN — любой кто вошёл с ником "ADMIN" (displayName === 'ADMIN')
function isAdmin() {
    const u = auth.currentUser;
    return u && (u.displayName === 'ADMIN' || u.email === 'ADMIN@6a.ru');
}

const dzList      = document.getElementById('dzList');
const dzForm      = document.getElementById('dzAdminForm');
const dzSubject   = document.getElementById('dzSubject');
const dzTask      = document.getElementById('dzTask');
const dzDueDate   = document.getElementById('dzDueDate');
const dzAddBtn    = document.getElementById('dzAddBtn');
const dzClearBtn  = document.getElementById('dzClearBtn');

function fmtDate(ts) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

function fmtDue(str) {
    if (!str) return '';
    const d = new Date(str);
    if (isNaN(d)) return str;
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    return d.toLocaleDateString('ru', opts);
}

let isAdminMode = false;

// Realtime listener — запускается внутри onAuthStateChanged
const dzQuery = query(collection(db, 'homework'), orderBy('createdAt', 'desc'));
let dzUnsubscribe = null;

function startDzListener() {
    if (dzUnsubscribe) dzUnsubscribe();
    dzUnsubscribe = onSnapshot(dzQuery, snap => {
        if (snap.empty) {
            dzList.innerHTML = '<div class="dz-empty">Пока нет заданий 🎉</div>';
            return;
        }
        dzList.innerHTML = '';
        snap.docs.forEach(d => {
            const data = d.data();
            const item = document.createElement('div');
            item.className = 'dz-item';
            const subj = String(data.subject || '').replace(/[<>&"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
            const task = String(data.task    || '').replace(/[<>&"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
            const due  = data.dueDate ? '<span class="dz-due">📅 до ' + fmtDue(data.dueDate) + '</span>' : '';
            const addedDate = fmtDate(data.createdAt);
            item.innerHTML =
                '<div class="dz-item-subject">' + subj + due + '</div>' +
                '<div class="dz-item-task">' + task + '</div>' +
                '<div class="dz-item-meta">Добавлено ' + addedDate +
                    (isAdminMode ? '<button class="dz-item-delete" data-id="' + d.id + '">✕ удалить</button>' : '') +
                '</div>';
            dzList.appendChild(item);
        });
        if (isAdminMode) {
            dzList.querySelectorAll('.dz-item-delete').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (confirm('Удалить задание?')) await deleteDoc(doc(db, 'homework', btn.dataset.id));
                });
            });
        }
    }, err => {
        console.error('DZ error:', err);
        dzList.innerHTML = '<div class="dz-empty">Ошибка загрузки 😕<br><small>' + err.message + '</small></div>';
    });
}

// Auth — сначала определяем права, потом запускаем слушатель
onAuthStateChanged(auth, user => {
    isAdminMode = !!(user && (user.displayName === 'ADMIN' || user.email === 'ADMIN@6a.ru'));
    if (isAdminMode) {
        dzForm.classList.add('is-visible');
        if (dzClearBtn) dzClearBtn.style.display = 'inline-flex';
    } else {
        dzForm.classList.remove('is-visible');
        if (dzClearBtn) dzClearBtn.style.display = 'none';
    }
    startDzListener();
});

// Добавление ДЗ
async function addHomework() {
    const subject = dzSubject.value.trim();
    const task    = dzTask.value.trim();
    const dueDate = dzDueDate ? dzDueDate.value : '';
    if (!subject || !task) { alert('Заполни предмет и задание'); return; }
    dzAddBtn.disabled = true;
    try {
        await addDoc(collection(db, 'homework'), {
            subject, task,
            dueDate: dueDate || null,
            createdAt: serverTimestamp()
        });
        dzSubject.value = '';
        dzTask.value = '';
        if (dzDueDate) dzDueDate.value = '';
        dzAddBtn.textContent = '✓ Добавлено';
        setTimeout(() => { dzAddBtn.textContent = '+ Добавить'; }, 1500);
    } catch(e) { alert('Ошибка: ' + e.message); }
    dzAddBtn.disabled = false;
}

// Удалить всё (ADMIN)
if (dzClearBtn) {
    dzClearBtn.addEventListener('click', async () => {
        if (!confirm('Удалить ВСЕ домашние задания?')) return;
        const snap = await getDocs(collection(db, 'homework'));
        await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
        alert('Всё удалено');
    });
}

dzAddBtn.addEventListener('click', addHomework);
[dzSubject, dzTask].forEach(el => {
    el && el.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addHomework(); }
    });
});
