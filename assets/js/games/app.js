var S = {
  coins:1000,
  owned:['blackjack','lucky','slots','roulette','hilo'],
  lastDaily:0,
  pname:'Игрок',
  bj:{bet:25,wins:0,losses:0,draws:0,gain:0},
  pk:{wins:0,losses:0},
  kosBet:50,
  paukBet:75,
  dkBet:40,
  luckyBet:25,
  slotsBet:25,
  rouletteBet:25,
  hiloBet:25
};

let lucky = {
  cur:null,
  phase:'idle',
  deck:[],
  stakePaid:0
};

function save(){ try{localStorage.setItem('cv3',JSON.stringify(S));}catch(e){} }
function load(){
  try{
    const d=localStorage.getItem('cv3');
    if(d)Object.assign(S,JSON.parse(d));
  }catch(e){}
  const defBj={bet:25,wins:0,losses:0,draws:0,gain:0};
  S.bj=(S.bj&&typeof S.bj==='object')?Object.assign({},defBj,S.bj):defBj;
  S.pk=(S.pk&&typeof S.pk==='object')?Object.assign({wins:0,losses:0},S.pk):{wins:0,losses:0};
  if(!Array.isArray(S.owned))S.owned=['blackjack','lucky','slots','hilo'];
  if(typeof S.kosBet!=='number')S.kosBet=50;
  if(typeof S.paukBet!=='number')S.paukBet=75;
  if(typeof S.dkBet!=='number')S.dkBet=40;
  S.bj.bet=Math.min(1000,Math.max(10,S.bj.bet==null?25:+S.bj.bet));
  S.kosBet=Math.min(1000,Math.max(10,+S.kosBet||50));
  S.paukBet=Math.min(1000,Math.max(10,+S.paukBet||75));
  S.dkBet=Math.min(1000,Math.max(10,+S.dkBet||40));
  if(typeof S.luckyBet!=='number')S.luckyBet=25;
  S.luckyBet=Math.min(1000,Math.max(10,+S.luckyBet||25));
  if(typeof S.slotsBet!=='number')S.slotsBet=25;
  S.slotsBet=Math.min(1000,Math.max(10,+S.slotsBet||25));
  if(typeof S.rouletteBet!=='number')S.rouletteBet=25;
  S.rouletteBet=Math.min(1000,Math.max(10,+S.rouletteBet||25));
  if(typeof S.hiloBet!=='number')S.hiloBet=25;
  S.hiloBet=Math.min(1000,Math.max(10,+S.hiloBet||25));
}

// ── HELPERS ────────────────────────────────────────────
function mkDeck(n,suits,vals){
  suits=suits||['♠','♥','♦','♣'];
  vals=vals||['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const d=[];for(let i=0;i<(n||1);i++)for(const s of suits)for(const v of vals)d.push({v,s});
  return shuf(d);
}
function mk36(n){return mkDeck(n,['♠','♥','♦','♣'],['6','7','8','9','10','J','Q','K','A']);}
function shuf(a){for(let i=a.length-1;i>0;i--){const j=0|Math.random()*(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function red(s){return s==='♥'||s==='♦';}

function C(card,hidden,small,sel,fn,drag){
  const d=document.createElement('div');
  d.className='card'+(small?' sm':'')+(hidden?'':red(card.s)?' red':' black')+(hidden?' hidden':'')+(sel?' sel':'');
  if(!hidden){
    const tl=document.createElement('div');tl.className='cc tl';tl.textContent=card.v+card.s;
    const br=document.createElement('div');br.className='cc br';br.textContent=card.v+card.s;
    const mid=document.createElement('div');mid.textContent=card.s;
    d.append(tl,mid,br);
  }
  if(fn)d.onclick=fn;
  if(drag&&!hidden){
    d.setAttribute('draggable','true');
    d.addEventListener('dragstart',e=>{
      try{e.dataTransfer.setData('text/x-card',JSON.stringify(drag));e.dataTransfer.effectAllowed='move';}catch(_){}
      d.classList.add('dragging');
    });
    d.addEventListener('dragend',()=>d.classList.remove('dragging'));
  }else d.setAttribute('draggable','false');
  return d;
}
function allowDragOver(e){e.preventDefault();}
function bindDropZone(el,onDrop){
  if(!el)return;
  el.addEventListener('dragover',allowDragOver);
  el.addEventListener('dragenter',()=>el.classList.add('drop-hover'));
  el.addEventListener('dragleave',()=>el.classList.remove('drop-hover'));
  el.addEventListener('drop',e=>{el.classList.remove('drop-hover');onDrop(e);});
}
function slot(small,fn){const d=document.createElement('div');d.className='card-slot'+(small?' sm':'');if(fn)d.onclick=fn;return d;}

window.syncCoins = function syncCoins(bump){
  const el=document.getElementById('coins-display');
  const wrap=document.querySelector('.coins-display');
  const panelAmt=document.getElementById('coins-panel-amount');
  if(el)el.textContent=S.coins.toLocaleString();
  if(panelAmt)panelAmt.textContent=S.coins.toLocaleString();
  if(bump&&wrap){wrap.classList.remove('coin-bump');void wrap.offsetWidth;wrap.classList.add('coin-bump');}
}

function openCoinsPanel(ev){
  if(ev)ev.stopPropagation();
  const p=document.getElementById('coins-panel');
  const panelAmt=document.getElementById('coins-panel-amount');
  if(panelAmt)panelAmt.textContent=S.coins.toLocaleString();
  if(p){p.classList.add('open');p.setAttribute('aria-hidden','false');}
}
function closeCoinsPanel(){
  const p=document.getElementById('coins-panel');
  if(p){p.classList.remove('open');p.setAttribute('aria-hidden','true');}
}
function deleteAllStars(){
  if(S.coins<=0){closeCoinsPanel();return;}
  if(!confirm('Обнулить все ⭐?'))return;
  S.coins=0;
  syncCoins(false);
  try{localStorage.removeItem('cv3_top_one');}catch(_){}
  save();
  toast('Звёзды обнулены');
  closeCoinsPanel();
}
function addCoins(n,msg){S.coins+=n;syncCoins(n>0);if(msg)toast(msg);save();}
function spend(n){S.coins=Math.max(0,S.coins-n);syncCoins(false);save();}

let _tt;
function toast(msg){
  const t=document.getElementById('toast');
  if(!t)return;
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(_tt);
  _tt=setTimeout(()=>t.classList.remove('show'),2200);
}

// ── Счётчик очков за раздачу/партию (до 1000, тап по кружкам суммирует) ──
const BET_MIN=10,BET_MAX=1000;
const BET_DEFAULTS={bj:25,kos:50,pauk:75,dk:40,lucky:25,slots:25,roulette:25,hilo:25};
function updateStackVis(id,bet){
  const el=document.getElementById(id);
  if(!el)return;
  el.innerHTML='';
  const n=Math.min(12,Math.max(1,Math.ceil(bet/85)));
  for(let i=0;i<n;i++){
    const s=document.createElement('span');
    s.className='on';
    el.appendChild(s);
  }
}
function bumpBetEl(id){
  const n=document.getElementById(id);
  if(!n)return;
  n.classList.remove('bet-bump');
  void n.offsetWidth;
  n.classList.add('bet-bump');
}
function stackBet(game,delta,reset){
  const def=BET_DEFAULTS[game]||25;
  let cur;
  if(game==='bj')cur=S.bj.bet;
  else if(game==='kos')cur=S.kosBet;
  else if(game==='pauk')cur=S.paukBet;
  else if(game==='dk')cur=S.dkBet;
  else if(game==='lucky')cur=S.luckyBet;
  else if(game==='slots')cur=S.slotsBet;
  else if(game==='roulette')cur=S.rouletteBet;
  else if(game==='hilo')cur=S.hiloBet;
  else return;
  let next;
  if(reset)next=def;
  else next=Math.min(BET_MAX,cur+(delta|0));
  next=Math.max(BET_MIN,next);
  if(!reset&&(delta|0)>0)next=Math.min(next,S.coins);
  if(game==='bj')S.bj.bet=next;
  else if(game==='kos')S.kosBet=next;
  else if(game==='pauk')S.paukBet=next;
  else if(game==='dk')S.dkBet=next;
  else if(game==='lucky')S.luckyBet=next;
  else if(game==='slots')S.slotsBet=next;
  else if(game==='roulette')S.rouletteBet=next;
  else if(game==='hilo')S.hiloBet=next;
  if(game==='bj'){
    document.getElementById('bj-bet').textContent=next;
    bumpBetEl('bj-bet');
    updateStackVis('bj-stack-v',next);
  }else if(game==='kos'){
    document.getElementById('kos-bet-disp').textContent=next;
    bumpBetEl('kos-bet-disp');
    updateStackVis('kos-stack-v',next);
  }else if(game==='pauk'){
    document.getElementById('pauk-bet-disp').textContent=next;
    bumpBetEl('pauk-bet-disp');
    updateStackVis('pauk-stack-v',next);
  }else if(game==='dk'){
    document.getElementById('dk-bet-disp').textContent=next;
    bumpBetEl('dk-bet-disp');
    updateStackVis('dk-stack-v',next);
  }else if(game==='lucky'){
    document.getElementById('lucky-bet-disp').textContent=next;
    bumpBetEl('lucky-bet-disp');
    updateStackVis('lucky-stack-v',next);
  }else if(game==='slots'){
    document.getElementById('slots-bet-disp').textContent=next;
    bumpBetEl('slots-bet-disp');
    updateStackVis('slots-stack-v',next);
  }else if(game==='roulette'){
    document.getElementById('roulette-bet-disp').textContent=next;
    bumpBetEl('roulette-bet-disp');
    updateStackVis('roulette-stack-v',next);
  }else if(game==='hilo'){
    document.getElementById('hilo-bet-disp').textContent=next;
    bumpBetEl('hilo-bet-disp');
    updateStackVis('hilo-stack-v',next);
  }
  save();
}
function paintAllBets(){
  document.getElementById('bj-bet').textContent=S.bj.bet;
  updateStackVis('bj-stack-v',S.bj.bet);
  document.getElementById('kos-bet-disp').textContent=S.kosBet;
  updateStackVis('kos-stack-v',S.kosBet);
  document.getElementById('pauk-bet-disp').textContent=S.paukBet;
  updateStackVis('pauk-stack-v',S.paukBet);
  document.getElementById('dk-bet-disp').textContent=S.dkBet;
  updateStackVis('dk-stack-v',S.dkBet);
  const lb=document.getElementById('lucky-bet-disp');
  if(lb){lb.textContent=S.luckyBet;updateStackVis('lucky-stack-v',S.luckyBet);}
  const sb=document.getElementById('slots-bet-disp');
  if(sb){sb.textContent=S.slotsBet;updateStackVis('slots-stack-v',S.slotsBet);}
  const rb=document.getElementById('roulette-bet-disp');
  if(rb){rb.textContent=S.rouletteBet;updateStackVis('roulette-stack-v',S.rouletteBet);}
  const hb=document.getElementById('hilo-bet-disp');
  if(hb){hb.textContent=S.hiloBet;updateStackVis('hilo-stack-v',S.hiloBet);}
}

function showScreen(id){
  const scr = document.getElementById('screen-'+id);
  if(!scr){
    toast('Экран не найден');
    return;
  }

  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  scr.classList.add('active');

  document.querySelectorAll('.nav-tab').forEach((t,i)=>
    t.classList.toggle('active',['home','shop'][i]===id)
  );

  document.body.classList.toggle('in-game',!['home','shop'].includes(id));

  closeCoinsPanel();

  if(!['home','shop'].includes(id)){
    onEnterGame(id);
  }
}

function onEnterGame(id){
  try{
    if(id==='lucky') luckyRender();
    if(id==='slots') slotsIdle();
    if(id==='hilo') hiloEnsure();
    if(id==='roulette'){ rlInit(); }
  }catch(_){}
}

// ── DAILY ──────────────────────────────────────────────
function today(){const n=new Date();return n.getFullYear()*10000+n.getMonth()*100+n.getDate();}
function checkDaily(){const b=document.getElementById('daily-btn');const ok=S.lastDaily!==today();b.disabled=!ok;b.textContent=ok?'+1000 ⭐':'Уже брали ✓';}
function claimDaily(){if(S.lastDaily===today())return;S.lastDaily=today();addCoins(1000,'+1000 ⭐');checkDaily();}

// ── HOME / SHOP ────────────────────────────────────────
const ITEMS=[
  {id:'blackjack',name:'Блэкджек',icon:'🃏',price:0,desc:'До 21 против дилера'},
  {id:'lucky',name:'На удачу',icon:'🎯',price:0,desc:'Красное или чёрное - одна карта'},
  {id:'slots',name:'Слоты',icon:'🎰',price:0,desc:'Три барабана, комбо на ⭐'},
  {id:'roulette',name:'Рулетка',icon:'🎡',price:0,desc:'Красное, чёрное или зеро'},
  {id:'hilo',name:'Больше-меньше',icon:'📈',price:0,desc:'Следующая карта выше или ниже'},
  {id:'durak',name:'Дурак',icon:'🤡',price:300,desc:'Против компьютера, колода 36'},
  {id:'kosinka',name:'Косынка',icon:'♠',price:200,desc:'Пасьянс по классике'},
  {id:'pauk',name:'Паук',icon:'🕷',price:400,desc:'Одна масть, десять колонок'},
  {id:'poker',name:'Покер',icon:'🎴',price:500,desc:'Пять карт и замена'},
];

function renderHome(){
  const g = document.getElementById('games-grid');
  g.innerHTML = '';

  ITEMS.forEach(item=>{
    const own = S.owned.includes(item.id);

    const d = document.createElement('div');
    d.className = 'game-card' + (own ? '' : ' locked');

    d.innerHTML = `
      <span class="game-icon">${item.icon}</span>
      <div class="game-name">${item.name}</div>
      <div class="game-desc">${item.desc}</div>
      ${own ? '' : '<div class="lock-badge">🔒 За ⭐ откроется</div>'}
    `;

    if(own){
      d.onclick = () => showScreen(item.id);
    }

    g.appendChild(d);
  });

  // ✅ онлайн карточка
  const onlineCard = document.createElement('div');
  onlineCard.className='game-card';
  onlineCard.style.cssText='border-color:rgba(46,204,113,0.45);box-shadow:0 0 28px rgba(46,204,113,0.12);';

  onlineCard.innerHTML=`
    <span class="game-icon">🌐</span>
    <div class="game-name" style="color:var(--gold2)">Блэкджек Онлайн</div>
    <div class="game-desc">Мультиплеер · До 5 игроков</div>
  `;

  onlineCard.onclick=()=>window.open('blackjack-online.html','_blank');
  g.appendChild(onlineCard);

  checkDaily();
}

function renderShop(){
  const g=document.getElementById('shop-grid');g.innerHTML='';
  ITEMS.forEach(item=>{
    const own=S.owned.includes(item.id);
    const d=document.createElement('div');d.className='shop-item'+(own?' owned':'');
    d.innerHTML=`<div class="shop-item-icon">${item.icon}</div><div class="shop-item-name">${item.name}</div><div class="shop-item-desc">${item.desc}</div><div class="shop-price-tag">${item.price?item.price+' ⭐':'Сразу в игре'}</div>`;
    if(own){d.innerHTML+='<div class="owned-label">✓ Открыто</div>';}
    else{
      const b=document.createElement('button');b.className='shop-btn';
      b.textContent=item.price?'Открыть за '+item.price+' ⭐':'Уже можно';
      b.disabled=item.price>0&&S.coins<item.price;
      b.onclick=()=>{
        if(S.owned.includes(item.id)){toast('Уже открыто');return;}
        if(item.price>0&&S.coins<item.price){toast('Мало ⭐');return;}
        if(item.price>0)spend(item.price);
        S.owned.push(item.id);
        save();renderShop();renderHome();toast(item.name+' открыта');
      };
      d.appendChild(b);
    }
    g.appendChild(d);
  });
}

// ── BLACKJACK ──────────────────────────────────────────
let bj={deck:[],ph:[],dh:[],over:false,stake:0};
function bjV(c){return['J','Q','K'].includes(c.v)?10:c.v==='A'?11:parseInt(c.v);}
function bjS(h){let s=h.reduce((a,c)=>a+bjV(c),0),ac=h.filter(c=>c.v==='A').length;while(s>21&&ac-- >0)s-=10;return s;}
function bjStats(){const b=S.bj;['sw','sl','sd'].forEach((id,i)=>document.getElementById('bj-'+id).textContent=[b.wins,b.losses,b.draws][i]);const sg=document.getElementById('bj-sg');sg.textContent=(b.gain>=0?'+':'')+b.gain;sg.style.color=b.gain>0?'#2ecc71':b.gain<0?'#e57373':'var(--gold)';}
function bjRC(hand,id,h2){const c=document.getElementById(id);c.innerHTML='';hand.forEach((card,i)=>c.appendChild(C(card,h2&&i===1)));}
function bjNew(){
  if(S.coins<S.bj.bet){toast('Мало ⭐ на эту раздачу');return;}
  spend(S.bj.bet);
  bj.deck=mkDeck();bj.ph=[bj.deck.pop(),bj.deck.pop()];bj.dh=[bj.deck.pop(),bj.deck.pop()];bj.over=false;bj.stake=S.bj.bet;
  bjRC(bj.ph,'bj-pcards',false);bjRC(bj.dh,'bj-dcards',true);
  document.getElementById('bj-pscore').textContent=bjS(bj.ph);document.getElementById('bj-dscore').textContent='?';
  const r=document.getElementById('bj-result');r.textContent='';r.className='result-box';
  ['bj-hit','bj-stand','bj-double'].forEach(id=>document.getElementById(id).disabled=false);
  bjStats();if(bjS(bj.ph)===21)bjStand();
}
function bjHit(){if(bj.over)return;bj.ph.push(bj.deck.pop());bjRC(bj.ph,'bj-pcards',false);document.getElementById('bj-pscore').textContent=bjS(bj.ph);document.getElementById('bj-double').disabled=true;if(bjS(bj.ph)>21)bjEnd('bust');}
function bjStand(){if(bj.over)return;while(bjS(bj.dh)<17)bj.dh.push(bj.deck.pop());bjRC(bj.dh,'bj-dcards',false);document.getElementById('bj-dscore').textContent=bjS(bj.dh);const ps=bjS(bj.ph),ds=bjS(bj.dh);if(ds>21||ps>ds)bjEnd('win');else if(ps<ds)bjEnd('lose');else bjEnd('draw');}
function bjDouble(){
  if(bj.over||bj.ph.length!==2)return;
  if(S.coins<S.bj.bet){toast('Мало ⭐ для удвоения');return;}
  spend(S.bj.bet);
  bj.stake=(bj.stake||S.bj.bet)+S.bj.bet;
  bj.ph.push(bj.deck.pop());bjRC(bj.ph,'bj-pcards',false);document.getElementById('bj-pscore').textContent=bjS(bj.ph);
  document.getElementById('bj-double').disabled=true;
  if(bjS(bj.ph)>21)bjEnd('bust');else bjStand();
}
function bjEnd(t){
  bj.over=true;['bj-hit','bj-stand','bj-double'].forEach(id=>document.getElementById(id).disabled=true);
  bjRC(bj.dh,'bj-dcards',false);document.getElementById('bj-dscore').textContent=bjS(bj.dh);
  const r=document.getElementById('bj-result');const b=S.bj;
  const stake=bj.stake>0?bj.stake:S.bj.bet;
  if(t==='bust'){r.textContent='Перебор! -'+stake+' ⭐';r.className='result-box lose';b.losses++;b.gain-=stake;toast('-'+stake+' ⭐');}
  else if(t==='win'){
    const nat=bjS(bj.ph)===21&&bj.ph.length===2;
    const win=nat?Math.round(stake*2.5):stake*2;
    const profit=win-stake;
    r.textContent=(nat?'Идеальное 21! ':'Победа! ')+(profit>=0?'+'+profit+' ⭐':profit+' ⭐');
    r.className='result-box win';b.wins++;addCoins(win);b.gain+=profit;
  }
  else if(t==='lose'){r.textContent='У дилера сильнее -'+stake+' ⭐';r.className='result-box lose';b.losses++;b.gain-=stake;toast('-'+stake+' ⭐');}
  else{r.textContent='Ничья - ⭐ раздачи вернулись';r.className='result-box draw';b.draws++;addCoins(stake);}
  bjStats();save();
}

// ── DURAK ──────────────────────────────────────────────
const DK_ORD=['6','7','8','9','10','J','Q','K','A'];
function dkR(v){return DK_ORD.indexOf(v);}
function beats(a,d,tr){if(d.s===a.s)return dkR(d.v)>dkR(a.v);return d.s===tr&&a.s!==tr;}

let dk={deck:[],ph:[],dh:[],table:[],trump:null,pturn:true,phase:'attack',p1sel:null,p2sel:null,_settled:false,started:false};

function dkNew(){
  if(S.coins<S.dkBet){toast('Мало ⭐ на партию');return;}
  spend(S.dkBet);
  dk={deck:mk36(),ph:[],dh:[],table:[],trump:null,pturn:true,phase:'attack',p1sel:null,p2sel:null,_settled:false,started:true};
  dk.trump=dk.deck[0].s;
  for(let i=0;i<6;i++){dk.ph.push(dk.deck.pop());dk.dh.push(dk.deck.pop());}
  document.getElementById('dk-bet-row').style.display='flex';
  const res=document.getElementById('dk-result');
  if(res){res.textContent='';res.className='result-box';}
  document.getElementById('dk-p2-badge').innerHTML='ИИ: <span id="dk-ai-cnt">6</span> карт';
  dkRender();
}
function dkSettle(){
  if(dk._settled||!dk.started)return;
  const p1w=!dk.ph.length&&dk.dh.length;
  const p2w=!dk.dh.length&&dk.ph.length;
  const dr=!dk.ph.length&&!dk.dh.length;
  if(!p1w&&!p2w&&!dr)return;
  dk._settled=true;
  const r=document.getElementById('dk-result');
  const st=S.dkBet;
  if(p1w){
    addCoins(st*2);
    r.textContent='Победа! +'+(st*2)+' ⭐';
    r.className='result-box win';
  }else if(p2w){
    r.textContent='Проигрыш -'+st+' ⭐';
    r.className='result-box lose';
  }else if(dr){
    addCoins(st);
    r.textContent='Ничья - ⭐ вернули';
    r.className='result-box draw';
  }
  save();
}
function dkRender(){
  const tr=dk.trump||'';
  const te=document.getElementById('dk-trump');te.textContent=tr;te.style.color=red(tr)?'#e74c3c':'var(--gold)';
  document.getElementById('dk-deck').textContent=dk.deck.length;
  const ac=document.getElementById('dk-ai-cnt');if(ac)ac.textContent=dk.dh.length;
  const tbl=document.getElementById('dk-table');tbl.innerHTML='';
  if(!dk.table.length){tbl.innerHTML='<span style="color:rgba(212,175,55,0.18);font-family:Cinzel,serif;font-size:0.75em;letter-spacing:2px;">СТОЛ ПУСТ</span>';}
  else{dk.table.forEach(p=>{const w=document.createElement('div');w.className='dk-pair';w.appendChild(C(p.a));if(p.d)w.appendChild(C(p.d));tbl.appendChild(w);});}
  const h1=document.getElementById('dk-hand');h1.innerHTML='';
  const p1active=dk.pturn;
  h1.style.filter='none';
  dk.ph.forEach((card,i)=>{
    const sel=dk.p1sel===i;
    const el=C(card,false,false,sel,p1active?()=>{dk.p1sel=(dk.p1sel===i?null:i);dkRender();}:null,p1active?{dk:'p1',i}:null);
    h1.appendChild(el);
  });
  document.getElementById('dk-p1-lbl').textContent='Ваши карты';
  const st=document.getElementById('dk-status');
  if(!dk.ph.length&&dk.dh.length){st.textContent='🏆 Ты раздал все карты!';st.className='dk-status good';}
  else if(dk.dh.length&&!dk.ph.length){st.textContent='😔 Компьютер выиграл';st.className='dk-status bad';}
  else if(!dk.ph.length&&!dk.dh.length){st.textContent='Ничья';st.className='dk-status';}
  else{st.textContent=dk.pturn?(dk.phase==='attack'?'Твой ход - атакуй':'Твой ход - отбейся'):'Компьютер думает...';st.className='dk-status';}
  if(dk.started){
    const p1w=!dk.ph.length&&dk.dh.length,p2w=!dk.dh.length&&dk.ph.length,dr=!dk.ph.length&&!dk.dh.length;
    if(p1w||p2w||dr)dkSettle();
  }
}
function dkRefill(){while(dk.ph.length<6&&dk.deck.length)dk.ph.push(dk.deck.pop());while(dk.dh.length<6&&dk.deck.length)dk.dh.push(dk.deck.pop());}
function dkAllVals(){return dk.table.flatMap(p=>[p.a.v,p.d?p.d.v:null]).filter(Boolean);}
function dkAttack(){
  if(!dk.pturn||dk.phase!=='attack'){toast('Не ваш ход для атаки');return;}
  if(dk.p1sel===null){toast('Выберите карту');return;}
  const card=dk.ph[dk.p1sel];
  if(dk.table.length){const av=dkAllVals();if(!av.includes(card.v)){toast('Подкидывайте: '+av.join(', '));return;}}
  dk.ph.splice(dk.p1sel,1);dk.table.push({a:card,d:null});dk.p1sel=null;dk.phase='defend';
  dkRender();setTimeout(dkAiDef,650);
}
function dkDefend(){
  if(!dk.pturn||dk.phase!=='defend'){toast('Сейчас не время защиты');return;}
  if(dk.p1sel===null){toast('Выберите карту');return;}
  const ui=dk.table.findIndex(p=>!p.d);if(ui===-1){toast('Всё отбито');return;}
  const def=dk.ph[dk.p1sel];
  if(!beats(dk.table[ui].a,def,dk.trump)){toast('Карта не бьёт!');return;}
  dk.table[ui].d=def;dk.ph.splice(dk.p1sel,1);dk.p1sel=null;
  if(dk.table.every(p=>p.d)){setTimeout(()=>{dk.table=[];dkRefill();dk.pturn=false;dk.phase='attack';dkRender();setTimeout(dkAiAtk,700);},500);}
  dkRender();
}
function dkPass(){
  if(dk.table.length===0){toast('Сначала атакуйте');return;}
  if(dk.phase==='attack'){dk.table=[];dkRefill();dk.pturn=false;dk.phase='attack';dkRender();setTimeout(dkAiAtk,700);}
  else{dk.ph=[...dk.ph,...dk.table.flatMap(p=>[p.a,p.d||[]].flat())];dk.table=[];dkRefill();dk.pturn=false;dk.phase='attack';dkRender();setTimeout(dkAiAtk,700);}
}
function dkAiDef(){
  const last=dk.table[dk.table.length-1];
  if(last&&!last.d){
    const idx=dk.dh.findIndex(c=>beats(last.a,c,dk.trump));
    if(idx===-1){toast('Компьютер забирает стол');dk.dh=[...dk.dh,...dk.table.flatMap(p=>[p.a,p.d||[]].flat())];dk.table=[];dkRefill();dk.pturn=true;dk.phase='attack';dkRender();}
    else{last.d=dk.dh.splice(idx,1)[0];dk.phase='attack';dkRefill();dkRender();}
  }
}
function dkAiAtk(){
  if(!dk.dh.length||dk.pturn){dkRender();return;}
  const best=dk.dh.reduce((b,c)=>{const bt=b.s===dk.trump,ct=c.s===dk.trump;if(bt&&!ct)return c;if(ct&&!bt)return b;return dkR(c.v)<dkR(b.v)?c:b;});
  dk.dh.splice(dk.dh.indexOf(best),1);dk.table.push({a:best,d:null});dk.pturn=true;dk.phase='defend';dkRender();
}

// ── KOSINKA ────────────────────────────────────────────
const KR=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function krN(v){return KR.indexOf(v);}
let kos={deck:[],waste:[],founds:[[],[],[],[]],tab:[],moves:0,score:0,ss:null,si:null,won:false,session:false,stake:0};
function kosSetupBoard(){
  const d=mkDeck();
  kos.tab=Array.from({length:7},(_,i)=>{const col=[];for(let j=0;j<=i;j++){const c={...d.pop()};c.f=j===i;col.push(c);}return col;});
  kos.deck=d;kos.waste=[];kos.founds=[[],[],[],[]];kos.moves=0;kos.score=0;kos.ss=null;kos.si=null;kos.won=false;
}
function kosNew(){
  if(kos.session&&!kos.won){toast('Сначала «Отменить партию» или дойдите до победы');return;}
  const st=S.kosBet||50;
  if(S.coins<st){toast('Мало ⭐ на новую партию');return;}
  spend(st);
  kos.stake=st;kos.session=true;kos.won=false;
  kosSetupBoard();
  document.getElementById('kos-win').style.display='none';
  const kr=document.getElementById('kos-result');if(kr){kr.textContent='';kr.className='result-box';}
  kosRender();save();
}
function kosSurrender(){
  if(!kos.session||kos.won)return;
  const kr=document.getElementById('kos-result');
  kr.textContent='Партия отменена (учтено -'+kos.stake+' ⭐)';
  kr.className='result-box lose';
  kos.session=false;kos.stake=0;
  kosSetupBoard();
  document.getElementById('kos-win').style.display='none';
  kosRender();save();
}
function kosDraw(){
  if(!kos.deck.length){if(!kos.waste.length)return;kos.deck=kos.waste.reverse().map(c=>({...c,f:false}));kos.waste=[];}
  if(kos.deck.length)kos.waste.push({...kos.deck.pop(),f:true});
  kosRender();
}
function kosApplyDragSel(raw){
  let meta;try{meta=JSON.parse(raw);}catch(_){return false;}
  if(meta.k==='w'){kos.ss='waste';kos.si=0;return true;}
  if(meta.k==='t'){kos.ss='tab';kos.si=meta.ci;return true;}
  return false;
}
function kosHandleDrop(e,dest,di){
  const raw=e.dataTransfer.getData('text/x-card');
  if(!raw||!kosApplyDragSel(raw))return;
  kosDrop(dest,di);
}
function kosRender(){
  document.getElementById('kos-moves').textContent=kos.moves;
  document.getElementById('kos-score').textContent=kos.score;
  const stk=document.getElementById('kos-stock');stk.innerHTML='';
  if(kos.deck.length)stk.appendChild(C({v:'',s:''},true,true));
  else{stk.innerHTML='↺';stk.style.color='rgba(212,175,55,0.4)';}
  const wst=document.getElementById('kos-waste');wst.innerHTML='';
  if(kos.waste.length){
    const c=kos.waste[kos.waste.length-1];
    wst.appendChild(C(c,false,true,kos.ss==='waste',()=>kosClick('waste',0),{k:'w'}));
  }
  const fnd=document.getElementById('kos-founds');fnd.innerHTML='';
  ['♠','♥','♦','♣'].forEach((s,i)=>{
    if(!kos.founds[i].length){
      const sl=slot(true,()=>kosDrop('found',i));sl.textContent=s;
      bindDropZone(sl,e=>kosHandleDrop(e,'found',i));
      fnd.appendChild(sl);
    }else{
      const top=C(kos.founds[i][kos.founds[i].length-1],false,true,false,()=>kosDrop('found',i),null);
      bindDropZone(top,e=>kosHandleDrop(e,'found',i));
      fnd.appendChild(top);
    }
  });
  const tb=document.getElementById('kos-tab');tb.innerHTML='';
  kos.tab.forEach((col,ci)=>{
    const cd=document.createElement('div');cd.className='sol-col';
    if(!col.length){
      const sl=slot(true,()=>kosDrop('tab',ci));
      bindDropZone(sl,e=>kosHandleDrop(e,'tab',ci));
      cd.appendChild(sl);
    }
    col.forEach((card,ri)=>{
      const sel=kos.ss==='tab'&&kos.si===ci&&ri===col.length-1;
      const el=C(card,!card.f,true,sel,card.f?()=>kosClick('tab',ci):null,card.f?{k:'t',ci}:null);
      if(card.f)bindDropZone(el,e=>kosHandleDrop(e,'tab',ci));
      cd.appendChild(el);
    });
    tb.appendChild(cd);
  });
  if(!kos.won&&kos.founds.every(f=>f.length===13)){
    kos.won=true;
    const gain=Math.max(kos.stake*3,Math.floor((S.kosBet||50)*3));
    document.getElementById('kos-win').textContent='🏆 Победа! +'+gain+' ⭐';
    document.getElementById('kos-win').style.display='block';
    addCoins(gain);
    kos.session=false;
  }
}
function kosClick(src,idx){
  if(kos.ss!==null&&kos.ss===src&&kos.si===idx){kos.ss=null;kos.si=null;kosRender();return;}
  if(kos.ss!==null){kosDrop(src,idx);return;}
  kos.ss=src;kos.si=idx;kosRender();
}
function kosDrop(dest,di){
  if(kos.ss===null){kosRender();return;}
  let card=null;
  if(kos.ss==='waste')card=kos.waste[kos.waste.length-1];
  else if(kos.ss==='tab'){const col=kos.tab[kos.si];card=col[col.length-1];}
  if(!card){kos.ss=null;kos.si=null;kosRender();return;}
  let ok=false;
  if(dest==='found'){
    const f=kos.founds[di];
    ok=(f.length===0&&card.v==='A')||(f.length&&f[f.length-1].s===card.s&&krN(card.v)===krN(f[f.length-1].v)+1);
    if(ok){rmSrc();f.push(card);kos.moves++;kos.score+=10;}
  } else if(dest==='tab'){
    const col=kos.tab[di];const top=col.length?col[col.length-1]:null;
    ok=(top===null&&card.v==='K')||(top&&top.f&&red(top.s)!==red(card.s)&&krN(card.v)===krN(top.v)-1);
    if(ok){rmSrc();col.push({...card,f:true});kos.moves++;}
  }
  function rmSrc(){if(kos.ss==='waste')kos.waste.pop();else{kos.tab[kos.si].pop();const c=kos.tab[kos.si];if(c.length&&!c[c.length-1].f)c[c.length-1].f=true;}}
  kos.ss=null;kos.si=null;kosRender();
}

// ── PAUK ────────────────────────────────────────────────
const PR=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function prN(v){return PR.indexOf(v);}
let pauk={tab:[],stock:[],deals:5,sets:0,moves:0,sel:-1,session:false,stake:0,won:false};
function paukSetupBoard(){
  const d=[];for(let i=0;i<8;i++)for(const v of PR)d.push({v,s:'♠'});shuf(d);
  pauk.tab=Array.from({length:10},(_,i)=>{const col=[];const cnt=i<4?6:5;for(let j=0;j<cnt;j++){const c={...d.pop()};c.f=j===cnt-1;col.push(c);}return col;});
  pauk.stock=d;pauk.deals=5;pauk.sets=0;pauk.moves=0;pauk.sel=-1;
}
function paukNew(){
  if(pauk.session&&!pauk.won){toast('Сначала «Отменить партию» или соберите паука');return;}
  const st=S.paukBet||75;
  if(S.coins<st){toast('Мало ⭐ на новую партию');return;}
  spend(st);
  pauk.stake=st;pauk.session=true;pauk.won=false;
  paukSetupBoard();
  document.getElementById('pauk-win').style.display='none';
  const pr=document.getElementById('pauk-result');if(pr){pr.textContent='';pr.className='result-box';}
  paukRender();save();
}
function paukSurrender(){
  if(!pauk.session||pauk.won)return;
  const pr=document.getElementById('pauk-result');
  pr.textContent='Партия отменена (учтено -'+pauk.stake+' ⭐)';
  pr.className='result-box lose';
  pauk.session=false;pauk.stake=0;pauk.won=false;
  paukSetupBoard();
  document.getElementById('pauk-win').style.display='none';
  paukRender();save();
}
function paukDeal(){
  if(!pauk.deals){toast('Раздачи закончились');return;}
  if(pauk.stock.length<10){toast('Мало карт');return;}
  pauk.tab.forEach(col=>col.push({...pauk.stock.pop(),f:true}));
  pauk.deals--;paukCheck();paukRender();
}
function paukCheck(){
  pauk.tab.forEach(col=>{
    if(col.length<13)return;
    const top=col.slice(-13);
    if(!top.every(c=>c.f)||top[0].v!=='K'||top[12].v!=='A')return;
    if(top.every((c,i)=>!i||prN(c.v)===prN(top[i-1].v)-1)){col.splice(-13);pauk.sets++;addCoins(150,'Ряд собран +150 ⭐');}
  });
}
function paukMove(fromCi,toCi){
  if(fromCi===toCi)return;
  const src=pauk.tab[fromCi];const dst=pauk.tab[toCi];
  const card=src[src.length-1];const top=dst.length?dst[dst.length-1]:null;
  if(card&&card.f&&(top===null||prN(card.v)===prN(top.v)-1)){
    dst.push({...card,f:true});src.pop();
    if(src.length&&!src[src.length-1].f)src[src.length-1].f=true;
    pauk.moves++;paukCheck();
  }else if(card)toast('Нельзя');
}
function paukHandleColDrop(e,dstCi){
  const raw=e.dataTransfer.getData('text/x-card');if(!raw)return;
  let m;try{m=JSON.parse(raw);}catch(_){return;}
  if(m.pk!=='col')return;
  paukMove(m.ci,dstCi);
  pauk.sel=-1;paukRender();
}
function paukRender(){
  document.getElementById('pauk-moves').textContent=pauk.moves;
  document.getElementById('pauk-sets').textContent=pauk.sets;
  document.getElementById('pauk-deals').textContent=pauk.deals;
  const tb=document.getElementById('pauk-tab');tb.innerHTML='';
  pauk.tab.forEach((col,ci)=>{
    const cd=document.createElement('div');cd.className='sol-col';cd.style.minWidth='64px';
    if(!col.length){
      const sl=slot(true,()=>paukClick(ci));
      bindDropZone(sl,e=>paukHandleColDrop(e,ci));
      cd.appendChild(sl);
    }
    col.forEach((card,ri)=>{
      const el=C(card,!card.f,true,pauk.sel===ci&&ri===col.length-1,card.f?()=>paukClick(ci):null,card.f?{pk:'col',ci}:null);
      if(card.f)bindDropZone(el,e=>paukHandleColDrop(e,ci));
      cd.appendChild(el);
    });
    tb.appendChild(cd);
  });
  if(pauk.sets===8&&document.getElementById('pauk-win').style.display==='none'){
    const gain=Math.max(Math.floor(pauk.stake*5),Math.floor((S.paukBet||75)*5));
    document.getElementById('pauk-win').textContent='🏆 Победа! +'+gain+' ⭐';
    document.getElementById('pauk-win').style.display='block';
    addCoins(gain);
    pauk.session=false;pauk.won=true;
  }
}
function paukClick(ci){
  if(pauk.sel===-1){pauk.sel=ci;paukRender();return;}
  if(pauk.sel===ci){pauk.sel=-1;paukRender();return;}
  paukMove(pauk.sel,ci);
  pauk.sel=-1;paukRender();
}

// ── POKER ───────────────────────────────────────────────
const PKR=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function pkrN(v){return PKR.indexOf(v);}
function pkScore(hand){
  const cnt={};hand.forEach(c=>{cnt[c.v]=(cnt[c.v]||0)+1;});
  const v=Object.values(cnt).sort((a,b)=>b-a);
  const fl=hand.every(c=>c.s===hand[0].s);
  const rk=hand.map(c=>pkrN(c.v)).sort((a,b)=>a-b);
  const st=rk[4]-rk[0]===4&&new Set(rk).size===5;
  if(fl&&st&&rk[4]===12)return 9;if(fl&&st)return 8;if(v[0]===4)return 7;if(v[0]===3&&v[1]===2)return 6;
  if(fl)return 5;if(st)return 4;if(v[0]===3)return 3;if(v[0]===2&&v[1]===2)return 2;if(v[0]===2)return 1;return 0;
}
const PKN=['Старшая карта','Пара','Две пары','Тройка','Стрит','Флеш','Фул хаус','Каре','Стрит флеш','Роял флеш'];
function pkName(h){return PKN[pkScore(h)];}

let pk={deck:[],ph:[],ah:[],pot:0,aib:0,phase:'deal',sel:[],bet:50};
function pkRender(){
  document.getElementById('pk-pot').textContent=pk.pot;
  document.getElementById('pk-aib').textContent=pk.aib;
  document.getElementById('pk-sw').textContent=S.pk.wins;
  document.getElementById('pk-sl').textContent=S.pk.losses;
  const ai=document.getElementById('pk-ai');ai.innerHTML='';
  pk.ah.forEach(c=>ai.appendChild(C(c,pk.phase!=='showdown')));
  const ar=document.getElementById('pk-ai-rank');ar.style.display=pk.phase==='showdown'?'block':'none';
  if(pk.phase==='showdown')ar.textContent='ИИ: '+pkName(pk.ah);
  const pc=document.getElementById('pk-cards');pc.innerHTML='';
  pk.ph.forEach((c,i)=>{const sel=pk.sel.includes(i);pc.appendChild(C(c,false,false,sel,pk.phase==='draw'?()=>{sel?pk.sel.splice(pk.sel.indexOf(i),1):pk.sel.push(i);pkRender();}:null));});
  document.getElementById('pk-rank').textContent=pk.ph.length?'Ваша рука: '+pkName(pk.ph):'';
}
function pkDeal(){
  const inp=document.getElementById('pk-bet');
  let bet=Math.max(10,parseInt(inp.value)||50);
  bet=Math.min(1000,bet);
  inp.value=bet;
  if(S.coins<bet){toast('Мало ⭐ на раздачу');return;}
  spend(bet);pk={deck:mkDeck(),ph:[],ah:[],pot:bet,aib:Math.max(10,0|bet*(0.5+Math.random())),phase:'draw',sel:[],bet};
  for(let i=0;i<5;i++){pk.ph.push(pk.deck.pop());pk.ah.push(pk.deck.pop());}
  ['pk-deal'].forEach(id=>document.getElementById(id).style.display='none');
  ['pk-draw','pk-call','pk-fold'].forEach(id=>document.getElementById(id).style.display='inline-block');
  document.getElementById('pk-result').textContent='';document.getElementById('pk-result').className='result-box';
  document.getElementById('pk-ai-rank').style.display='none';pkRender();
}
function pkDraw(){
  pk.sel.sort((a,b)=>b-a).forEach(i=>pk.ph.splice(i,1,pk.deck.pop()));
  const sc=pkScore(pk.ah);
  if(sc<=1){
    const cnt={};pk.ah.forEach(c=>{cnt[c.v]=(cnt[c.v]||0)+1;});
    const best=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0][0];
    const toDrop=[...pk.ah.keys()].filter(i=>pk.ah[i].v!==best).slice(0,3);
    toDrop.sort((a,b)=>b-a).forEach(i=>pk.ah.splice(i,1,pk.deck.pop()));
  }
  pk.sel=[];pk.phase='showdown';
  ['pk-draw','pk-call','pk-fold'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('pk-deal').style.display='inline-block';
  pkShowdown();
}
function pkCall(){pk.pot+=pk.aib;pkDraw();}
function pkFold(){
  document.getElementById('pk-result').textContent='Пас. -'+pk.bet+' ⭐';document.getElementById('pk-result').className='result-box lose';
  S.pk.losses++;pk.phase='over';
  ['pk-draw','pk-call','pk-fold'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('pk-deal').style.display='inline-block';
  pkRender();save();
}
function pkShowdown(){
  const ps=pkScore(pk.ph),as=pkScore(pk.ah);
  const r=document.getElementById('pk-result');
  if(ps>as){r.textContent='Победа! +'+pk.pot+' ⭐ ('+pkName(pk.ph)+')';r.className='result-box win';addCoins(pk.pot);S.pk.wins++;}
  else if(ps<as){r.textContent='Уступили -'+pk.bet+' ⭐ · '+pkName(pk.ah);r.className='result-box lose';S.pk.losses++;}
  else{const h=Math.floor(pk.pot/2);r.textContent='Ничья! +'+h+' ⭐';r.className='result-box draw';addCoins(h);}
  pk.phase='showdown';pkRender();save();
}

// ── SLOTS / ROULETTE / HI-LO ────────────────────────────
const SLOT_SYM=['🍒','🍋','🍀','⭐','💎','7️⃣'];
let slotsSpinning=false;
function slotsIdle(){
  slotsSpinning=false;
  const b=document.getElementById('slots-spin-btn');
  if(b)b.disabled=false;
}
function slotsPay(a,b,c){
  if(a===b&&b===c){
    if(a==='7️⃣')return 25;
    if(a==='💎')return 15;
    return 10;
  }
  if(a===b||b===c||a===c)return 2;
  return 0;
}
function slotsSpin(){
  if(slotsSpinning)return;
  if(S.coins<S.slotsBet){toast('Мало ⭐');return;}
  spend(S.slotsBet);
  slotsSpinning=true;
  const btn=document.getElementById('slots-spin-btn');
  if(btn)btn.disabled=true;
  const ra=document.getElementById('slots-a'),rb=document.getElementById('slots-b'),rc=document.getElementById('slots-c');
  const resEl=document.getElementById('slots-result');
  if(resEl){resEl.textContent='';resEl.className='result-box';}
  const fa=SLOT_SYM[Math.random()*SLOT_SYM.length|0];
  const fb=SLOT_SYM[Math.random()*SLOT_SYM.length|0];
  const fc=SLOT_SYM[Math.random()*SLOT_SYM.length|0];
  let n=0;
  const t=setInterval(()=>{
    n++;
    if(ra)ra.textContent=SLOT_SYM[Math.random()*SLOT_SYM.length|0];
    if(rb)rb.textContent=SLOT_SYM[Math.random()*SLOT_SYM.length|0];
    if(rc)rc.textContent=SLOT_SYM[Math.random()*SLOT_SYM.length|0];
    if(n<14)return;
    clearInterval(t);
    if(ra)ra.textContent=fa;
    if(rb)rb.textContent=fb;
    if(rc)rc.textContent=fc;
    const mult=slotsPay(fa,fb,fc);
    const stake=S.slotsBet;
    if(mult>0){
      const win=stake*mult;
      if(resEl){resEl.textContent='Выигрыш x'+mult+'! +'+(win)+' ⭐';resEl.className='result-box win';}
      addCoins(win);
    }else if(resEl){resEl.textContent='Не сложилось - ещё раз?';resEl.className='result-box lose';}
    slotsSpinning=false;
    if(btn)btn.disabled=false;
    save();
  },70);
}


const HILO_ORD=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function hiloRank(c){return HILO_ORD.indexOf(c.v);}
let hilo={deck:[],cur:null};
function hiloFreshDeck(){hilo.deck=mkDeck();}
function hiloEnsure(){
  if(!hilo.deck.length)hiloFreshDeck();
  if(!hilo.cur&&hilo.deck.length){hilo.cur=hilo.deck.pop();hiloPaint();}
}
function hiloPaint(){
  const w=document.getElementById('hilo-card-wrap');
  if(!w)return;
  w.innerHTML='';
  if(hilo.cur)w.appendChild(C(hilo.cur,false,false,false,null,null));
}
function hiloNewRound(){
  if(!hilo.deck.length)hiloFreshDeck();
  if(!hilo.deck.length)return;
  hilo.cur=hilo.deck.pop();
  const r=document.getElementById('hilo-result');
  if(r){r.textContent='';r.className='result-box';}
  hiloPaint();
  save();
}
function hiloPick(wantHigh){
  if(!hilo.cur){hiloEnsure();if(!hilo.cur)return;}
  if(S.coins<S.hiloBet){toast('Мало ⭐');return;}
  const stake=S.hiloBet;
  spend(stake);
  if(!hilo.deck.length)hiloFreshDeck();
  const next=hilo.deck.pop();
  const r1=hiloRank(hilo.cur),r2=hiloRank(next);
  const res=document.getElementById('hilo-result');
  let msg='',cls='result-box';
  if(r1===r2){
    addCoins(stake);
    msg='Равные ранги - ставка возвращена';
    cls+=' draw';
    hilo.cur=next;
  }else{
    const ok=wantHigh?r2>r1:r2<r1;
    if(ok){addCoins(stake*2);msg='Угадал! +'+(stake*2)+' ⭐';cls+=' win';}
    else{msg='Мимо - '+stake+' ⭐';cls+=' lose';}
    hilo.cur=next;
  }
  if(res){res.textContent=msg;res.className=cls;}
  hiloPaint();
  save();
}

// ── LUCKY (красное / чёрное) ────────────────────────────
function luckyDeal(){
  if(S.coins<S.luckyBet){toast('Мало ⭐');return;}
  if(!lucky.deck.length)lucky.deck=mkDeck();
  lucky.stakePaid=S.luckyBet;
  spend(S.luckyBet);
  lucky.cur=lucky.deck.pop();
  lucky.phase='guess';
  const r=document.getElementById('lucky-result');
  if(r){r.textContent='';r.className='result-box';}
  luckyRender();
}
function luckyGuess(isRed){
  if(lucky.phase!=='guess'||!lucky.cur)return;
  const card=lucky.cur;
  const win=red(card.s)===isRed;
  lucky.phase='done';
  const r=document.getElementById('lucky-result');
  const b=lucky.stakePaid||S.luckyBet;
  if(win){r.textContent='Угадал! +'+(b*2)+' ⭐';r.className='result-box win';addCoins(b*2);}
  else{r.textContent='Мимо - в другой раз';r.className='result-box lose';}
  luckyRender();
  save();
}
function luckyRender(){
  const w=document.getElementById('lucky-card');
  if(!w)return;
  w.innerHTML='';
  if(lucky.cur)w.appendChild(C(lucky.cur,lucky.phase==='guess',false,false,null,null));
  const deal=lucky.phase==='idle'||lucky.phase==='done';
  const ge=document.getElementById('lucky-deal');
  if(ge)ge.style.display=deal?'inline-block':'none';
  const gr=document.getElementById('lucky-red');
  const gb=document.getElementById('lucky-black');
  const show=lucky.phase==='guess';
  if(gr)gr.style.display=show?'inline-block':'none';
  if(gb)gb.style.display=show?'inline-block':'none';
}

// ── INIT (в конце: все let/const уже заданы) ───────────
// load/render вызываются из Firebase auth модуля после входа
const _dkt=document.getElementById('dk-table');
if(_dkt&&!_dkt._dropInit){
  _dkt._dropInit=1;
  bindDropZone(_dkt,e=>{
    const raw=e.dataTransfer.getData('text/x-card');
    if(!raw)return;
    let dj;try{dj=JSON.parse(raw);}catch(_){return;}
    if(dj.dk==='p1'){
      dk.p1sel=dj.i|0;
      if(dk.phase==='attack')dkAttack();else dkDefend();
    }
  });
}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeCoinsPanel();});
function passiveIncome(){
  const now = Date.now();

  if(!S.lastPassive) S.lastPassive = now;

  if(now - S.lastPassive >= 30*60*1000){
    addCoins(50, "+50 ⭐");
    S.lastPassive = now;
    save();
  }
}

setInterval(passiveIncome, 10000);
// ── ROULETTE — PREMIUM CASINO ──────────────────────────────
// Европейский порядок чисел на колесе
const RL_WHEEL = [
  0,32,15,19,4,21,2,25,17,34,6,27,13,
  36,11,30,8,23,10,5,24,16,33,1,20,14,
  31,9,22,18,29,7,28,12,35,3,26
];
const RL_RED_NUMS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

function rlColor(n){
  if(n===0) return 'green';
  return RL_RED_NUMS.has(n) ? 'red' : 'black';
}

// State
let rl = {
  selectedChip: 25,
  bets: {},
  spinning: false,
  history: [],
  ballAngle: 0,        // текущий угол шарика (радианы)
  ballRadius: 0,       // текущий радиус шарика от центра
  animId: null,
  wheelAngle: 0        // колесо статично, но храним для отрисовки
};

// ─── DRAW WHEEL (статичное, шарик живой) ───────────────────
function rlDrawFrame(ballAngle, ballRadius, showBall) {
  const canvas = document.getElementById('rl-canvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W/2, cy = H/2;
  const R = W/2 - 4;
  const arc = (2*Math.PI) / RL_WHEEL.length;

  ctx.clearRect(0, 0, W, H);

  // ── Внешний обод ──
  const rimGrad = ctx.createRadialGradient(cx, cy-R*0.3, R*0.6, cx, cy, R+4);
  rimGrad.addColorStop(0, '#3a2800');
  rimGrad.addColorStop(0.6, '#1a1000');
  rimGrad.addColorStop(1, '#0a0800');
  ctx.beginPath();
  ctx.arc(cx, cy, R+2, 0, 2*Math.PI);
  ctx.fillStyle = rimGrad;
  ctx.fill();

  // Золотая полоска обода
  ctx.beginPath();
  ctx.arc(cx, cy, R-1, 0, 2*Math.PI);
  ctx.strokeStyle = 'rgba(232,197,71,0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // ── Сегменты ──
  for(let i = 0; i < RL_WHEEL.length; i++){
    const n = RL_WHEEL[i];
    const startA = rl.wheelAngle + i*arc - Math.PI/2;
    const endA = startA + arc;
    const col = rlColor(n);

    // Fill сегмента
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R-6, startA, endA);
    ctx.closePath();
    ctx.fillStyle = col==='green' ? '#1a6b30' : col==='red' ? '#b01818' : '#141414';
    ctx.fill();

    // Разделители
    ctx.strokeStyle = 'rgba(232,197,71,0.22)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Число
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(startA + arc/2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${W < 260 ? 8 : n>9 ? 9 : 10}px Arial`;
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.fillText(String(n), R - 9, 3.5);
    ctx.restore();
  }

  // ── Внутренний декор ──
  // Кольцо сепаратора
  ctx.beginPath();
  ctx.arc(cx, cy, R-6, 0, 2*Math.PI);
  ctx.strokeStyle = 'rgba(232,197,71,0.55)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Внутренний трек шарика (тёмная канавка)
  ctx.beginPath();
  ctx.arc(cx, cy, R-22, 0, 2*Math.PI);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 8;
  ctx.stroke();

  // Декоративные ромбы / разделители на ободе
  for(let i=0; i<8; i++){
    const a = (i/8)*2*Math.PI;
    const dx = Math.cos(a), dy = Math.sin(a);
    const r1 = R-5, r2 = R-20;
    ctx.beginPath();
    ctx.moveTo(cx + dx*r1, cy + dy*r1);
    ctx.lineTo(cx + dx*r2, cy + dy*r2);
    ctx.strokeStyle = 'rgba(232,197,71,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Ромб на переходе
    const rm = (r1+r2)/2;
    ctx.beginPath();
    ctx.arc(cx+dx*rm, cy+dy*rm, 3, 0, 2*Math.PI);
    ctx.fillStyle = 'rgba(232,197,71,0.6)';
    ctx.fill();
  }

  // ── Центральный хаб ──
  const hubGrad = ctx.createRadialGradient(cx-8, cy-8, 2, cx, cy, 32);
  hubGrad.addColorStop(0, '#f0d060');
  hubGrad.addColorStop(0.35, '#c8a040');
  hubGrad.addColorStop(0.7, '#8a6010');
  hubGrad.addColorStop(1, '#3a2005');
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, 2*Math.PI);
  ctx.fillStyle = hubGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(232,197,71,0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Иконка в хабе
  ctx.save();
  ctx.fillStyle = 'rgba(18,8,16,0.7)';
  ctx.font = `${W < 260 ? 13 : 15}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 0;
  ctx.fillText('⚜', cx, cy);
  ctx.restore();

  // ── Шарик ──
  if(showBall){
    const bx = cx + Math.cos(ballAngle) * ballRadius;
    const by = cy + Math.sin(ballAngle) * ballRadius;

    // Тень шарика
    ctx.beginPath();
    ctx.arc(bx+2, by+3, 7, 0, 2*Math.PI);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();

    // Шарик с 3D градиентом
    const bgrad = ctx.createRadialGradient(bx-3, by-3, 1, bx, by, 7);
    bgrad.addColorStop(0, '#ffffff');
    bgrad.addColorStop(0.3, '#e8e8e8');
    bgrad.addColorStop(0.65, '#c0c0c0');
    bgrad.addColorStop(1, '#808080');
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, 2*Math.PI);
    ctx.fillStyle = bgrad;
    ctx.fill();

    // Блик
    ctx.beginPath();
    ctx.arc(bx-2.5, by-2.5, 2.5, 0, 2*Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fill();

    // Свечение
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, 2*Math.PI);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
}

// ─── BUILD TABLE ────────────────────────────────────────────
function rlBuildTable(){
  const grid = document.getElementById('rl-number-grid');
  if(!grid) return;
  grid.innerHTML = '';
  grid.style.gridTemplateRows = 'repeat(4, auto)';

  // 0
  const zeroCell = document.createElement('div');
  zeroCell.className = 'rl-cell zero-cell';
  zeroCell.textContent = '0';
  zeroCell.style.gridRow = '1 / 4';
  zeroCell.style.gridColumn = '1';
  zeroCell.onclick = () => rlBet('n0');
  zeroCell.id = 'rl-n0';
  grid.appendChild(zeroCell);

  // 1–36 (3 строки × 12 колонок)
  for(let row=0; row<3; row++){
    for(let col=0; col<12; col++){
      const n = col*3 + (3-row);
      const cell = document.createElement('div');
      const c = rlColor(n);
      cell.className = `rl-cell ${c==='red'?'red-cell':'black-cell'}`;
      cell.textContent = n;
      cell.style.gridRow = row+1;
      cell.style.gridColumn = col+2;
      cell.onclick = () => rlBet('n'+n);
      cell.id = 'rl-n'+n;
      grid.appendChild(cell);
    }
  }

  // 2:1 колонки
  const colNames = ['col1','col2','col3'];
  const colSpans = ['2 / 6','6 / 10','10 / 14'];
  for(let col=0; col<3; col++){
    const cell = document.createElement('div');
    cell.className = 'rl-cell outside-gold';
    cell.textContent = '2:1';
    cell.style.gridRow = 4;
    cell.style.gridColumn = colSpans[col];
    cell.onclick = () => rlBet(colNames[col]);
    cell.id = `rl-${colNames[col]}`;
    grid.appendChild(cell);
  }
}

// ─── CHIP SELECT ────────────────────────────────────────────
function rlSelectChip(val){
  rl.selectedChip = val;
  document.querySelectorAll('.rl-chip').forEach(c=>{
    c.classList.toggle('selected', +c.dataset.val === val);
  });
}

// ─── BET ────────────────────────────────────────────────────
// Пары взаимоисключающих внешних ставок
const RL_CONFLICTS = { red:'black', black:'red', even:'odd', odd:'even', low:'high', high:'low' };

function rlBet(key){
  if(rl.spinning) return;
  const chip = rl.selectedChip;

  // Блокируем противоположную ставку
  const conflict = RL_CONFLICTS[key];
  if(conflict && rl.bets[conflict]){
    toast('Нельзя ставить одновременно на ' + key + ' и ' + conflict);
    return;
  }

  const total = Object.values(rl.bets).reduce((a,b)=>a+b,0);
  if(total + chip > S.coins){ toast('Мало ⭐'); return; }
  rl.bets[key] = (rl.bets[key]||0) + chip;
  rlUpdateTable();
  rlUpdateTotals();
}

function rlClearBets(){
  if(rl.spinning) return;
  rl.bets = {};
  rlUpdateTable();
  rlUpdateTotals();
}

function rlUpdateTable(){
  document.querySelectorAll('.rl-cell').forEach(cell=>{
    const chp = cell.querySelector('.rl-chip-on');
    if(chp) chp.remove();
    cell.classList.remove('has-bet');
  });
  for(const [key, amt] of Object.entries(rl.bets)){
    if(!amt) continue;
    const cell = document.getElementById('rl-'+key);
    if(!cell) continue;
    cell.classList.add('has-bet');
    const chp = document.createElement('div');
    chp.className = 'rl-chip-on';
    chp.textContent = amt >= 1000 ? Math.round(amt/1000)+'k' : amt;
    cell.appendChild(chp);
  }
}

function rlUpdateTotals(){
  const total = Object.values(rl.bets).reduce((a,b)=>a+b,0);
  const el = document.getElementById('rl-total-bet');
  if(el) el.textContent = total.toLocaleString();
  const bal = document.getElementById('rl-balance');
  if(bal) bal.textContent = S.coins.toLocaleString();
  const btn = document.getElementById('rl-spin-btn');
  if(btn) btn.disabled = total === 0 || rl.spinning;
}

// ─── SPIN — РЕАЛИСТИЧНАЯ АНИМАЦИЯ ШАРИКА (без телепортации) ─
function rlSpin(){
  if(rl.spinning) return;
  const totalBet = Object.values(rl.bets).reduce((a,b)=>a+b,0);
  if(totalBet === 0){ toast('Сделайте ставку'); return; }
  if(S.coins < totalBet){ toast('Мало ⭐'); return; }

  spend(totalBet);
  rl.spinning = true;
  rlUpdateTotals();

  const resultIdx = Math.floor(Math.random() * RL_WHEEL.length);
  const resultNum = RL_WHEEL[resultIdx];

  const resBox = document.getElementById('rl-result-box');
  const resNum = document.getElementById('rl-result-num');
  if(resBox){ resBox.textContent=''; resBox.className='rl-result-box'; }
  if(resNum){ resNum.textContent=''; resNum.className='rl-result-big'; }

  const canvas = document.getElementById('rl-canvas');
  const W = canvas ? canvas.width : 320;
  const R = W/2 - 4;

  const TRACK_R_OUTER = R - 14;  // внешний трек (быстрая фаза)
  const TRACK_R_INNER = R - 40;  // внутренний трек (финальная позиция)

  // Целевой угол сегмента на неподвижном колесе
  const segArc = (2*Math.PI) / RL_WHEEL.length;
  const targetSegAngle = rl.wheelAngle + resultIdx * segArc - Math.PI/2 + segArc/2;

  // Шарик стартует с текущей позиции и летит ПРОТИВ часовой стрелки
  // Нужно пройти N полных кругов, чтобы финально оказаться на targetSegAngle
  // Ключевой момент: финальный угол анимации должен ТОЧНО равняться targetSegAngle
  // без какого-либо скачка в конце.

  const startAngle = rl.ballAngle; // текущий угол шарика
  const fastLaps = 5 + Math.floor(Math.random()*3); // 5-7 полных оборотов

  // Шарик движется против часовой (угол убывает).
  // Расстояние от startAngle до targetSegAngle ПО НАПРАВЛЕНИЮ УБЫВАНИЯ:
  let angDiff = startAngle - targetSegAngle;
  // Нормализуем: должно быть [0, 2π)
  angDiff = ((angDiff % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  // Если diff == 0, добавим полный круг чтоб не было нулевого хода
  if(angDiff < 0.01) angDiff += 2*Math.PI;

  // Итоговое расстояние = N полных кругов + остаток до цели
  const totalDelta = fastLaps * 2*Math.PI + angDiff;
  // Финальный угол = startAngle - totalDelta (строго, без округления)
  const endAngle = startAngle - totalDelta;

  const DURATION = 5500 + Math.random()*1200;
  const startTime = performance.now();

  // Плавное замедление: быстрый разгон → длинное торможение
  // Используем кубическую bezier-подобную кривую
  function spinEase(t){
    // Фаза 1 (0..0.15): разгон
    if(t < 0.15){
      return (t / 0.15) * (t / 0.15) * 0.12;
    }
    // Фаза 2 (0.15..1): плавное торможение (quintic out)
    const t2 = (t - 0.15) / 0.85;
    return 0.12 + 0.88 * (1 - Math.pow(1 - t2, 5));
  }

  // Радиус: на внешнем треке, потом плавно падает в конце
  function getBallRadius(t){
    // Падение начинается на t=0.72, завершается на t=1.0
    if(t < 0.72) return TRACK_R_OUTER;
    const s = (t - 0.72) / 0.28;
    // ease-out для падения + небольшие "подскоки" в начале
    const easeS = 1 - Math.pow(1 - s, 2);
    const bounce = s < 0.6 ? Math.sin(s * Math.PI * 4) * (1 - s) * 5 : 0;
    return TRACK_R_OUTER + (TRACK_R_INNER - TRACK_R_OUTER) * easeS + bounce;
  }

  function animate(now){
    const elapsed = now - startTime;
    const t = Math.min(elapsed / DURATION, 1);
    const ease = spinEase(t);

    // Угол интерполируется от startAngle до endAngle через easing
    // При t=1: ease=1 → angle = endAngle = startAngle - totalDelta
    // endAngle ≡ targetSegAngle (mod 2π) по построению → нет телепортации
    rl.ballAngle = startAngle - totalDelta * ease;
    rl.ballRadius = getBallRadius(t);

    rlDrawFrame(rl.ballAngle, rl.ballRadius, true);

    if(t < 1){
      rl.animId = requestAnimationFrame(animate);
    } else {
      // Финал без скачка: angle = endAngle ≡ targetSegAngle
      rl.ballAngle = endAngle;
      rl.ballRadius = TRACK_R_INNER;
      rlDrawFrame(rl.ballAngle, rl.ballRadius, true);
      rl.spinning = false;
      setTimeout(()=>rlShowResult(resultNum), 350);
    }
  }

  rl.animId = requestAnimationFrame(animate);
}

// ─── SHOW RESULT ────────────────────────────────────────────
function rlShowResult(num){
  // История
  rl.history.unshift(num);
  if(rl.history.length > 16) rl.history.pop();
  rlRenderHistory();

  // Большое число
  const col = rlColor(num);
  const resNum = document.getElementById('rl-result-num');
  if(resNum){
    resNum.textContent = num;
    resNum.className = 'rl-result-big ' + col;
  }

  // Подсчёт выигрыша
  let totalWin = 0;
  const bets = rl.bets;
  for(const [key, stake] of Object.entries(bets)){
    if(!stake) continue;
    let mult = 0;
    if(key === 'n'+num){ mult = 36; }
    else if(key === 'red'   && col==='red')             { mult = 2; }
    else if(key === 'black' && col==='black')            { mult = 2; }
    else if(key === 'even'  && num!==0 && num%2===0)     { mult = 2; }
    else if(key === 'odd'   && num!==0 && num%2!==0)     { mult = 2; }
    else if(key === 'low'   && num>=1  && num<=18)       { mult = 2; }
    else if(key === 'high'  && num>=19 && num<=36)       { mult = 2; }
    else if(key === 'dozen1'&& num>=1  && num<=12)       { mult = 3; }
    else if(key === 'dozen2'&& num>=13 && num<=24)       { mult = 3; }
    else if(key === 'dozen3'&& num>=25 && num<=36)       { mult = 3; }
    else if(key === 'col1'  && num!==0 && num%3===1)     { mult = 3; }
    else if(key === 'col2'  && num!==0 && num%3===2)     { mult = 3; }
    else if(key === 'col3'  && num!==0 && num%3===0)     { mult = 3; }
    totalWin += stake * mult;
  }

  const resBox = document.getElementById('rl-result-box');
  if(totalWin > 0){
    addCoins(totalWin);
    const profit = totalWin - Object.values(bets).reduce((a,b)=>a+b,0);
    if(resBox){
      resBox.textContent = `Выигрыш ${totalWin} ⭐  (${profit>=0?'+':''}${profit} ⭐)`;
      resBox.className = 'rl-result-box win';
    }
  } else {
    if(resBox){
      resBox.textContent = `Мимо — выпало ${num}`;
      resBox.className = 'rl-result-box lose';
    }
  }

  rl.bets = {};
  rlUpdateTable();
  rlUpdateTotals();
  save();
}

// ─── RENDER HISTORY ─────────────────────────────────────────
function rlRenderHistory(){
  const el = document.getElementById('rl-history');
  if(!el) return;
  el.innerHTML = '';
  rl.history.forEach(n=>{
    const d = document.createElement('div');
    d.className = 'rl-hist-num ' + rlColor(n);
    d.textContent = n;
    el.appendChild(d);
  });
}

// ─── INIT ───────────────────────────────────────────────────
function rlInit(){
  rlBuildTable();
  rlSelectChip(25);
  const canvas = document.getElementById('rl-canvas');
  if(canvas){
    const W = canvas.width;
    const R = W/2 - 4;
    // Начальная позиция шарика — верхняя точка внешнего трека
    if(!rl.ballAngle) rl.ballAngle = -Math.PI/2 + Math.random()*2*Math.PI;
    rl.ballRadius = R - 14;
    rlDrawFrame(rl.ballAngle, rl.ballRadius, false);
  }
  rlUpdateTotals();
}

load();
renderHome();
renderShop();
rlInit();
