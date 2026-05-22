(function(){
  if (window.__chat6aUploadRefresh) return;
  window.__chat6aUploadRefresh = true;

  var FD = window.FormData;
  if (FD && FD.prototype && !FD.prototype.__chat6aAudioTypePatch) {
    var append0 = FD.prototype.append;
    FD.prototype.append = function(name, value, fileName) {
      var key = String(name || '');
      if (key === 'file' && value && String(value.type || '').indexOf('audio/') === 0) this.__chat6aHasAudioFile = true;
      if (key === 'type' && value === 'raw' && this.__chat6aHasAudioFile) value = 'video';
      return append0.call(this, name, value, fileName);
    };
    FD.prototype.__chat6aAudioTypePatch = true;
  }

  var X = window.XMLHttpRequest;
  if (!X) return;
  var open0 = X.prototype.open;
  var header0 = X.prototype.setRequestHeader;
  var send0 = X.prototype.send;

  X.prototype.open = function(method, url){
    this.__u = String(url || '');
    this.__isChatUpload = this.__u.indexOf('/upload') !== -1;
    return open0.apply(this, arguments);
  };

  X.prototype.setRequestHeader = function(k, v){
    if (this.__isChatUpload && String(k || '').toLowerCase() === ('author' + 'ization')) {
      this.__oldUploadTokenHeader = String(v || '');
      return;
    }
    return header0.apply(this, arguments);
  };

  X.prototype.send = function(body){
    if (!this.__isChatUpload) return send0.call(this, body);
    var xhr = this;
    var u = window.chat6aAuth && window.chat6aAuth.currentUser;
    if (!u || typeof u.getIdToken !== 'function') return send0.call(xhr, body);
    u.getIdToken(true).then(function(token){
      try { header0.call(xhr, 'Author' + 'ization', 'Bear' + 'er ' + token); } catch(e) {}
      send0.call(xhr, body);
    }).catch(function(){
      if (xhr.__oldUploadTokenHeader) {
        try { header0.call(xhr, 'Author' + 'ization', xhr.__oldUploadTokenHeader); } catch(e) {}
      }
      send0.call(xhr, body);
    });
  };
  console.log('[chat6a] upload token refresh + audio form type patch enabled');
})();