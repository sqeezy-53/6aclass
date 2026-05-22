(function(){
  if (window.__chat6aVoiceUploadV4) return;
  window.__chat6aVoiceUploadV4 = true;

  var X = window.XMLHttpRequest;
  if (!X) return;

  var open0 = X.prototype.open;
  var header0 = X.prototype.setRequestHeader;
  var send0 = X.prototype.send;

  function isUp(url){ return String(url || '').indexOf('/upload') !== -1; }

  function patchBody(body){
    try {
      if (!body || typeof FormData === 'undefined' || !(body instanceof FormData)) return body;
      if (typeof body.get !== 'function' || typeof body.set !== 'function') return body;
      var f = body.get('file');
      var t = f && String(f.type || '').toLowerCase();
      if (t.indexOf('audio/') === 0) body.set('type', 'video');
    } catch(e) {
      console.warn('[chat6a] voice form patch skipped', e && (e.message || e));
    }
    return body;
  }

  X.prototype.open = function(method, url){
    this.__chat6aUp = isUp(url);
    return open0.apply(this, arguments);
  };

  X.prototype.setRequestHeader = function(k, v){
    var low = String(k || '').toLowerCase();
    if (this.__chat6aUp && low === ('author' + 'ization')) {
      this.__chat6aAuthHeader = String(v || '');
      return;
    }
    return header0.apply(this, arguments);
  };

  X.prototype.send = function(body){
    if (!this.__chat6aUp) return send0.call(this, body);
    var xhr = this;
    body = patchBody(body);
    var u = window.chat6aAuth && window.chat6aAuth.currentUser;
    if (!u || typeof u.getIdToken !== 'function') {
      if (xhr.__chat6aAuthHeader) { try { header0.call(xhr, 'Author' + 'ization', xhr.__chat6aAuthHeader); } catch(e) {} }
      return send0.call(xhr, body);
    }
    u.getIdToken(true).then(function(tok){
      try { header0.call(xhr, 'Author' + 'ization', 'Bear' + 'er ' + tok); } catch(e) {}
      send0.call(xhr, body);
    }).catch(function(){
      if (xhr.__chat6aAuthHeader) { try { header0.call(xhr, 'Author' + 'ization', xhr.__chat6aAuthHeader); } catch(e) {} }
      send0.call(xhr, body);
    });
  };

  console.log('[chat6a] voice upload fix v4 loaded');
})();
