(function () {
            var root = document.documentElement;
            var t = localStorage.getItem('index6a_theme');
            root.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
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
        })();

// Voice recorder fix: Chrome creates blobs as audio/webm;codecs=opus.
// The upload validator expects a clean MIME like audio/webm, so normalize File().
(function () {
  if (window.__chat6aVoiceMimeFix) return;
  window.__chat6aVoiceMimeFix = true;
  var NativeFile = window.File;
  if (typeof NativeFile !== 'function') return;
  window.File = function Chat6AFile(parts, fileName, options) {
    var opts = options ? Object.assign({}, options) : {};
    var type = String(opts.type || '').toLowerCase();
    if (type.indexOf('audio/webm') === 0) opts.type = 'audio/webm';
    else if (type.indexOf('audio/ogg') === 0) opts.type = 'audio/ogg';
    else if (type.indexOf('audio/mp4') === 0) opts.type = 'audio/mp4';
    return new NativeFile(parts, fileName, opts);
  };
  window.File.prototype = NativeFile.prototype;
  Object.setPrototypeOf(window.File, NativeFile);
  console.log('[chat6a] voice MIME fix enabled');
})();

// Extra chat moderation/report UI is loaded dynamically so index5.html stays unchanged.
setTimeout(function () {
  import('./reports-admin.js').catch(function (err) {
    console.warn('[reports-admin] load failed:', err && (err.message || err));
  });
}, 0);
