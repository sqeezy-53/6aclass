/* ═══════════════════════════════════════════════════════════════════════
   ТЕМА — переключение светлой/тёмной
═══════════════════════════════════════════════════════════════════════ */
(function () {
    var THEME_KEY = 'index6a_theme';
    function setTheme(mode) {
        var next = mode === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem(THEME_KEY, next);
    }
    document.getElementById('themeToggle').addEventListener('click', function () {
        var cur = document.documentElement.getAttribute('data-theme') || 'dark';
        setTheme(cur === 'dark' ? 'light' : 'dark');
    });
})();


/* ═══════════════════════════════════════════════════════════════════════
   ОБЩИЕ ХЕЛПЕРЫ ДЛЯ ДИНАМИЧЕСКИХ БЛОКОВ
═══════════════════════════════════════════════════════════════════════ */
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function plural(n, one, few, many) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

/* ═══════════════════════════════════════════════════════════════════════
   АНИМАЦИИ ПРИ СКРОЛЛЕ (Intersection Observer)
═══════════════════════════════════════════════════════════════════════ */
function initReveal() {
    var elements = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
        elements.forEach(function (el) { el.classList.add('is-visible'); });
        return;
    }
    var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    elements.forEach(function (el) { observer.observe(el); });
}

// Инициализируем для статичных элементов сразу
initReveal();
