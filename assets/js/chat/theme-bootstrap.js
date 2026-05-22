(function () {
            var root = document.documentElement;
            var t = localStorage.getItem('index6a_theme');
            var realTheme = t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : (t === 'light' ? 'light' : 'dark');
            root.setAttribute('data-theme', realTheme);
            root.setAttribute('data-ui-style', localStorage.getItem('index6a_ui_style_v2') || 'minimal');
            root.setAttribute('data-ui-skin', localStorage.getItem('index6a_ui_skin_v2') || 'min-obsidian');
            root.setAttribute('data-ui-radius', localStorage.getItem('index6a_ui_radius_v1') || 'soft');
            root.setAttribute('data-ui-density', localStorage.getItem('index6a_ui_density_v1') || 'comfortable');
            root.setAttribute('data-ui-motion', localStorage.getItem('index6a_ui_motion_v1') || 'balanced');
            root.setAttribute('data-ui-glass', localStorage.getItem('index6a_ui_glass_v1') || 'on');
            root.setAttribute('data-ui-contrast', localStorage.getItem('index6a_ui_contrast_v1') || 'normal');
            root.setAttribute('data-ui-texture', localStorage.getItem('index6a_ui_texture_v1') || 'subtle');
            root.setAttribute('data-ui-bubble', localStorage.getItem('index6a_ui_bubble_v1') || 'tail');
            root.setAttribute('data-ui-performance', localStorage.getItem('index6a_ui_performance_v1') || 'auto');
            root.setAttribute('data-ui-text-scale', localStorage.getItem('index6a_ui_text_scale_v1') || 'normal');
            root.setAttribute('data-ui-shadows', localStorage.getItem('index6a_ui_shadows_v1') || 'on');
            var accent = localStorage.getItem('index6a_ui_accent_v1') || '';
            if (/^#[0-9a-f]{6}$/i.test(accent)) root.style.setProperty('--accent', accent);
        })();

(function () {
  var href = '/assets/css/chat-ui-hotfix.css?v=20260522-css-only-3';
  if (document.querySelector('link[data-chat6a-hotfix="' + href + '"]')) return;
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute('data-chat6a-hotfix', href);
  document.head.appendChild(link);
})();

(function () {
  document.addEventListener('securitypolicyviolation', function (e) {
    var blocked = String(e.blockedURI || '');
    if (blocked.indexOf('https://www.google.com/images/cleardot.gif') === 0) {
      e.stopImmediatePropagation();
    }
  }, true);
})();

setTimeout(function () {
  import('/assets/js/chat/reports-admin.js?v=20260522-safe-1').catch(function (err) {
    console.warn('[reports-admin] load failed:', err && (err.message || err));
  });
}, 1200);

setTimeout(function () {
  import('/assets/js/chat/profile-settings-enhancer.js?v=20260522-p3').catch(function (err) {
    console.warn('[profile-settings-enhancer] load failed:', err && (err.message || err));
  });
}, 900);

// Runtime monkey-patches for Blob/File/XMLHttpRequest/FormData are intentionally disabled.
// Upload fixes must be made directly in app.js/server.py, not by overriding browser APIs.
