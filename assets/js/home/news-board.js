import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
    getFirestore, collection, addDoc, deleteDoc, doc,
    onSnapshot, orderBy, query, serverTimestamp,
    runTransaction, increment, getDoc
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

/*
Firestore-структура:
  siteNews/{newsId}
    title, text, tag, tagType, imageDataUrl,
    pollQuestion, pollOptions, pollCounts,
    createdAt, authorUid, authorName
  siteNews/{newsId}/votes/{uid}
    optionIndex, updatedAt

Важно: проверка ADMIN в JS нужна для интерфейса, но настоящая защита должна
быть в Firestore Rules. Иначе пользователь с DevTools может попытаться
вызвать Firestore напрямую.
*/

const STATIC_NEWS_FALLBACK = [
    {
        id: 'static-vpr-2026-04-21',
        date: '21 апреля 2026', iso: '2026-04-21', tag: '⚠️ ВПР', tagType: 'math',
        title: 'Завтра ВПР по математике', text: 'Подготовьтесь!', staticOnly: true
    },
    {
        id: 'static-honor-2026-04-18',
        date: '18 апреля 2026', iso: '2026-04-18', tag: '🏅 Доска почёта', tagType: 'praise',
        title: 'Кто будет на доске почёта?', text: 'Типо выбран!', staticOnly: true
    },
    {
        id: 'static-flashmob-2026-04-15',
        date: '15 апреля 2026', iso: '2026-04-14', tag: '🐘 Новость', tagType: 'news',
        title: 'Завтра флешмоб!', text: 'Надеемся не опозоримся', staticOnly: true
    },
    {
        id: 'static-egor-2026-04-14',
        date: '14 апреля 2026', iso: '2026-04-14', tag: '🏆 Похвала', tagType: 'praise',
        title: 'Легендарный момент! Учительница по математике похвалила Егора Соловьёва!',
        text: 'На уроке математики произошло событие, которое войдёт в историю 6А: Учительница похвалила за быстрейшое решение уравнения! Класс гордится тобой, Егор! 🎉',
        staticOnly: true
    },
    {
        id: 'static-zhenya-2026-04-13',
        date: '13 апреля 2026', iso: '2026-04-13', tag: '🏆 Похвала', tagType: 'praise',
        title: 'Женя Кондратьев блестяще ответил у доски',
        text: 'На математике Женя проявил свои интеллектуальные способности и получил заслуженную похвалу. Так держать! 👏',
        staticOnly: true
    },
    {
        id: 'static-ready-2026-04-12',
        date: '12 апреля 2026', iso: '2026-04-12', tag: '📢 Объявление', tagType: 'announce',
        title: 'Сайт готов! По желанию будем добавлять новые функции',
        text: 'Мафия, чат, доска почёта, новости — всё готово! Если хочешь предложить идею — пиши в чат класса.',
        staticOnly: true
    }
];

const NEWS_VISIBLE_DEFAULT = 2;
const newsCol = collection(db, 'siteNews');
const newsQuery = query(newsCol, orderBy('createdAt', 'desc'));

let currentUser = null;
let isAdminMode = false;
let currentNews = [];
let expanded = false;
let selectedImageDataUrl = '';
let myVotes = {};

const stack          = document.getElementById('newsStack');
const countText      = document.getElementById('newsCountText');
const toggleBtn      = document.getElementById('newsToggleBtn');
const toggleText     = document.getElementById('newsToggleText');
const adminPanel     = document.getElementById('newsAdminPanel');
const titleInput     = document.getElementById('newsTitleInput');
const textInput      = document.getElementById('newsTextInput');
const tagInput       = document.getElementById('newsTagInput');
const tagTypeInput   = document.getElementById('newsTagTypeInput');
const imageInput     = document.getElementById('newsImageInput');
const imagePreview   = document.getElementById('newsImagePreview');
const clearImageBtn  = document.getElementById('newsClearImageBtn');
const pollToggle     = document.getElementById('newsPollToggle');
const pollBox        = document.getElementById('newsPollBox');
const pollQuestion   = document.getElementById('newsPollQuestionInput');
const pollOptions    = document.getElementById('newsPollOptionsInput');
const publishBtn     = document.getElementById('newsPublishBtn');
const resetBtn       = document.getElementById('newsResetBtn');
const adminStatus    = document.getElementById('newsAdminStatus');

function isAdmin(user) {
    return !!user && (user.displayName === 'ADMIN' || user.email === 'ADMIN@6a.ru');
}

function setStatus(text, type = '') {
    if (!adminStatus) return;
    adminStatus.textContent = text || '';
    adminStatus.className = 'news-admin-status' + (type ? ' ' + type : '');
}

function normalizeNewsDoc(id, data) {
    const created = data.createdAt?.toDate ? data.createdAt.toDate() : null;
    const fallbackDate = created || new Date();
    return {
        id,
        title: String(data.title || ''),
        text: String(data.text || ''),
        tag: String(data.tag || '📋 Новость'),
        tagType: String(data.tagType || 'default'),
        imageDataUrl: String(data.imageDataUrl || ''),
        pollQuestion: String(data.pollQuestion || ''),
        pollOptions: Array.isArray(data.pollOptions) ? data.pollOptions.map(String).slice(0, 8) : [],
        pollCounts: data.pollCounts && typeof data.pollCounts === 'object' ? data.pollCounts : {},
        date: data.date || formatDateLabel(fallbackDate),
        iso: data.iso || fallbackDate.toISOString().slice(0, 10),
        authorName: String(data.authorName || ''),
        staticOnly: false
    };
}

function formatDateLabel(date) {
    return date.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function getPollTotal(item) {
    if (!item.pollOptions?.length) return 0;
    return item.pollOptions.reduce((sum, _, i) => sum + Number(item.pollCounts?.['opt_' + i] || 0), 0);
}

function renderNews(items) {
    if (!stack) return;
    const total = items.length;
    countText.textContent = total + ' ' + plural(total, 'новость', 'новости', 'новостей');

    if (!total) {
        stack.innerHTML = '<div class="news-empty">Пока новостей нет. ADMIN может добавить первую новость выше.</div>';
        toggleBtn.style.display = 'none';
        return;
    }

    stack.innerHTML = '';
    items.forEach((item, i) => {
        const tagClass = 'tag--' + (item.tagType || 'default');
        const article = document.createElement('article');
        article.className = 'news-card reveal reveal-delay-' + Math.min(i, 4);
        if (!expanded && i >= NEWS_VISIBLE_DEFAULT) article.classList.add('news-hidden');

        const imageHtml = item.imageDataUrl
            ? '<img class="news-card__image" src="' + esc(item.imageDataUrl) + '" alt="Картинка к новости">'
            : '';

        const pollHtml = renderPoll(item);
        const adminActionsHtml = isAdminMode && !item.staticOnly
            ? '<div class="news-card__admin-actions"><button type="button" class="news-card__delete" data-delete-news="' + esc(item.id) + '">🗑 Удалить</button></div>'
            : '';

        article.innerHTML =
            '<div class="news-card__meta">' +
                '<time class="news-card__date" datetime="' + esc(item.iso) + '">' + esc(item.date) + '</time>' +
                '<span class="news-card__tag ' + tagClass + '">' + esc(item.tag) + '</span>' +
            '</div>' +
            '<h3 class="news-card__title">' + esc(item.title) + '</h3>' +
            '<p class="news-card__text">' + esc(item.text) + '</p>' +
            imageHtml +
            pollHtml +
            adminActionsHtml;
        stack.appendChild(article);
    });

    stack.querySelectorAll('[data-vote-news]').forEach(btn => {
        btn.addEventListener('click', () => votePoll(btn.dataset.voteNews, Number(btn.dataset.optionIndex)));
    });
    stack.querySelectorAll('[data-delete-news]').forEach(btn => {
        btn.addEventListener('click', () => deleteNews(btn.dataset.deleteNews));
    });

    renderToggle(total);
    if (window.initReveal) window.initReveal();
}

function renderPoll(item) {
    if (!item.pollQuestion || !item.pollOptions?.length) return '';
    const total = getPollTotal(item);
    const selected = myVotes[item.id];
    const optionsHtml = item.pollOptions.map((option, i) => {
        const count = Number(item.pollCounts?.['opt_' + i] || 0);
        const width = total > 0 ? Math.round((count / total) * 100) : 0;
        const selectedClass = selected === i ? ' is-selected' : '';
        const disabled = item.staticOnly ? ' disabled' : '';
        const title = item.staticOnly ? 'Опросы работают только у новостей из Firebase' : 'Нажми, чтобы проголосовать';
        return '<button type="button" class="news-poll__option' + selectedClass + '" data-vote-news="' + esc(item.id) + '" data-option-index="' + i + '" style="--poll-width:' + width + '%" title="' + esc(title) + '"' + disabled + '>' +
            '<span class="news-poll__bar" aria-hidden="true"></span>' +
            '<span class="news-poll__label">' + esc(option) + '</span>' +
            '<span class="news-poll__count">' + count + ' · ' + width + '%</span>' +
        '</button>';
    }).join('');
    const hint = currentUser
        ? 'Можно выбрать один вариант. При смене варианта счётчики пересчитаются автоматически.'
        : 'Чтобы голосовать, войди в чат.';
    return '<div class="news-poll">' +
        '<div class="news-poll__question">🗳 ' + esc(item.pollQuestion) + '</div>' +
        '<div class="news-poll__options">' + optionsHtml + '</div>' +
        '<div class="news-poll__hint">' + esc(hint) + '</div>' +
    '</div>';
}

function renderToggle(total) {
    if (!toggleBtn || !toggleText) return;
    if (total <= NEWS_VISIBLE_DEFAULT) {
        toggleBtn.style.display = 'none';
        return;
    }
    toggleBtn.style.display = 'flex';
    const remaining = total - NEWS_VISIBLE_DEFAULT;
    toggleText.textContent = expanded
        ? 'Свернуть'
        : 'Показать ещё ' + remaining + ' ' + plural(remaining, 'новость', 'новости', 'новостей');
    toggleBtn.classList.toggle('expanded', expanded);
}

if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
        expanded = !expanded;
        renderNews(currentNews);
    });
}

function clearNewsForm() {
    titleInput.value = '';
    textInput.value = '';
    tagInput.value = '';
    tagTypeInput.value = 'news';
    imageInput.value = '';
    selectedImageDataUrl = '';
    imagePreview.src = '';
    imagePreview.classList.remove('is-visible');
    pollToggle.checked = false;
    pollBox.classList.remove('is-visible');
    pollQuestion.value = '';
    pollOptions.value = '';
    setStatus('');
}

async function compressImage(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Можно прикреплять только картинки');
    if (file.size > 8 * 1024 * 1024) throw new Error('Картинка слишком большая. Максимум 8 МБ до сжатия.');

    const bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Не удалось прочитать картинку'));
        img.src = URL.createObjectURL(file);
    });

    const maxSide = 1280;
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(bitmap.src);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    if (dataUrl.length > 900000) {
        throw new Error('Картинка после сжатия всё ещё слишком большая. Возьми изображение поменьше.');
    }
    return dataUrl;
}

imageInput?.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    setStatus('Сжимаю картинку…');
    try {
        selectedImageDataUrl = await compressImage(file);
        imagePreview.src = selectedImageDataUrl;
        imagePreview.classList.add('is-visible');
        setStatus('Картинка прикреплена', 'ok');
    } catch (e) {
        selectedImageDataUrl = '';
        imageInput.value = '';
        imagePreview.classList.remove('is-visible');
        setStatus(e.message || 'Ошибка картинки', 'err');
    }
});
clearImageBtn?.addEventListener('click', () => {
    selectedImageDataUrl = '';
    imageInput.value = '';
    imagePreview.src = '';
    imagePreview.classList.remove('is-visible');
    setStatus('Картинка убрана');
});
pollToggle?.addEventListener('change', () => {
    pollBox.classList.toggle('is-visible', pollToggle.checked);
});
resetBtn?.addEventListener('click', clearNewsForm);

publishBtn?.addEventListener('click', publishNews);
async function publishNews() {
    if (!isAdminMode || !currentUser) {
        setStatus('Только ADMIN, вошедший через чат, может добавлять новости', 'err');
        return;
    }
    const title = titleInput.value.trim();
    const body = textInput.value.trim();
    const tag = tagInput.value.trim() || '📋 Новость';
    const tagType = tagTypeInput.value || 'default';
    if (!title || !body) {
        setStatus('Заполни заголовок и текст', 'err');
        return;
    }

    let options = [];
    let question = '';
    let counts = {};
    if (pollToggle.checked) {
        question = pollQuestion.value.trim();
        options = pollOptions.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8);
        if (!question || options.length < 2) {
            setStatus('Для опроса нужен вопрос и минимум 2 варианта', 'err');
            return;
        }
        options.forEach((_, i) => { counts['opt_' + i] = 0; });
    }

    publishBtn.disabled = true;
    setStatus('Публикую…');
    const now = new Date();
    try {
        await addDoc(newsCol, {
            title,
            text: body,
            tag,
            tagType,
            imageDataUrl: selectedImageDataUrl || '',
            pollQuestion: question,
            pollOptions: options,
            pollCounts: counts,
            authorUid: currentUser.uid,
            authorName: currentUser.displayName || currentUser.email || 'ADMIN',
            date: formatDateLabel(now),
            iso: now.toISOString().slice(0, 10),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        clearNewsForm();
        setStatus('Новость опубликована и обновится у всех', 'ok');
        setTimeout(() => setStatus(''), 2600);
    } catch (e) {
        console.error(e);
        setStatus('Ошибка публикации: ' + (e.message || e), 'err');
    }
    publishBtn.disabled = false;
}

async function deleteNews(newsId) {
    if (!isAdminMode || !currentUser) return;
    if (!confirm('Удалить эту новость?')) return;
    try {
        await deleteDoc(doc(db, 'siteNews', newsId));
    } catch (e) {
        alert('Ошибка удаления: ' + (e.message || e));
    }
}

async function votePoll(newsId, optionIndex) {
    if (!currentUser) {
        alert('Войди в чат, чтобы голосовать в опросах');
        return;
    }
    const item = currentNews.find(n => n.id === newsId);
    if (!item || item.staticOnly || !Number.isInteger(optionIndex)) return;
    if (optionIndex < 0 || optionIndex >= item.pollOptions.length) return;

    const newsRef = doc(db, 'siteNews', newsId);
    const voteRef = doc(db, 'siteNews', newsId, 'votes', currentUser.uid);

    try {
        await runTransaction(db, async tx => {
            const voteSnap = await tx.get(voteRef);
            const old = voteSnap.exists() ? Number(voteSnap.data().optionIndex) : null;
            if (old === optionIndex) return;
            const updates = {};
            if (Number.isInteger(old) && old >= 0) updates['pollCounts.opt_' + old] = increment(-1);
            updates['pollCounts.opt_' + optionIndex] = increment(1);
            tx.update(newsRef, updates);
            tx.set(voteRef, {
                uid: currentUser.uid,
                displayName: currentUser.displayName || '',
                optionIndex,
                updatedAt: serverTimestamp()
            }, { merge: true });
        });
        myVotes[newsId] = optionIndex;
        renderNews(currentNews);
    } catch (e) {
        console.error(e);
        alert('Не удалось проголосовать: ' + (e.message || e));
    }
}

async function refreshMyVotes() {
    myVotes = {};
    if (!currentUser || !currentNews.length) {
        renderNews(currentNews);
        return;
    }
    await Promise.all(currentNews.filter(n => !n.staticOnly).map(async item => {
        try {
            const snap = await getDoc(doc(db, 'siteNews', item.id, 'votes', currentUser.uid));
            if (snap.exists()) myVotes[item.id] = Number(snap.data().optionIndex);
        } catch (_) {}
    }));
    renderNews(currentNews);
}

onAuthStateChanged(auth, async user => {
    currentUser = user;
    isAdminMode = isAdmin(user);
    adminPanel?.classList.toggle('is-visible', isAdminMode);
    await refreshMyVotes();
});

if (stack) stack.innerHTML = '<div class="news-loading">Загрузка новостей…</div>';

onSnapshot(newsQuery, async snap => {
    const liveNews = snap.docs.map(d => normalizeNewsDoc(d.id, d.data()));
    currentNews = liveNews.length ? liveNews : STATIC_NEWS_FALLBACK;
    await refreshMyVotes();
}, err => {
    console.error('News realtime error:', err);
    currentNews = STATIC_NEWS_FALLBACK;
    renderNews(currentNews);
});
