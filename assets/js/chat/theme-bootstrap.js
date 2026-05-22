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

// Voice recorder fix.
// Chrome likes audio/webm;codecs=opus. The backend/browser validators are happier with plain audio/webm.
(function () {
  if (window.__chat6aVoiceMimeFix) return;
  window.__chat6aVoiceMimeFix = true;

  function cleanAudioType(type) {
    type = String(type || '').toLowerCase();
    if (type.indexOf('audio/webm') === 0) return 'audio/webm';
    if (type.indexOf('audio/ogg') === 0) return 'audio/ogg';
    if (type.indexOf('audio/mp4') === 0) return 'audio/mp4';
    return type;
  }

  var tries = 0;
  var patchMediaRecorder = function () {
    tries++;
    if (window.MediaRecorder && typeof window.MediaRecorder.isTypeSupported === 'function') {
      var nativeIsTypeSupported = window.MediaRecorder.isTypeSupported.bind(window.MediaRecorder);
      window.MediaRecorder.isTypeSupported = function (type) {
        if (String(type || '').toLowerCase() === 'audio/webm;codecs=opus') return false;
        return nativeIsTypeSupported(type);
      };
      return true;
    }
    if (tries < 40) setTimeout(patchMediaRecorder, 100);
    return false;
  };
  patchMediaRecorder();

  var NativeBlob = window.Blob;
  if (typeof NativeBlob === 'function') {
    window.Blob = function Chat6ABlob(parts, options) {
      var opts = options ? Object.assign({}, options) : {};
      opts.type = cleanAudioType(opts.type);
      return new NativeBlob(parts, opts);
    };
    window.Blob.prototype = NativeBlob.prototype;
    Object.setPrototypeOf(window.Blob, NativeBlob);
  }

  var NativeFile = window.File;
  if (typeof NativeFile === 'function') {
    window.File = function Chat6AFile(parts, fileName, options) {
      var opts = options ? Object.assign({}, options) : {};
      opts.type = cleanAudioType(opts.type);
      return new NativeFile(parts, fileName, opts);
    };
    window.File.prototype = NativeFile.prototype;
    Object.setPrototypeOf(window.File, NativeFile);
  }

  console.log('[chat6a] voice MIME fix enabled');
})();

// Upload token refresh patch for /api/upload.
setTimeout(function () {
  import('./upload-auth-refresh.js').catch(function (err) {
    console.warn('[upload-auth-refresh] load failed:', err && (err.message || err));
  });
}, 0);

// Extra chat moderation/report UI is loaded dynamically so index5.html stays unchanged.
setTimeout(function () {
  import('./reports-admin.js').catch(function (err) {
    console.warn('[reports-admin] load failed:', err && (err.message || err));
  });
}, 0);
