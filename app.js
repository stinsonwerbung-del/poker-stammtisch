// ===== Dialog-Fallbacks
function dlgOpen(d){ try{ if(d && d.showModal) d.showModal(); else d.style.display='block'; }catch{ d.style.display='block'; } }
function dlgClose(d){ try{ if(d && d.close) d.close(); else d.style.display='none'; }catch{ d.style.display='none'; } }

// ===== Konstanten & Utils
const DEC=2; const STORAGE_KEY='pst_v9';
const DEFAULT_AVATAR = (()=>{ const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256' viewBox='0 0 256 256'>
  <rect width='256' height='256' fill='#0f1221'/><g transform='translate(128,128)'>
  <circle r='86' fill='#e43d30'/><circle r='68' fill='#ffffff'/><circle r='54' fill='#e43d30'/><circle r='24' fill='#ffffff'/></g></svg>`;
  return 'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));
})();
const fmtPct = v=> (v??0).toFixed(DEC).replace('.',',');
const fmtDate = iso=>{ if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${d}.${m}.${y}`; };
const clamp = (n,min,max)=> Math.max(min, Math.min(max,n));
const uid = p=> `${p}_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
async function sha256Hex(str){
  if(window.crypto?.subtle){ const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
  let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; } return ('00000000'+(h>>>0).toString(16)).slice(-8);
}
function dayIdx(iso){ return new Date(iso+"T00:00:00").getDay(); } // 0 So .. 6 Sa
function isActiveDay(iso){ const d=dayIdx(iso); return !(state.streakWeekPause?.[d]); } // true = zählt regulär

// ===== State & Model
let state = load();
let currentProfileId=null;
let curTournamentId=null;

// ===== Streak-Index & Cache (Performance)
let streakCache = { byPid:new Map(), valid:false, key:'' };
let dateMap = null; // Map<isoDate, { any:boolean, players:Set<pid> }>

function load(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw) return {version:9, profiles:[], tournaments:[], streakWeekPause:{0:true,6:true}}; // Standard: So+Sa pausiert
    return migrate(normalize(JSON.parse(raw)));
  }catch{ return {version:9, profiles:[], tournaments:[], streakWeekPause:{0:true,6:true}}; }
}

function normalize(obj){
  // Unterstützt alte Objekt-Strukturen; kein Auto-Seed fixer Spieler
  if (!obj || typeof obj!=='object' || Array.isArray(obj)){
    return {version:9, streakWeekPause:{0:true,6:true}, profiles:[], tournaments:[]};
  }
  return {
    version: obj.version||9,
    streakWeekPause: obj.streakWeekPause || {0:true,6:true},
    profiles: Array.isArray(obj.profiles)? obj.profiles: [],
    tournaments: Array.isArray(obj.tournaments)? obj.tournaments: []
  };
}
function migrate(d){
  if(!d.version || d.version<9){
    // v8->v9: streakPaused -> streakWeekPause (Default So+Sa pausiert)
    d.streakWeekPause = d.streakWeekPause || (d.streakPaused ? {0:true,6:true} : {0:true,6:true});
  }
  d.version=9;
  d.profiles.forEach(p=>{ p.id=p.id||uid('p'); if(!p.avatarDataUrl) p.avatarDataUrl=DEFAULT_AVATAR; });
  d.tournaments.forEach(t=>{
    t.id=t.id||uid('t');
    t.rounds=(t.rounds||[]).map(r=> ({...r, id:r.id||uid('r'), comments:r.comments||[], streakPause:Array.isArray(r.streakPause)? r.streakPause: []}));
    if(!Array.isArray(t.admins)) t.admins=[];
    if(!t.startChips) t.startChips=640;
    if(!t.playerCount) t.playerCount=(t.players?.length)||4;
  });
  return d;
}

// ===== Streaks – performanter Rebuild & O(1)-Lookup
function stateKeyForStreaks(){
  const rounds = state.tournaments
    .flatMap(t => (t.rounds||[]).map(r => ({ d:r.date, c:r.chips, sp:r.streakPause })))
    .sort((a,b)=> (a.d||'').localeCompare(b.d||''));
  return JSON.stringify({week:state.streakWeekPause||{}, rounds});
}
function buildDateMap(){
  const map = new Map();
  state.tournaments.forEach(t => {
    (t.rounds||[]).forEach(r => {
      const iso = r.date;
      if(!iso) return;
      let entry = map.get(iso);
      if(!entry){ entry = { any:false, players:new Set() }; map.set(iso, entry); }
      entry.any = true;
      (t.players||[]).forEach(pid => {
        const pausedForPid = Array.isArray(r.streakPause) && r.streakPause.includes(pid);
        const val = +r.chips?.[pid] || 0;
        if(val > 0 && !pausedForPid) entry.players.add(pid); // zählt nur, wenn gespielt + nicht pausiert
      });
    });
  });
  return map;
}
function rebuildStreaks(){
  const key = stateKeyForStreaks();
  if(streakCache.valid && streakCache.key === key) return;

  dateMap = buildDateMap();

  const allDates = [...dateMap.keys()].sort();
  const startIso = allDates[0] || new Date().toISOString().slice(0,10);
  const todayIso = new Date().toISOString().slice(0,10);

  const allPids = state.profiles.map(p => p.id);
  const cur = new Map(); const best = new Map();
  allPids.forEach(pid => { cur.set(pid,0); best.set(pid,0); });

  for(let d=startIso;;){
    const activeDay = isActiveDay(d); // globaler Pausetag?
    const entry = dateMap.get(d);
    const any = !!entry?.any;

    if(activeDay){
      allPids.forEach(pid => {
        const me = !!entry?.players?.has(pid); // hat gespielt & nicht individuell pausiert
        if(any){
          if(me){
            const nv = (cur.get(pid)||0)+1;
            cur.set(pid,nv);
            if(nv > (best.get(pid)||0)) best.set(pid,nv);
          }else{
            cur.set(pid,0);
          }
        } else {
          // aktiver Tag ohne Spiel -> Streak bricht
          cur.set(pid,0);
        }
      });
    } // else: pausierter Tag -> keine Änderung

    if(d===todayIso) break;
    d = new Date(new Date(d+"T00:00:00").getTime()+86400000).toISOString().slice(0,10);
  }

  streakCache = {
    byPid: new Map(allPids.map(pid => [pid, { current: cur.get(pid)||0, best: best.get(pid)||0 }])),
    valid: true,
    key
  };
}
function computeStreaks(pid){
  if(!pid) return {current:0, best:0};
  rebuildStreaks();
  return streakCache.byPid.get(pid) || {current:0, best:0};
}

// ===== DOM refs & view switch
const authSec=document.getElementById('view_auth');
const homeSec=document.getElementById('view_home');
const tourSec=document.getElementById('view_tournament');
const profSec=document.getElementById('view_profile');

function show(view){
  authSec.classList.toggle('hidden', view!=='auth');
  homeSec.classList.toggle('hidden', view!=='home');
  tourSec.classList.toggle('hidden', view!=='tournament');
  profSec.classList.toggle('hidden', view!=='profile');

  document.body.dataset.loading = '1';
  requestAnimationFrame(()=>{ render(view); document.body.dataset.loading = '0'; });
}

// ===== Render helpers
function getProfile(pid){ return state.profiles.find(p=> p.id===pid); }
function avatarImg(profile, size='avatar', withBadge=true, overrideBadgeValue=null){
  const cls = size==='mini' ? 'avatar mini' : size==='mid' ? 'avatar mid' : size==='big' ? 'avatar big' : 'avatar';
  const src = profile?.avatarDataUrl || DEFAULT_AVATAR;
  const name = profile?.name || '';
  let badge = '';
  if(withBadge && profile?.id){
    const st = (overrideBadgeValue!=null) ? overrideBadgeValue : computeStreaks(profile.id).current;
    if(st >= 1){ badge = `<span class="streakBadge">🔥 <b>${st}</b></span>`; }
  }
  return `<span class="avatarWrap"><img class="${cls}" src="${src}" alt="${name}">${badge}</span>`;
}
function rankCompetition(items){ const s=[...items].sort((a,b)=> b.value-a.value); let rank=0,seen=0,prev=Infinity; const map={}; for(const it of s){ seen++; if(it.value!==prev){ rank=seen; prev=it.value;} map[it.name]=rank; } return map; }
function computeTournamentStats(t){
  const totals={}, counts={}, pctHist={}; (t.players||[]).forEach(pid=>{ totals[pid]=0; counts[pid]=0; pctHist[pid]=[]; });
  const asc=[...t.rounds].sort((a,b)=> (a.date||'').localeCompare(b.date||''));
  asc.forEach(r=>{ const sum=(t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0);
    (t.players||[]).forEach(pid=>{ totals[pid]+= (+r.chips?.[pid]||0); counts[pid]+=1; pctHist[pid].push(sum? ((+r.chips?.[pid]||0)/sum*100):0); });
  });
  const avgPct={}, avgChips={}; (t.players||[]).forEach(pid=>{ avgChips[pid]= counts[pid]? totals[pid]/counts[pid]:0; avgPct[pid]= (t.playerCount*t.startChips)? (avgChips[pid]/(t.playerCount*t.startChips)*100):0; });
  const overallRank = rankCompetition((t.players||[]).map(pid=> ({name:pid, value:avgPct[pid]})));
  return { players: (t.players||[]).map(pid=> ({ id:pid, name:getProfile(pid)?.name||'?', avgPct:avgPct[pid], avgChips:avgChips[pid], rank:overallRank[pid] })) };
}

// ===== Global/Tournament info
function computeTournamentInfo(t){
  if(!t || !Array.isArray(t.rounds) || t.rounds.length===0){
    return { last:null, hasIncomplete:false, hasOvershoot:false, total:(t?t.playerCount*t.startChips:2560) };
  }
  const sorted=[...t.rounds].sort((a,b)=> (b.date||'').localeCompare(a.date||'')); const last=sorted[0];
  const sum=(t.players||[]).reduce((a,p)=> a+(+last.chips?.[p]||0),0);
  const total=t.playerCount*t.startChips;
  const hasIncomplete = t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0) < total);
  const hasOvershoot =  t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0) > total);
  return { last:{sum,total}, hasIncomplete, hasOvershoot, total };
}

// ===== View switch render
function render(activeView){
  // Statuszeile nur im Turnier
  if(activeView==='tournament' && curTournamentId){
    const t=state.tournaments.find(x=> x.id===curTournamentId);
    const info=computeTournamentInfo(t);
    const ss=document.getElementById('sumState');
    if(info.last){
      const {sum,total}=info.last; const isC=sum===total;
      ss.textContent = isC? `Letzte Runde: ${sum} / ${total}` : `Letzte Runde: ${sum} / ${total} · ${sum<total? 'unvollständige Zählung (gezählt)':'überschüssige Zählung (gezählt)'}`;
      ss.className='pill '+(isC?'good': (sum<total?'warn':'bad'));
    } else { ss.textContent='Letzte Runde: —'; ss.className='pill'; }
    document.getElementById('flagIncomplete').style.display = info.hasIncomplete? '': 'none';
    document.getElementById('flagOvershoot').style.display  = info.hasOvershoot?  '': 'none';
  }

  if(!homeSec.classList.contains('hidden')){
    const who=state.profiles.find(p=> p.id===currentProfileId);
    document.getElementById('whoPill').innerHTML = who? `Eingeloggt als: <b>${who.name}</b>` : 'Eingeloggt als: —';
    const my=document.getElementById('myTournamentList'); const other=document.getElementById('otherTournamentList'); my.innerHTML=''; other.innerHTML='';
    const list=[...state.tournaments].sort((a,b)=> (b.startDate||'').localeCompare(a.startDate||''));
    list.forEach(t=>{
      const players=t.players||[]; const inTour=players.includes(currentProfileId);
      const wrap=document.createElement('div'); wrap.className='sub';
      const names=players.map(pid=> state.profiles.find(p=> p.id===pid)?.name||'?').join(', ');
      const total=t.playerCount*t.startChips;
      wrap.innerHTML = `<a href="#" data-open="${t.id}"><b>${t.name}</b></a> · Start: ${fmtDate(t.startDate)} · Spieler: ${names} · Soll: ${total}`;
      wrap.querySelector('a').addEventListener('click', e=>{ e.preventDefault(); openTournament(t.id); });
      (inTour? my: other).appendChild(wrap);
    });
  }

  if(!tourSec.classList.contains('hidden') && curTournamentId){
    renderTournament(curTournamentId);
  }
}

// ===== Open views
function openTournament(id){ curTournamentId=id; show('tournament'); }
function openProfileView(pid){
  const p=getProfile(pid); if(!p) return alert('Profil fehlt');
  show('profile');
  document.getElementById('profTitle').innerHTML = `${avatarImg(p,'mid',true)} ${p.name}`;
  const sel=document.getElementById('profScopeSel');
  sel.innerHTML = '<option value="all">Gesamt (alle Turniere)</option>' + state.tournaments.map(t=> `<option value="${t.id}">${t.name}</option>`).join('');
  document.getElementById('profBack').onclick=()=> show('tournament');
  document.getElementById('profPrint').onclick=()=> window.print();

  const renderProf=()=>{
    const scope=sel.value;
    const rounds = state.tournaments.flatMap(t=> (scope==='all'||scope===t.id)? t.rounds.map(r=> ({t,r})) : [] ).filter(x=> (x.t.players||[]).includes(pid));
    const sorted=[...rounds].sort((a,b)=> (b.r.date||'').localeCompare(a.r.date||''));
    const rows=sorted.map(({t,r})=>{
      const sum=(t.players||[]).reduce((a,pp)=> a+(+r.chips?.[pp]||0),0);
      const pct=sum? ((+r.chips?.[pid]||0)/sum*100):0;
      const ranks=rankCompetition((t.players||[]).map(pp=> ({name:pp, value:+(r.chips?.[pp]||0)})));
      return {date:r.date, tour:t.name, chips:+r.chips?.[pid]||0, pct, rank:ranks[pid]||4, status: sum===(t.playerCount*t.startChips)?'OK': (sum<(t.playerCount*t.startChips)?'Unvollständig':'Überschüssig')};
    });
    const n=rows.length; const avgChips=n? rows.reduce((a,b)=> a+b.chips,0)/n:0; const avgPct=n? rows.reduce((a,b)=> a+b.pct,0)/n:0;
    const dist=[1,2,3,4].map(k=> rows.filter(x=> x.rank===k).length); const ser=[...rows].reverse().map(x=> x.pct);
    const {current:stCur, best:stBest} = computeStreaks(pid);
    document.getElementById('profSub').textContent =
      `Runden: ${n} · Ø Chips: ${Math.round(avgChips)} · Ø %Stack: ${fmtPct(avgPct)}% · Verteilung: 🥇 ${dist[0]} · 🥈 ${dist[1]} · 🥉 ${dist[2]} · 🗑️ ${dist[3]} · Streak: 🔥 ${stCur} (Best: ${stBest})`;
    const pv=document.getElementById('pv_spark'); pv.innerHTML = ser.map(pv=> `<span title='${fmtPct(pv)}%' style='flex:1;background:linear-gradient(180deg,#6ee7ff,#8b5cff);align-self:flex-end;height:${Math.max(4,Math.min(100,Math.round(pv)))}%'></span>`).join('');
    const tbody=document.getElementById('profRows'); tbody.innerHTML = rows.map(r=> `<tr><td>${fmtDate(r.date)}</td><td>${r.tour}</td><td>#${r.rank}</td><td>${r.chips}</td><td>${fmtPct(r.pct)}%</td><td>${r.status}</td></tr>`).join('');
  };
  sel.onchange=renderProf; renderProf();
}

// ===== AUTH
document.getElementById('btnLoginProfile').addEventListener('click', showLoginList);
document.getElementById('linkRegister').addEventListener('click', (e)=>{ e.preventDefault(); openProfileEdit(null); });

function showLoginList(){
  const grid=document.getElementById('authList'); grid.innerHTML='';
  state.profiles.forEach(p=>{
    const card=document.createElement('div'); card.className='card';
    card.innerHTML=`<div style="display:flex;align-items:center;gap:10px">
      ${avatarImg(p,'mid',true)}
      <div><b>${p.name}</b><div class="sub">${p.pwHash? 'Passwortgeschützt':'kein Passwort'}</div></div>
      <div style="margin-left:auto"><button class='btn small' data-login='${p.id}'>Einloggen</button></div></div>`;
    grid.appendChild(card);
  });
  grid.style.display='grid';
  grid.querySelectorAll('[data-login]').forEach(b=> b.addEventListener('click', async ()=>{
    const pid=b.getAttribute('data-login'); const prof=getProfile(pid);
    if(prof.pwHash){ const pw=prompt('Passwort für '+prof.name+':'); if(!pw) return; const h=await sha256Hex(pw); if(h!==prof.pwHash) return alert('Falsches Passwort'); }
    currentProfileId=pid; show('home');
  }));
}
document.getElementById('btnEditSelf').addEventListener('click', ()=> openProfileEdit(currentProfileId));
document.getElementById('btnLogout').addEventListener('click', ()=>{ currentProfileId=null; curTournamentId=null; show('auth'); });

// ===== Profile edit/create
const dlgProf=document.getElementById('dlgProfileEdit');
function openProfileEdit(pid){
  const p = pid? getProfile(pid) : {name:'', pwHash:null, avatarDataUrl:DEFAULT_AVATAR};
  const isEdit=!!pid;
  document.getElementById('dlgProfileTitle').textContent = isEdit? 'Profil bearbeiten':'Profil anlegen';
  document.getElementById('profName').value = p.name||'';
  document.getElementById('lblProfPwCurrent').style.display = (isEdit && p.pwHash)? '' : 'none';
  document.getElementById('profPwCurrent').value=''; document.getElementById('profPwNew1').value=''; document.getElementById('profPwNew2').value='';
  const prev=document.getElementById('profAvatarPreview'); prev.innerHTML = `<span class="avatarWrap"><img class="avatar big" src="${p.avatarDataUrl||DEFAULT_AVATAR}"></span>`; prev.dataset.url='';
  const file=document.getElementById('profAvatar'); file.value='';
  file.onchange=()=>{ const f=file.files[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ const img=new Image(); img.onload=()=>{ const c=document.createElement('canvas'); const s=256; c.width=s; c.height=s; const ctx=c.getContext('2d'); const min=Math.min(img.width,img.height); const sx=(img.width-min)/2; const sy=(img.height-min)/2; ctx.drawImage(img,sx,sy,min,min,0,0,s,s); const url=c.toDataURL('image/webp',0.8); prev.innerHTML=`<span class="avatarWrap"><img class="avatar big" src="${url}"></span>`; prev.dataset.url=url; }; img.src=r.result; }; r.readAsDataURL(f); };
  dlgOpen(dlgProf);
  document.getElementById('profCancel').onclick=()=> dlgClose(dlgProf);
  document.getElementById('profSave').onclick=async()=>{
    const name=document.getElementById('profName').value.trim(); if(!name) return alert('Name fehlt');
    const cur=document.getElementById('profPwCurrent').value;
    const n1=document.getElementById('profPwNew1').value; const n2=document.getElementById('profPwNew2').value;
    let newHash=p.pwHash||null;
    if(isEdit){
      if(n1||n2){
        if(n1!==n2) return alert('Neue Passwörter stimmen nicht überein');
        if(p.pwHash){ if(!cur) return alert('Aktuelles Passwort fehlt'); const h=await sha256Hex(cur); if(h!==p.pwHash) return alert('Aktuelles Passwort falsch'); }
        if(n1 && n1.length<4) return alert('Neues Passwort zu kurz (≥4)');
        newHash=n1? await sha256Hex(n1): null;
      }
      p.name=name; p.pwHash=newHash; p.avatarDataUrl= prev.dataset.url || p.avatarDataUrl || DEFAULT_AVATAR;
    } else {
      if(n1||n2){ if(n1!==n2) return alert('Neue Passwörter stimmen nicht überein'); if(n1.length<4) return alert('Neues Passwort zu kurz (≥4)'); newHash=await sha256Hex(n1); }
      const np={id:uid('p'), name, pwHash:newHash, avatarDataUrl: prev.dataset.url || DEFAULT_AVATAR};
      state.profiles.push(np); currentProfileId=np.id;
    }
    save(); dlgClose(dlgProf); show('home'); alert('Profil gespeichert.');
  };
}

// ===== Tournament flow
document.getElementById('btnBackHome').addEventListener('click', ()=> show('home'));
document.getElementById('btnNewTournament').addEventListener('click', ()=> openTournamentDialog());
function isTournamentAdmin(t){ return !!(t.admins||[]).includes(currentProfileId); }

function openTournamentDialog(){
  if(!currentProfileId){ alert('Bitte zuerst einloggen.'); return; }
  const dlg=document.getElementById('dlgTournament');
  const list=document.getElementById('tourPlayers'); list.innerHTML='';
  state.profiles.forEach(p=>{ const wrap=document.createElement('label'); wrap.style.display='flex'; wrap.style.gap='8px'; wrap.style.alignItems='center'; wrap.innerHTML=`<input type="checkbox" value="${p.id}" ${p.id===currentProfileId?'checked':''}> ${p.name}`; list.appendChild(wrap); });
  document.getElementById('tourName').value='';
  document.getElementById('tourDate').value=new Date().toISOString().slice(0,10);
  document.getElementById('tourStartChips').value=640; document.getElementById('tourPlayerCount').value=4;
  dlgOpen(dlg);
  document.getElementById('tourCancel').onclick=()=> dlgClose(dlg);
  document.getElementById('tourCreate').onclick=()=>{
    const name=document.getElementById('tourName').value.trim(); if(!name) return alert('Name fehlt');
    const date=document.getElementById('tourDate').value||new Date().toISOString().slice(0,10);
    const startChips= Math.max(1, +document.getElementById('tourStartChips').value||640);
    const playerCount= Math.max(2, +document.getElementById('tourPlayerCount').value||4);
    const players=[...list.querySelectorAll('input:checked')].map(i=> i.value);
    if(players.length<2) return alert('Mind. 2 Spieler');
    const t={ id:uid('t'), name, startDate:date, players, startChips, playerCount, admins:[currentProfileId], rounds:[] };
    state.tournaments.push(t); save(); dlgClose(dlg); openTournament(t.id);
  };
}

function renderTournament(tid){
  const t=state.tournaments.find(x=> x.id===tid); if(!t) return;
  document.getElementById('dashTitle').textContent = t.name;
  document.getElementById('dashSub').textContent = `Start: ${fmtDate(t.startDate)} · Spieler: ${(t.players||[]).map(pid=> getProfile(pid)?.name||'?').join(', ')} · Soll: ${t.playerCount*t.startChips}`;
  document.getElementById('addRoundBtn').style.display = isTournamentAdmin(t)? '': 'none';

  // Leaderboard
  const stats = computeTournamentStats(t);
  const leader=document.getElementById('leaderGrid'); leader.innerHTML='';
  stats.players.sort((a,b)=> a.rank-b.rank).forEach(c=>{
    const medal = c.rank===1? '🥇': c.rank===2? '🥈': c.rank===3? '🥉': '';
    const prof = getProfile(c.id);
    const stVals = computeStreaks(c.id);
    const card=document.createElement('div'); card.className='card';
    card.innerHTML = `<h3 title="Beste Serie: ${stVals.best}">${medal? medal+' ':''}${avatarImg(prof,'mini',true,stVals.current)} ${c.name}</h3>
      <div class="sub">Ø Chips: <b>${Math.round(c.avgChips)}</b> · Ø %Stack: <b>${fmtPct(c.avgPct)}</b>%</div>
      <div class="rankRow"><div>Platz <b>${c.rank}</b></div><div class="sub">Best 🔥 ${stVals.best}</div></div>
      <div class="bar"><span style="width:${clamp(c.avgPct,0,100)}%"></span></div>`;
    card.style.cursor='pointer'; card.addEventListener('click', ()=> openProfileView(c.id));
    leader.appendChild(card);
  });

  // Runden (mehrzeilig)
  const tbody=document.getElementById('roundsBody'); tbody.innerHTML='';
  const rounds=[...t.rounds].sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  const targetTotal = t.playerCount*t.startChips;

  rounds.forEach(r=>{
    const sum=(t.players||[]).reduce((acc,pid)=> acc+(+r.chips?.[pid]||0),0);
    const isC=sum===targetTotal; const isUnder=sum<targetTotal;
    const rowClass = isC? 'row': (isUnder? 'row incomplete':'row overshoot');
    const ranks = rankCompetition((t.players||[]).map(pid=> ({name:pid, value:+(r.chips?.[pid]||0)})));
    const order=(t.players||[]).slice().sort((a,b)=> ranks[a]-ranks[b]);

    const inner=document.createElement('table'); inner.style.width='100%';
    let html = '';
    const first = order[0];
    const pctFirst = sum? ((+r.chips?.[first]||0)/sum*100):0;
    const firstPaused = Array.isArray(r.streakPause) && r.streakPause.includes(first);
    html += `
      <tr>
        <td style="min-width:120px;padding:0 8px 8px 8px" rowspan="${order.length}"><b>${fmtDate(r.date)}</b></td>
        <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[first]}</td>
        <td style="padding:0 8px 4px 8px">${getProfile(first)?.name||'?'}${firstPaused?' <span class="sub">(Streak pausiert)</span>':''}</td>
        <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${r.chips?.[first]||0}</b> · ${fmtPct(pctFirst)}%</span></td>
      </tr>`;
    for(let i=1;i<order.length;i++){
      const pid=order[i];
      const pct = sum? ((+r.chips?.[pid]||0)/sum*100):0;
      const paused = Array.isArray(r.streakPause) && r.streakPause.includes(pid);
      html += `
        <tr>
          <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[pid]}</td>
          <td style="padding:0 8px 4px 8px">${getProfile(pid)?.name||'?'}${paused?' <span class="sub">(Streak pausiert)</span>':''}</td>
          <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${r.chips?.[pid]||0}</b> · ${fmtPct(pct)}%</span></td>
        </tr>`;
    }
    html += `
      <tr>
        <td colspan="4" style="padding:6px 8px 10px">
          <div class="footerFlex">
            <div class="${isC?'ok': (isUnder?'':'bad')}">Rundensumme: <b>${sum}</b> / ${targetTotal} · ${isC? '✓ OK': (isUnder? '✗ Unvollständig':'✗ Überschüssig')}</div>
            <div class="sub" style="flex:1">Kommentar: ${(r.comments&&r.comments.length)? r.comments.map(c=> `• ${c.text}`).join(' \u00A0 ') : '—'}</div>
            <div>
              ${(!isC && isTournamentAdmin(t)) ? `<button class="btn small ghost" data-edit-id="${r.id}">Bearbeiten</button>`:''}
              ${isTournamentAdmin(t)? `<button class="btn small ghost" data-cmt-id="${r.id}">Kommentar</button>`:''}
              ${isTournamentAdmin(t)? `<button class="btn small danger" data-del-id="${r.id}">Löschen</button>`:''}
            </div>
          </div>
        </td>
      </tr>`;
    inner.innerHTML = html;
    const tr=document.createElement('tr'); tr.className=rowClass; const td=document.createElement('td'); td.colSpan=4; td.appendChild(inner); tr.appendChild(td); tbody.appendChild(tr);
  });

  document.querySelectorAll('[data-edit-id]').forEach(b=> b.addEventListener('click', ()=> openRoundEdit(t.id, b.getAttribute('data-edit-id'))));
  document.querySelectorAll('[data-del-id]').forEach(b=> b.addEventListener('click', ()=> deleteRound(t.id, b.getAttribute('data-del-id'))));
  document.querySelectorAll('[data-cmt-id]').forEach(b=> b.addEventListener('click', ()=> openComment(t.id, b.getAttribute('data-cmt-id'))));
}

// Runden CRUD + Rest auffüllen + pro-Spieler Streak-Pause
document.getElementById('addRoundBtn').addEventListener('click', ()=> openRoundEdit(curTournamentId, null));
function openRoundEdit(tid, rid){
  const t=state.tournaments.find(x=> x.id===tid); if(!t) return alert('Turnier fehlt');
  if(!(t.admins||[]).includes(currentProfileId)) return alert('Nur Turnier-Admin');
  const dlg=document.getElementById('dlgRound'); const form=document.getElementById('roundForm'); form.innerHTML='';
  const r = rid? t.rounds.find(x=> x.id===rid) : {date:new Date().toISOString().slice(0,10), chips:{}, streakPause:[]};
  const date=`<label>Datum<input type="date" id="r_date" value="${r.date}"></label>`;
  const grid=document.createElement('div'); grid.className='grid2';

  (t.players||[]).forEach(pid=>{
    const name=getProfile(pid)?.name||'?';
    const val=+r.chips?.[pid]||0;
    const paused = Array.isArray(r.streakPause) && r.streakPause.includes(pid);
    const row=document.createElement('div');
    row.innerHTML=`
      <label>${name} (Chips)
        <input type="number" min="0" step="1" data-chip="${pid}" value="${val}">
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input type="checkbox" data-spause="${pid}" ${paused?'checked':''}>
        <span>Streak heute pausieren</span>
      </label>`;
    grid.appendChild(row);
  });

  form.insertAdjacentHTML('beforeend', date);
  form.appendChild(grid);

  const sumHint=document.getElementById('sumHint');
  function computeSum(){
    return (t.players||[]).reduce((a,pid)=> a+(+form.querySelector(`[data-chip="${pid}"]`).value||0),0);
  }
  function upd(){
    const sum=computeSum();
    const target=t.playerCount*t.startChips; const diff=target-sum;
    sumHint.textContent = diff===0? `✓ Alles gut — Summe: ${sum} / ${target}` : (diff>0? `Es fehlen noch ${diff} Chips — Summe: ${sum} / ${target}` : `${-diff} Chips zu viel — Summe: ${sum} / ${target}`);
    sumHint.style.color = diff===0? 'var(--good)': (diff>0? '#ffd79c':'#ffb2b2');
  }
  form.querySelectorAll('input[type="number"]').forEach(i=> i.addEventListener('input', upd));
  upd();

  // Rest auffüllen
  document.getElementById('btnFillRest').onclick=()=>{
    const target=t.playerCount*t.startChips;
    let sum=computeSum();
    let rest = target - sum;
    if(rest<=0) return;
    const fields = (t.players||[]).map(pid=> form.querySelector(`[data-chip="${pid}"]`));
    const n = fields.length;
    const base = Math.floor(rest / n);
    const extra = rest % n;
    fields.forEach((inp, idx)=>{ inp.value = (+inp.value||0) + base + (idx<extra?1:0); });
    upd();
  };

  dlgOpen(dlg);
  document.getElementById('roundCancel').onclick=()=> dlgClose(dlg);
  document.getElementById('roundSave').onclick=()=>{
    const date=(document.getElementById('r_date').value)||new Date().toISOString().slice(0,10);
    const chips={}; (t.players||[]).forEach(pid=> chips[pid]= +(form.querySelector(`[data-chip="${pid}"]`).value||0));
    const streakPause=(t.players||[]).filter(pid=> form.querySelector(`[data-spause="${pid}"]`)?.checked);
    const sum=Object.values(chips).reduce((a,b)=> a+b,0);
    const obj={ id: rid||uid('r'), date, chips, complete:(sum===t.playerCount*t.startChips), comments:r.comments||[], streakPause };
    if(rid){ const i=t.rounds.findIndex(x=> x.id===rid); if(i>=0) t.rounds[i]=obj; } else t.rounds.push(obj);
    save(); dlgClose(dlg); render('tournament');
  };
}
function deleteRound(tid, rid){ const t=state.tournaments.find(x=> x.id===tid); if(!t) return; if(!(t.admins||[]).includes(currentProfileId)) return alert('Nur Turnier-Admin'); if(confirm('Runde wirklich löschen?')){ t.rounds=t.rounds.filter(r=> r.id!==rid); save(); render('tournament'); } }
function openComment(tid, rid){ const t=state.tournaments.find(x=> x.id===tid); if(!t) return; if(!(t.admins||[]).includes(currentProfileId)) return alert('Nur Turnier-Admin'); const dlg=document.getElementById('dlgComment'); const r=t.rounds.find(x=> x.id===rid); document.getElementById('commentText').value=(r.comments?.[0]?.text)||''; dlgOpen(dlg); document.getElementById('commentCancel').onclick=()=> dlgClose(dlg); document.getElementById('commentSave').onclick=()=>{ const txt=(document.getElementById('commentText').value||'').trim(); r.comments = txt? [{by:currentProfileId, at:new Date().toISOString(), text:txt}]: []; save(); dlgClose(dlg); render('tournament'); } }

// Turnier-Einstellungen
document.getElementById('btnTourSettings').addEventListener('click', ()=>{
  const t=state.tournaments.find(x=> x.id===curTournamentId); if(!t) return; if(!(t.admins||[]).includes(currentProfileId)) return alert('Nur Turnier-Admin');
  const dlg=document.getElementById('dlgTourSettings');
  document.getElementById('setStartChips').value=t.startChips; document.getElementById('setPlayerCount').value=t.playerCount;
  const wrap=document.getElementById('setAdmins'); wrap.innerHTML='';
  state.profiles.forEach(p=>{ const lab=document.createElement('label'); lab.style.display='flex'; lab.style.gap='8px'; lab.style.alignItems='center'; const checked=(t.admins||[]).includes(p.id); lab.innerHTML=`<input type='checkbox' value='${p.id}' ${checked?'checked':''}> ${p.name}`; wrap.appendChild(lab); });
  dlgOpen(dlg);
  document.getElementById('setCancel').onclick=()=> dlgClose(dlg);
  document.getElementById('setSave').onclick=()=>{ t.startChips=Math.max(1,+document.getElementById('setStartChips').value||t.startChips); t.playerCount=Math.max(2,+document.getElementById('setPlayerCount').value||t.playerCount); t.admins=[...wrap.querySelectorAll('input:checked')].map(i=> i.value); save(); dlgClose(dlg); render('tournament'); };
});

// Globale Streak-Einstellungen (Woche)
document.getElementById('btnStreakSettings').addEventListener('click', ()=>{
  const dlg=document.getElementById('dlgStreakSettings');
  const grid=document.getElementById('weekPauseGrid'); grid.innerHTML='';
  const names=['So','Mo','Di','Mi','Do','Fr','Sa']; // 0..6
  for(let i=0;i<7;i++){
    const lab=document.createElement('label'); lab.style.display='flex'; lab.style.alignItems='center'; lab.style.gap='8px';
    const checked = !!state.streakWeekPause?.[i];
    lab.innerHTML = `<input type="checkbox" data-wday="${i}" ${checked?'checked':''}> <b>${names[i]}</b> <span class="sub">(pausiert)</span>`;
    grid.appendChild(lab);
  }
  dlgOpen(dlg);
  document.getElementById('streakCancel').onclick=()=> dlgClose(dlg);
  document.getElementById('streakSave').onclick=()=>{
    const obj={};
    document.querySelectorAll('[data-wday]').forEach(inp=>{
      const i=+inp.getAttribute('data-wday'); obj[i]=inp.checked;
    });
    state.streakWeekPause = obj;
    save();
    dlgClose(dlg);
    render(!tourSec.classList.contains('hidden')?'tournament':(!authSec.classList.contains('hidden')?'auth':'home'));
  };
});

// ====== File-System-Integration: Persistenter Handle, Auto-Save, Locks ======
const DB_NAME = 'pst_handles'; const STORE = 'handles';
let currentHandle=null;
let currentFileMeta = null;      // { lastModified:number, size:number }
let autosaveTimer = null;
let writeLockActive = false;
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('pst_channel') : null;
const THIS_TAB_ID = 'tab_' + Math.random().toString(36).slice(2);

// IndexedDB Mini-Wrapper
function idbOpen(){ return new Promise((res,rej)=>{ const r=indexedDB.open(DB_NAME,1); r.onupgradeneeded=()=> r.result.createObjectStore(STORE); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbGet(key){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readonly'); const st=tx.objectStore(STORE); const r=st.get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(key,val){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readwrite'); const st=tx.objectStore(STORE); const r=st.put(val,key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
async function idbDel(key){ const db=await idbOpen(); return new Promise((res,rej)=>{ const tx=db.transaction(STORE,'readwrite'); const st=tx.objectStore(STORE); const r=st.delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }

// Web Locks (nur ein Schreiber pro Browser)
async function acquireWriteLock(){
  if(!('locks' in navigator)) { writeLockActive = true; return true; }
  const res = await navigator.locks.request('pst_write_lock', { ifAvailable:true, mode:'exclusive' }, lock => {
    if(!lock) return null;
    writeLockActive = true;
    return true;
  });
  if(!res){ writeLockActive=false; alert('Die Datei ist in einem anderen Tab schreibgeschützt geöffnet. Dieser Tab bleibt schreibgeschützt.'); }
  return !!res;
}
bc && (bc.onmessage = ev=>{
  if(ev?.data?.type==='who_has_lock' && writeLockActive) bc.postMessage({type:'i_have_lock', from:THIS_TAB_ID});
});
function announceLockProbe(){ bc && bc.postMessage({type:'who_has_lock', from:THIS_TAB_ID}); }

// Datei öffnen (persistenter Handle)
document.getElementById('openBtn').addEventListener('click', openFromPicker);
async function openFromPicker(){
  try{
    if(!('showOpenFilePicker' in window)){ // Fallback: alter Datei-Input
      const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
      inp.onchange=async()=>{ const f=inp.files[0]; if(!f) return; try{
        state=migrate(normalize(JSON.parse(await f.text()))); save(); show('auth');
        currentHandle=null; currentFileMeta={ lastModified:f.lastModified, size:f.size };
        await idbDel('lastHandle');
      }catch{ alert('Ungültige Datei'); } };
      inp.click(); return;
    }
    const [h]=await window.showOpenFilePicker({ types:[{description:'JSON',accept:{'application/json':['.json']}}]});
    await h.requestPermission?.({mode:'readwrite'});
    const f=await h.getFile(); const text=await f.text();
    state = migrate(normalize(JSON.parse(text)));
    save(); show('auth');
    currentHandle = h;
    currentFileMeta = { lastModified:f.lastModified, size:f.size };
    await idbSet('lastHandle', h);
    await acquireWriteLock();
    announceLockProbe();
  }catch(e){}
}

// Speichern-Button: schreibt in aktuelle Datei, sonst „Speichern unter…“
document.getElementById('saveBtn').addEventListener('click', saveToPicker);
async function saveToPicker(){
  if(currentHandle){ await writeToCurrentFile(); return; }
  const data=JSON.stringify(state,null,2);
  if('showSaveFilePicker' in window){
    const h=await window.showSaveFilePicker({ suggestedName:'poker_rounds.json', types:[{description:'JSON',accept:{'application/json':['.json']}}]});
    const w=await h.createWritable(); await w.write(data); await w.close();
    currentHandle = h;
    const nf = await h.getFile();
    currentFileMeta={ lastModified:nf.lastModified, size:nf.size };
    await idbSet('lastHandle', h);
    await acquireWriteLock();
    flashSaved();
    return;
  }
  const blob=new Blob([data],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='poker_rounds.json'; a.click(); URL.revokeObjectURL(url); alert('Gespeichert (Download). Auf iPhone/iPad bitte die Datei in iCloud Drive ablegen/ersetzen.');
}

async function writeToCurrentFile(){
  if(!currentHandle) return;
  if(!writeLockActive) return; // schreibgeschützt (anderer Tab)
  try{
    const disk = await currentHandle.getFile();
    if(currentFileMeta && disk.lastModified > (currentFileMeta.lastModified||0)){
      const ok = confirm('Die Datei wurde extern geändert. Jetzt neu laden (OK) oder meinen Stand überschreiben (Abbrechen)?');
      if(ok){
        const text=await disk.text();
        state=migrate(normalize(JSON.parse(text)));
        save(); show('auth');
        currentFileMeta={ lastModified:disk.lastModified, size:disk.size };
        return;
      }
      // sonst bewusst überschreiben
    }
    const w=await currentHandle.createWritable({ keepExistingData:false });
    await w.write(JSON.stringify(state,null,2));
    await w.close();
    const nf=await currentHandle.getFile();
    currentFileMeta={ lastModified:nf.lastModified, size:nf.size };
    flashSaved();
  }catch(e){ console.error(e); }
}

function scheduleAutosave(){
  if(!currentHandle) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeToCurrentFile, 500); // 0,5s Debounce
}
function flashSaved(){ const btn=document.getElementById('saveBtn'); const old=btn.textContent; btn.textContent='✅ Gespeichert'; setTimeout(()=> btn.textContent=old,1200); }

// ===== save(): speichert lokal & triggert Autosave
function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  streakCache.valid = false;
  rebuildStreaks();
  scheduleAutosave();
}

// Warnung beim Schließen, wenn Save geplant
window.addEventListener('beforeunload',(e)=>{ if(currentHandle && autosaveTimer){ e.preventDefault(); e.returnValue=''; } });

// ===== Init
show('auth');
rebuildStreaks();

// Zuletzt genutzten File-Handle automatisch laden (Chrome/Edge)
;(async ()=>{
  const h = await idbGet('lastHandle');
  if(!h) return;
  try{
    const perm = await h.queryPermission?.({mode:'readwrite'}) || 'prompt';
    if(perm==='granted' || await h.requestPermission?.({mode:'readwrite'})==='granted'){
      const f=await h.getFile(); const text=await f.text();
      state = migrate(normalize(JSON.parse(text)));
      save(); show('auth');
      currentHandle = h;
      currentFileMeta = { lastModified:f.lastModified, size:f.size };
      await acquireWriteLock();
      announceLockProbe();
    }
  }catch(e){
    await idbDel('lastHandle'); // Handle ungültig (verschoben/gelöscht)
  }
})();
