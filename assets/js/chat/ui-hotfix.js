(function(){
  if (window.__chat6aUiHotfix) return;
  window.__chat6aUiHotfix = true;

  function clampEl(el){
    if(!el || getComputedStyle(el).display === 'none') return;
    var r = el.getBoundingClientRect();
    var pad = 10;
    var left = parseFloat(el.style.left || r.left || 0);
    var top = parseFloat(el.style.top || r.top || 0);
    if(r.right > window.innerWidth - pad) left -= r.right - (window.innerWidth - pad);
    if(r.left < pad) left += pad - r.left;
    if(r.bottom > window.innerHeight - pad) top -= r.bottom - (window.innerHeight - pad);
    if(r.top < pad) top += pad - r.top;
    el.style.left = Math.max(pad, left) + 'px';
    el.style.top = Math.max(pad, top) + 'px';
  }

  function setIcon(tab, cls){
    document.querySelectorAll('.attach-tab[data-tab="' + tab + '"] .tab-icon').forEach(function(el){
      var i = el.querySelector('i');
      if(!i){ i = document.createElement('i'); el.textContent=''; el.appendChild(i); }
      i.className = 'ph ' + cls;
    });
  }

  function tick(){
    clampEl(document.getElementById('ctxMenu'));
    clampEl(document.getElementById('reactionPicker'));
    var ep = document.getElementById('emojiPopover');
    if(ep && ep.classList.contains('is-open')) clampEl(ep);
    setIcon('gallery','ph-image-square');
    setIcon('checklist','ph-check-square');
    setIcon('music','ph-music-notes');
    setIcon('poll','ph-chart-bar');
  }

  new MutationObserver(tick).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});
  window.addEventListener('resize',tick,{passive:true});
  window.addEventListener('scroll',tick,true);
  setInterval(tick,700);
  setTimeout(tick,300);
  console.log('[chat6a] ui hotfix loaded');
})();