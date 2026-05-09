import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfigHonor = {
    apiKey: 'AIzaSyCtVaVgIvQot9SJpwKyUKrClNwar6xX9fo',
    authDomain: 'class6a-chat.firebaseapp.com',
    projectId: 'class6a-chat',
    storageBucket: 'class6a-chat.firebasestorage.app',
    messagingSenderId: '656933440681',
    appId: '1:656933440681:web:e7a8c2ae22181ec98f2db8'
};

const honorApp  = getApps().length ? getApps()[0] : initializeApp(firebaseConfigHonor);
const honorDb   = getFirestore(honorApp);
const honorAuth = getAuth(honorApp);

const honorDocRef = doc(honorDb, 'siteSettings', 'honorBoard');
const HONOR_DEFAULT = {
    name: 'Женя',
    role: 'Легенда класса',
    desc: 'Добрейший парень, который заслужил похвалы',
    photoUrl: 'Matvei1.jpg'
};
const HONOR_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const HONOR_ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

let honorCurrentUser = null;
let honorIsAdminMode = false;
let honorCurrentData = { ...HONOR_DEFAULT };
let honorPendingPhotoFile = null;
let honorPreviewObjectUrl = '';

const honorPhoto        = document.getElementById('honorPhoto');
const honorName         = document.getElementById('honorName');
const honorRole         = document.getElementById('honorRole');
const honorDesc         = document.getElementById('honorDesc');
const honorAdminPanel   = document.getElementById('honorAdminPanel');
const honorNameInput    = document.getElementById('honorNameInput');
const honorRoleInput    = document.getElementById('honorRoleInput');
const honorDescInput    = document.getElementById('honorDescInput');
const honorPhotoInput   = document.getElementById('honorPhotoInput');
const honorPreviewWrap  = document.getElementById('honorPreviewWrap');
const honorPreview      = document.getElementById('honorPreview');
const honorPreviewText  = document.getElementById('honorPreviewText');
const honorClearPhotoBtn = document.getElementById('honorClearPhotoBtn');
const honorRemovePhotoBtn = document.getElementById('honorRemovePhotoBtn');
const honorSaveBtn      = document.getElementById('honorSaveBtn');
const honorResetBtn     = document.getElementById('honorResetBtn');
const honorAdminStatus  = document.getElementById('honorAdminStatus');

function honorEsc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function honorFallbackAvatar(name) {
    return 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name || '6А') + '&background=5ec8ff&color=061018&bold=true&size=256';
}
function honorSetStatus(text, type = '') {
    if (!honorAdminStatus) return;
    honorAdminStatus.textContent = text || '';
    honorAdminStatus.className = 'honor-admin-status' + (type ? ' ' + type : '');
}
function honorNormalize(data) {
    return {
        name: String(data?.name || HONOR_DEFAULT.name).slice(0, 80),
        role: String(data?.role || HONOR_DEFAULT.role).slice(0, 80),
        desc: String(data?.desc || HONOR_DEFAULT.desc).slice(0, 500),
        photoUrl: String(data?.photoUrl || HONOR_DEFAULT.photoUrl).slice(0, 1200)
    };
}
function honorRender(data) {
    const item = honorNormalize(data);
    honorCurrentData = item;
    if (honorName) honorName.textContent = item.name;
    if (honorRole) honorRole.textContent = item.role;
    if (honorDesc) honorDesc.textContent = item.desc;
    if (honorPhoto) {
        honorPhoto.alt = 'Фото ' + item.name;
        honorPhoto.onerror = function () {
            this.onerror = null;
            this.src = honorFallbackAvatar(item.name);
        };
        honorPhoto.src = item.photoUrl || honorFallbackAvatar(item.name);
    }
    if (honorIsAdminMode) honorFillInputs(item);
}
function honorFillInputs(data = honorCurrentData) {
    if (honorNameInput) honorNameInput.value = data.name || '';
    if (honorRoleInput) honorRoleInput.value = data.role || '';
    if (honorDescInput) honorDescInput.value = data.desc || '';
}
function honorClearPendingPhoto() {
    honorPendingPhotoFile = null;
    if (honorPhotoInput) honorPhotoInput.value = '';
    if (honorPreviewObjectUrl) {
        URL.revokeObjectURL(honorPreviewObjectUrl);
        honorPreviewObjectUrl = '';
    }
    if (honorPreviewWrap) honorPreviewWrap.classList.remove('is-visible');
    if (honorPreview) honorPreview.src = '';
    if (honorPreviewText) honorPreviewText.textContent = 'Фото будет загружено через Cloudinary без сжатия после сохранения.';
}
async function honorIsAdmin(user) {
    if (!user) return false;
    if (user.displayName === 'ADMIN' || user.email === 'ADMIN@6a.ru') return true;
    try {
        const snap = await getDoc(doc(honorDb, 'users', user.uid));
        return snap.exists() && snap.data()?.admin === true;
    } catch (_) {
        return false;
    }
}
async function uploadHonorPhotoViaBackend(file, onProgress) {
    if (!(file instanceof File || file instanceof Blob)) throw new Error('Выбери файл изображения.');
    if (file.size > HONOR_MAX_IMAGE_BYTES) throw new Error('Фото слишком большое: максимум 10 МБ.');
    const mime = file.type || 'application/octet-stream';
    if (!HONOR_ALLOWED_IMAGE_TYPES.has(mime)) throw new Error('Разрешены только JPG, PNG, WEBP или GIF.');
    const token = honorAuth.currentUser ? await honorAuth.currentUser.getIdToken().catch(() => '') : '';
    if (!token) throw new Error('Нужно войти в чат перед загрузкой фото.');

    const form = new FormData();
    form.append('file', file, file.name || 'honor-photo');
    form.append('type', 'image');

    const endpoint = String(window.BACKEND_URL || 'https://sixaclass.onrender.com/api').replace(/\/$/, '') + '/upload';
    return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint, true);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100));
        };
        xhr.onload = () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
            if (xhr.status >= 200 && xhr.status < 300 && data?.url) {
                resolve(String(data.url));
                return;
            }
            const detail = data?.detail || data?.error || data?.message;
            reject(new Error(detail || 'Cloudinary-загрузка не удалась.'));
        };
        xhr.onerror = () => reject(new Error('Сетевая ошибка при загрузке фото.'));
        xhr.send(form);
    });
}

onSnapshot(honorDocRef, snap => {
    if (snap.exists()) honorRender(snap.data());
    else honorRender(HONOR_DEFAULT);
}, err => {
    console.warn('[honor] realtime error:', err);
    honorRender(HONOR_DEFAULT);
});

onAuthStateChanged(honorAuth, async user => {
    honorCurrentUser = user || null;
    honorIsAdminMode = await honorIsAdmin(user);
    if (honorAdminPanel) honorAdminPanel.classList.toggle('is-visible', honorIsAdminMode);
    if (honorIsAdminMode) {
        honorFillInputs(honorCurrentData);
        honorSetStatus('Готово: можно менять имя, звание, описание и фото.', 'ok');
    }
});

if (honorPhotoInput) {
    honorPhotoInput.addEventListener('change', () => {
        const file = honorPhotoInput.files && honorPhotoInput.files[0];
        honorClearPendingPhoto();
        if (!file) return;
        if (!HONOR_ALLOWED_IMAGE_TYPES.has(file.type || '')) {
            honorSetStatus('Разрешены только JPG, PNG, WEBP или GIF.', 'err');
            return;
        }
        if (file.size > HONOR_MAX_IMAGE_BYTES) {
            honorSetStatus('Фото слишком большое: максимум 10 МБ.', 'err');
            return;
        }
        honorPendingPhotoFile = file;
        honorPreviewObjectUrl = URL.createObjectURL(file);
        if (honorPreview) honorPreview.src = honorPreviewObjectUrl;
        if (honorPreviewWrap) honorPreviewWrap.classList.add('is-visible');
        if (honorPreviewText) {
            honorPreviewText.textContent = `${file.name || 'Фото'} · ${(file.size / 1024 / 1024).toFixed(2)} МБ · загрузится без сжатия через Cloudinary`;
        }
        honorSetStatus('Фото выбрано. Нажми «Сохранить», чтобы загрузить.', 'warn');
    });
}
if (honorClearPhotoBtn) honorClearPhotoBtn.addEventListener('click', () => {
    honorClearPendingPhoto();
    honorSetStatus('Новое выбранное фото убрано. Текущее фото на доске не изменено.', 'warn');
});
if (honorResetBtn) honorResetBtn.addEventListener('click', () => {
    honorFillInputs(honorCurrentData);
    honorClearPendingPhoto();
    honorSetStatus('Поля сброшены к текущему состоянию доски.', 'ok');
});
if (honorRemovePhotoBtn) honorRemovePhotoBtn.addEventListener('click', async () => {
    if (!honorIsAdminMode || !honorCurrentUser) {
        honorSetStatus('Нужно войти как ADMIN.', 'err');
        return;
    }
    if (!confirm('Убрать фото с доски почёта? Вместо него будет аватар-заглушка.')) return;
    honorRemovePhotoBtn.disabled = true;
    try {
        await setDoc(honorDocRef, {
            ...honorCurrentData,
            photoUrl: '',
            updatedAt: serverTimestamp(),
            updatedByUid: honorCurrentUser.uid,
            updatedByName: honorCurrentUser.displayName || honorCurrentUser.email || 'ADMIN'
        }, { merge: true });
        honorClearPendingPhoto();
        honorSetStatus('Фото убрано.', 'ok');
    } catch (e) {
        honorSetStatus('Ошибка: ' + (e.message || e), 'err');
    }
    honorRemovePhotoBtn.disabled = false;
});
if (honorSaveBtn) honorSaveBtn.addEventListener('click', async () => {
    if (!honorIsAdminMode || !honorCurrentUser) {
        honorSetStatus('Нужно войти как ADMIN.', 'err');
        return;
    }
    const name = honorNameInput.value.trim();
    const role = honorRoleInput.value.trim();
    const desc = honorDescInput.value.trim();
    if (!name || !role || !desc) {
        honorSetStatus('Заполни имя, звание и описание.', 'err');
        return;
    }
    honorSaveBtn.disabled = true;
    honorSetStatus('Сохраняю…', 'warn');
    try {
        let photoUrl = honorCurrentData.photoUrl || '';
        if (honorPendingPhotoFile) {
            honorSetStatus('Загружаю фото в Cloudinary: 0%', 'warn');
            photoUrl = await uploadHonorPhotoViaBackend(honorPendingPhotoFile, pct => {
                honorSetStatus('Загружаю фото в Cloudinary: ' + pct + '%', 'warn');
            });
        }
        await setDoc(honorDocRef, {
            name,
            role,
            desc,
            photoUrl,
            updatedAt: serverTimestamp(),
            updatedByUid: honorCurrentUser.uid,
            updatedByName: honorCurrentUser.displayName || honorCurrentUser.email || 'ADMIN'
        }, { merge: true });
        honorClearPendingPhoto();
        honorSetStatus('Доска почёта обновлена. У всех обновится автоматически.', 'ok');
    } catch (e) {
        honorSetStatus('Ошибка: ' + (e.message || e), 'err');
    }
    honorSaveBtn.disabled = false;
});
