import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

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

const overlay      = document.getElementById('scheduleOverlay');
const btnOpen      = document.getElementById('btnOpenSchedule');
const btnClose     = document.getElementById('btnCloseSchedule');
const scheduleImg  = document.getElementById('scheduleImg');
const scheduleNoImg= document.getElementById('scheduleNoImg');
const uploadBar    = document.getElementById('scheduleUploadBar');
const fileInput    = document.getElementById('scheduleFileInput');
const uploadStatus = document.getElementById('scheduleUploadStatus');
const delBtn       = document.getElementById('scheduleDelBtn');

const scheduleDocRef = doc(db, 'siteSettings', 'schedule');

// ── Открыть / закрыть модалку ──
function openModal()  { overlay.classList.add('is-open'); document.body.style.overflow = 'hidden'; }
function closeModal() { overlay.classList.remove('is-open'); document.body.style.overflow = ''; }
btnOpen.addEventListener('click', openModal);
btnClose.addEventListener('click', closeModal);
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Показать / скрыть картинку ──
function showImage(dataUrl) {
    scheduleImg.src = dataUrl;
    scheduleImg.style.display = 'block';
    scheduleNoImg.style.display = 'none';
}
function showNoImage() {
    scheduleImg.src = '';
    scheduleImg.style.display = 'none';
    scheduleNoImg.style.display = 'block';
}

// ── Real-time слушатель — обновляет картинку для всех ──
onSnapshot(scheduleDocRef, snap => {
    if (snap.exists() && snap.data().imageBase64) {
        showImage(snap.data().imageBase64);
    } else {
        showNoImage();
    }
}, () => showNoImage());

// ── ADMIN: проверка прав ──
function isAdmin(user) {
    return user && (user.displayName === 'ADMIN' || user.email === 'ADMIN@6a.ru');
}

onAuthStateChanged(auth, user => {
    if (isAdmin(user)) {
        uploadBar.classList.add('is-visible');
    } else {
        uploadBar.classList.remove('is-visible');
    }
});

// ── ADMIN: загрузка картинки ──
fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
        uploadStatus.textContent = '❌ Файл слишком большой (макс. 4 МБ)';
        uploadStatus.style.color = '#f87171';
        return;
    }
    uploadStatus.textContent = '⏳ Загружаю…';
    uploadStatus.style.color = 'var(--muted)';
    try {
        const dataUrl = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result);
            reader.onerror = rej;
            reader.readAsDataURL(file);
        });
        await setDoc(scheduleDocRef, { imageBase64: dataUrl, updatedAt: new Date().toISOString() });
        uploadStatus.textContent = '✅ Расписание обновлено!';
        uploadStatus.style.color = 'var(--accent-3)';
        setTimeout(() => { uploadStatus.textContent = ''; }, 2500);
    } catch(e) {
        uploadStatus.textContent = '❌ Ошибка: ' + e.message;
        uploadStatus.style.color = '#f87171';
    }
    fileInput.value = '';
});

// ── ADMIN: удалить расписание ──
delBtn.addEventListener('click', async () => {
    if (!confirm('Удалить картинку расписания?')) return;
    try {
        await deleteDoc(scheduleDocRef);
        uploadStatus.textContent = '🗑 Удалено';
        setTimeout(() => { uploadStatus.textContent = ''; }, 1500);
    } catch(e) {
        uploadStatus.textContent = '❌ ' + e.message;
    }
});
