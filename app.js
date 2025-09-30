/* ===========================================================
   Poker-Stammtisch – Firebase Edition (Streak + RoundCards)
   =========================================================== */

/* ---------- DOM Shortcuts ---------- */
const $  = (id)=> document.getElementById(id);
const qs = (sel)=> document.querySelector(sel);
const qsa= (sel)=> Array.from(document.querySelectorAll(sel));

/* ---------- Utils ---------- */
const todayIso = ()=> new Date().toISOString().slice(0,10);
const clamp = (n,min,max)=> Math.max(min, Math.min(max,n));
const uid = (p="id")=> `${p}_${Date.now()}_${Math.floor(Math.random()*1e6)}`;
const fmtDate = iso=>{ if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}.${m}.${y}`; };
const sum = arr => arr.reduce((a,b)=>a+b,0);

/* ---------- SHA-256 (Passwort) ---------- */
async function sha256Hex(str){
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

/* ---------- Default Avatar ---------- */
function genDefaultAvatar(name=""){
  const letter = (name||"?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>
    <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#6ee7ff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient></defs>
    <rect width='100%' height='100%' fill='#1a1f44'/>
    <circle cx='32' cy='24' r='14' fill='url(#g)'/>
    <rect x='16' y='38' width='32' height='18' rx='9' fill='#2b2f63'/>
    <text x='32' y='60' text-anchor='middle' font-family='Arial' font-size='10' fill='#e9ecf2'>${letter}</text>
  </svg>`;
  return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));
}

/* ---------- Global State ---------- */
let roomId = "stammtisch";
let dbRef  = null;

let state = {
  version: 12,
  profiles: [],
  tournaments: [],
  preferences: {},
  profilePrefs: {},   // streakWeek per Profil
};

let currentProfileId = null;
let curTournamentId  = null;

/* ===========================================================
   Firebase
   =========================================================== */
async function ensureAuth(){
  try{
    if(firebase.auth && !firebase.auth().currentUser){
      await firebase.auth().signInAnonymously();
    }
  }catch(e){ console.error("Auth error", e); }
}

function bindRealtime(){
  dbRef = firebase.database().ref(`rooms/${roomId}/state`);
  dbRef.on("value", snap=>{
    const v = snap.val();
    if(v){ state = migrate(normalize(v)); }
    else { state = migrate(normalize(state)); dbRef.set(state); }
    render("auth");
  });
}

function save(){ if(dbRef) dbRef.set(state); }

/* ===========================================================
   Normalize + Migrate
   =========================================================== */
function normalize(d){
  return {
    version: d?.version || 12,
    profiles: Array.isArray(d?.profiles)? d.profiles: [],
    tournaments: Array.isArray(d?.tournaments)? d.tournaments: [],
    preferences: d?.preferences || {},
    profilePrefs: d?.profilePrefs || {}
  };
}
function migrate(d){
  d.version = 12;
  d.profiles.forEach(p=>{
    p.id = p.id || uid("p");
    if(!p.avatarDataUrl) p.avatarDataUrl = genDefaultAvatar(p.name||"");
  });
  d.tournaments.forEach(t=>{
    t.id = t.id || uid("t");
    t.players = Array.isArray(t.players)? t.players: [];
    t.rounds  = Array.isArray(t.rounds)?  t.rounds:  [];
    if(!Array.isArray(t.admins)) t.admins = [];
    t.startChips = t.startChips || 640;
    t.playerCount= t.playerCount || t.players.length || 4;
    t.rounds = t.rounds.map(r=>({
      id: r.id||uid("r"),
      date: r.date||todayIso(),
      chips: r.chips||{},
      comments: r.comments||[],
      euroPerPersonCents: r.euroPerPersonCents ?? null,
      durationMin: r.durationMin ?? 0,
      comment: r.comment || ""
    }));
  });
  if(!d.profilePrefs) d.profilePrefs = {};
  d.profiles.forEach(p=>{
    if(!d.profilePrefs[p.id]) d.profilePrefs[p.id] = {
      streakWeek: {0:false,1:true,2:true,3:true,4:true,5:false,6:false}
    };
  });
  return d;
}

/* ===========================================================
   View Switching
   =========================================================== */
function render(view){
  const v = view || (!qs("#view_auth").classList.contains("hidden") ? "auth" :
                     !qs("#view_home").classList.contains("hidden") ? "home" :
                     !qs("#view_tournament").classList.contains("hidden") ? "tournament" : "profile");
  show(v);
}
function show(view){
  $("view_auth").classList.toggle("hidden", view!=="auth");
  $("view_home").classList.toggle("hidden", view!=="home");
  $("view_tournament").classList.toggle("hidden", view!=="tournament");
  $("view_profile").classList.toggle("hidden", view!=="profile");

  if(view==="auth"){ $("btnHeaderProfile")?.classList.add("hidden"); }
  else if(currentProfileId){ showHeaderAvatar(currentProfileId); }

  if(view==="auth") renderAuth();
  if(view==="home") renderHome();
  if(view==="tournament" && curTournamentId) renderTournament(curTournamentId);
}

/* ---------- Header-Avatar ---------- */
function showHeaderAvatar(pid){
  const p = state.profiles.find(x=>x.id===pid); if(!p) return;
  const btn=$("btnHeaderProfile"), img=$("headerAvatar"); if(!btn||!img) return;
  img.src = p.avatarDataUrl||genDefaultAvatar(p.name);
  btn.classList.remove("hidden");

  // Streak-Badge
  btn.querySelector(".streakBadge")?.remove();
  const s = computeStreak(pid);
  if(s>0){ const b=document.createElement("span"); b.className="streakBadge"; b.textContent=String(s); btn.appendChild(b); btn.title=`Streak: ${s}`; }

  btn.onclick = ()=> openProfileView(pid, curTournamentId ? "tour" : "all");
}

/* ===========================================================
   AUTH
   =========================================================== */
$("btnLoginProfile").addEventListener("click", ()=>{
  const remembered = localStorage.getItem("pst_lastProfile");
  if(remembered && state.profiles.find(p=>p.id===remembered)) loginFlow(remembered);
  else showLoginList();
});
$("linkRegister").addEventListener("click",(e)=>{ e.preventDefault(); openProfileEdit(null); });
$("linkOtherProfile").addEventListener("click",(e)=>{ e.preventDefault(); showLoginList(); });

function renderAuth(){
  // großer Kreis -> gemerktes Profilbild
  const remembered = localStorage.getItem("pst_lastProfile");
  const btn = $("btnLoginProfile");
  if(remembered){
    const prof = state.profiles.find(p=>p.id===remembered);
    if(prof){
      btn.innerHTML = `<img src="${prof.avatarDataUrl||genDefaultAvatar(prof.name)}" style="width:100%;height:100%;border-radius:60px;object-fit:cover;border:2px solid #3a406f">`;
    } else btn.textContent="👥";
  } else btn.textContent="👥";

  // Kartenliste
  const grid=$("authList"); grid.innerHTML="";
  state.profiles.forEach(p=>{
    const card=document.createElement("div"); card.className="card";
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <img class="avatar mid" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}">
        <div><b>${p.name}</b><div class="sub">Tippen zum Einloggen</div></div>
        <div style="margin-left:auto"><button class="btn small" data-login="${p.id}">Einloggen</button></div>
      </div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-login]").forEach(b=> b.addEventListener("click", ()=> loginFlow(b.getAttribute("data-login"))));
}
function showLoginList(){ $("authList").style.display="grid"; }

async function loginFlow(pid){
  const prof = state.profiles.find(p=>p.id===pid); if(!prof) return;
  if(prof.pwHash){
    const pw = prompt(`Passwort für ${prof.name}:`) || "";
    const h=await sha256Hex(pw);
    if(h!==prof.pwHash){ alert("Falsches Passwort."); return; }
  }
  currentProfileId = pid;
  localStorage.setItem("pst_lastProfile", pid);
  showHeaderAvatar(pid);
  show("home");
}

/* ===========================================================
   PROFILE – erstellen/bearbeiten (inkl. Streak)
   =========================================================== */
const dlgProf=$("dlgProfileEdit");
function openProfileEdit(pid){
  const p = pid? state.profiles.find(x=>x.id===pid) : {name:"", pwHash:null, avatarDataUrl:genDefaultAvatar("")};
  const isEdit=!!pid;
  $("dlgProfileTitle").textContent = isEdit? "Profil bearbeiten":"Profil anlegen";
  $("profName").value = p.name||"";
  $("lblProfPwCurrent").style.display = (isEdit && p.pwHash)? "":"none";
  $("profPwCurrent").value=""; $("profPwNew1").value=""; $("profPwNew2").value="";
  const prev=$("profAvatarPreview"); prev.innerHTML = `<span class="avatarWrap"><img class="avatar big" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}"></span>`; prev.dataset.url="";
  const file=$("profAvatar"); file.value="";
  file.onchange=()=>{
    const f=file.files[0]; if(!f) return;
    const r=new FileReader(); r.onload=()=>{
      const img=new Image(); img.onload=()=>{
        const c=document.createElement('canvas'); const s=256; c.width=s; c.height=s;
        const ctx=c.getContext('2d'); const min=Math.min(img.width,img.height); const sx=(img.width-min)/2; const sy=(img.height-min)/2;
        ctx.drawImage(img,sx,sy,min,min,0,0,s,s);
        const url=c.toDataURL('image/webp',0.85);
        prev.innerHTML = `<span class="avatarWrap"><img class="avatar big" src="${url}"></span>`;
        prev.dataset.url = url;
      }; img.src=r.result;
    }; r.readAsDataURL(f);
  };

  // Streak-Tage laden
  const week = (state.profilePrefs[p.id]?.streakWeek) || {0:false,1:true,2:true,3:true,4:true,5:false,6:false};
  qsa('#streakPrefs input[type="checkbox"]').forEach(cb=> cb.checked = !!week[+cb.dataset.dow]);

  dlgProf.showModal();
  $("profCancel").onclick=()=> dlgProf.close();
  $("profSave").onclick=async ()=>{
    const name=$("profName").value.trim(); if(!name) return alert("Name fehlt");
    const cur=$("profPwCurrent").value; const n1=$("profPwNew1").value; const n2=$("profPwNew2").value;
    let newHash=p.pwHash||null;
    if(isEdit){
      if(n1||n2){
        if(n1!==n2) return alert("Neue Passwörter stimmen nicht überein");
        if(p.pwHash){ if(!cur) return alert("Aktuelles Passwort fehlt"); const h=await sha256Hex(cur); if(h!==p.pwHash) return alert("Aktuelles Passwort falsch"); }
        if(n1 && n1.length<4) return alert("Neues Passwort zu kurz (≥4)");
        newHash=n1? await sha256Hex(n1): null;
      }
      p.name=name; p.pwHash=newHash; p.avatarDataUrl = prev.dataset.url || p.avatarDataUrl || genDefaultAvatar(name);
    }else{
      if(n1||n2){ if(n1!==n2) return alert("Neue Passwörter stimmen nicht überein"); if(n1.length<4) return alert("Neues Passwort zu kurz (≥4)"); newHash=await sha256Hex(n1); }
      const np={id:uid("p"), name, pwHash:newHash, avatarDataUrl: prev.dataset.url || genDefaultAvatar(name)};
      state.profiles.push(np); currentProfileId=np.id;
    }

    // Streak-Tage speichern
    const targetId = isEdit? p.id : currentProfileId;
    if(!state.profilePrefs[targetId]) state.profilePrefs[targetId]={};
    const w={}; qsa('#streakPrefs input[type="checkbox"]').forEach(cb=> w[+cb.dataset.dow]=cb.checked);
    state.profilePrefs[targetId].streakWeek = w;

    save(); dlgProf.close(); show("home"); alert("Profil gespeichert.");
  };
}
$("btnLogout").addEventListener("click", ()=>{
  currentProfileId=null; curTournamentId=null;
  $("btnHeaderProfile").classList.add("hidden");
  show("auth");
});

/* ===========================================================
   HOME
   =========================================================== */
$("btnNewTournament").addEventListener("click", ()=> openTournamentDialog());
$("btnAllTime").addEventListener("click", ()=> openAllTime());

function renderHome(){
  const who = state.profiles.find(p=>p.id===currentProfileId);
  $("whoPill").textContent = who? `Eingeloggt als: ${who.name}` : "Eingeloggt als: —";

  const my=$("myTournamentList"), other=$("otherTournamentList"); my.innerHTML=""; other.innerHTML="";
  const list=[...state.tournaments].sort((a,b)=>(b.startDate||"").localeCompare(a.startDate||""));
  list.forEach(t=>{
    const inTour=(t.players||[]).includes(currentProfileId);
    const div=document.createElement("div"); div.className="card"; div.style.cursor="pointer";
    const total=t.playerCount*t.startChips;
    const names=(t.players||[]).map(pid=> state.profiles.find(p=>p.id===pid)?.name||"?").join(", ");
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div>
          <h3 style="margin:0">${t.name}</h3>
          <div class="sub">Start: ${fmtDate(t.startDate)} · Spieler: ${names} · Soll: ${total}</div>
        </div>
        <div><button class="btn small">Öffnen</button></div>
      </div>`;
    div.onclick = ()=> openTournament(t.id);
    (inTour? my: other).appendChild(div);
  });
}

/* ---------- Turnier anlegen (Dialog) ---------- */
const dlgTour=$("dlgTournament");
function openTournamentDialog(){
  if(!currentProfileId){ alert("Bitte zuerst einloggen."); return; }
  const list=$("tourPlayers"); list.innerHTML="";
  state.profiles.forEach(p=>{
    const lab=document.createElement("label"); lab.style.display="flex"; lab.style.gap="8px"; lab.style.alignItems="center";
    lab.innerHTML = `<input type="checkbox" value="${p.id}" ${p.id===currentProfileId?'checked':''}> ${p.name}`;
    list.appendChild(lab);
  });
  $("tourName").value=""; $("tourDate").value = todayIso();
  $("tourStartChips").value=640; $("tourPlayerCount").value=4;
  dlgTour.showModal();
  $("tourCancel").onclick=()=> dlgTour.close();
  $("tourCreate").onclick=()=>{
    const name=$("tourName").value.trim(); if(!name) return alert("Name fehlt");
    const date=$("tourDate").value||todayIso();
    const startChips= Math.max(1,+$("tourStartChips").value||640);
    const playerCount= Math.max(2,+$("tourPlayerCount").value||4);
    const players=[...$("tourPlayers").querySelectorAll("input:checked")].map(i=> i.value);
    if(players.length<2) return alert("Mind. 2 Spieler.");
    const t={ id:uid("t"), name, startDate:date, players, startChips, playerCount, admins:[currentProfileId], rounds:[] };
    state.tournaments.push(t); save(); dlgTour.close(); openTournament(t.id);
  };
}

/* ===========================================================
   TURNIER-ANSICHT
   =========================================================== */
$("btnBackHome").addEventListener("click", ()=> show("home"));
$("btnTourSettings").addEventListener("click", ()=> openTourSettings());
$("addRoundBtn").addEventListener("click", ()=> openRoundEdit(curTournamentId, null));

function openTournament(id){ curTournamentId=id; show("tournament"); }

function computeTournamentInfo(t){
  if(!t||!t.rounds?.length){ return {last:null, hasIncomplete:false, hasOvershoot:false, total:t.playerCount*t.startChips}; }
  const sorted=[...t.rounds].sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  const last=sorted[0];
  const sumRound=(t.players||[]).reduce((a,p)=> a+(+last.chips?.[p]||0),0);
  const total=t.playerCount*t.startChips;
  const hasIncomplete = t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0) < total);
  const hasOvershoot =  t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0) > total);
  return { last:{sum:sumRound,total}, hasIncomplete, hasOvershoot, total };
}

function renderTournament(tid){
  const t=state.tournaments.find(x=>x.id===tid); if(!t) return;
  $("dashTitle").textContent = t.name;
  $("dashSub").textContent   = `Start: ${fmtDate(t.startDate)} · Spieler: ${(t.players||[]).map(pid=> state.profiles.find(p=>p.id===pid)?.name||"?").join(", ")} · Soll: ${t.playerCount*t.startChips}`;

  renderLeaderboard(t);
  renderRounds(t);

  const info=computeTournamentInfo(t);
  const ss=$("sumState");
  if(info.last){
    const {sum:sr,total}=info.last; const isC=sr===total;
    ss.textContent = isC? `Letzte Runde: ${sr} / ${total}` : `Letzte Runde: ${sr} / ${total} · ${sr<total? 'unvollständig':'überschüssig'}`;
    ss.className='pill '+(isC?'good': (sr<total?'warn':'bad'));
  } else { ss.textContent='Letzte Runde: —'; ss.className='pill'; }
  $("flagIncomplete").style.display = info.hasIncomplete? '': 'none';
  $("flagOvershoot").style.display  = info.hasOvershoot?  '': 'none';
}

function renderLeaderboard(t){
  const leader=$("leaderGrid"); leader.innerHTML="";
  const totals={}, counts={};
  (t.players||[]).forEach(pid=>{ totals[pid]=0; counts[pid]=0; });
  const asc=[...t.rounds].sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  asc.forEach(r=>{ (t.players||[]).forEach(pid=>{ totals[pid]+= (+r.chips?.[pid]||0); counts[pid]+=1; }); });
  const avgPct={}, avgChips={}; (t.players||[]).forEach(pid=>{
    const n=counts[pid]||1;
    avgChips[pid]= totals[pid]/n;
    const denom=t.playerCount*t.startChips||1;
    avgPct[pid]= (avgChips[pid]/denom*100)||0;
  });
  const order=(t.players||[]).slice().sort((a,b)=> avgPct[b]-avgPct[a]);

  order.forEach((pid,i)=>{
    const p=state.profiles.find(x=>x.id===pid);
    const card=document.createElement("div"); card.className="card"; card.style.cursor="pointer";
    const medal=i===0?"🥇":i===1?"🥈":i===2?"🥉":"";
    card.innerHTML = `<h3>${medal? medal+" ":""}<img class="avatar mini" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}"> ${p.name}</h3>
      <div class="sub">Ø Chips: <b>${Math.round(avgChips[pid])}</b> · Ø %Stack: <b>${avgPct[pid].toFixed(1)}</b>%</div>
      <div class="bar gray"><span style="width:${clamp(avgPct[pid],0,100)}%"></span></div>`;
    card.onclick=()=> openProfileView(pid, "tour");
    leader.appendChild(card);
  });
}

/* ---------- Rundenliste als große Karten ---------- */
function rankCompetition(items){ const s=[...items].sort((a,b)=> b.value-a.value); let rank=0,seen=0,prev=Infinity; const map={}; for(const it of s){ seen++; if(it.value!==prev){ rank=seen; prev=it.value;} map[it.name]=rank; } return map; }

function renderRounds(t){
  const wrap=$("roundsList"); wrap.innerHTML="";
  const rounds=[...t.rounds].sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  const targetTotal=t.playerCount*t.startChips;

  rounds.forEach(r=>{
    const sumRound=(t.players||[]).reduce((acc,pid)=> acc+(+r.chips?.[pid]||0),0);
    const isC=sumRound===targetTotal; const isUnder=sumRound<targetTotal;
    const ranks = rankCompetition((t.players||[]).map(pid=> ({name:pid, value:+(r.chips?.[pid]||0)})));
    const order=(t.players||[]).slice().sort((a,b)=> ranks[a]-ranks[b]);

    const card=document.createElement("div"); card.className="roundCard";
    const head=document.createElement("div"); head.className="roundHead";
    head.innerHTML = `<span class="date">${fmtDate(r.date)}</span>
      <span class="meta">${r.durationMin? `⏱ ${r.durationMin} min`:""}${r.euroPerPersonCents!=null? ` · 💰 ${(r.euroPerPersonCents/100).toFixed(2)} €`:""}</span>`;
    card.appendChild(head);

    order.forEach(pid=>{
      const pct = sumRound? ((+r.chips?.[pid]||0)/sumRound*100):0;
      const row=document.createElement("div"); row.className="roundRow";
      row.innerHTML = `<div>#${ranks[pid]}</div>
        <div>${state.profiles.find(p=>p.id===pid)?.name||"?"}</div>
        <div class="sub"><b>${r.chips?.[pid]||0}</b> · ${pct.toFixed(1)}%</div>`;
      card.appendChild(row);
    });

    const foot=document.createElement("div"); foot.className="roundFoot";
    const commentStr = r.comment ? ("• "+r.comment) : ((r.comments&&r.comments[0]?.text) ? "• "+r.comments[0].text : "—");
    const sumCls = isC? 'sumOK' : (isUnder? 'sumWarn':'sumBad');
    foot.innerHTML = `
      <div class="sub">Kommentar: ${commentStr}</div>
      <div class="${sumCls} sub">Summe: <b>${sumRound}</b> / ${targetTotal} · ${isC? '✓ OK': (isUnder? '✗ Unvollständig':'✗ Überschüssig')}</div>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn small ghost" data-edit-id="${r.id}">Bearbeiten</button>
        <button class="btn small ghost" data-cmt-id="${r.id}">Kommentar</button>
        <button class="btn small danger" data-del-id="${r.id}">Löschen</button>
      </div>`;
    card.appendChild(foot);

    wrap.appendChild(card);
  });

  qsa("[data-edit-id]").forEach(b=> b.addEventListener("click", ()=> openRoundEdit(t.id, b.getAttribute("data-edit-id"))));
  qsa("[data-del-id]").forEach(b=> b.addEventListener("click", ()=> deleteRound(t.id, b.getAttribute("data-del-id"))));
  qsa("[data-cmt-id]").forEach(b=> b.addEventListener("click", ()=> openComment(t.id, b.getAttribute("data-cmt-id"))));
}

/* ---------- Runden CRUD ---------- */
const dlgRound=$("dlgRound"), formRound=$("roundForm"), sumHint=$("sumHint");
function openRoundEdit(tid, rid){
  const t=state.tournaments.find(x=> x.id===tid); if(!t) return alert('Turnier fehlt');
  const r = rid? t.rounds.find(x=> x.id===rid) : {date: todayIso(), chips:{}, comments:[], euroPerPersonCents:null, durationMin:0, comment:""};

  $("dlgRoundTitle").textContent = rid? "Runde bearbeiten":"Neue Runde";
  formRound.innerHTML="";
  formRound.insertAdjacentHTML("beforeend", `<label>Datum<input type="date" id="r_date" value="${r.date}"></label>`);

  // Chips-Inputs
  const grid=document.createElement("div"); grid.className="grid"; grid.style.gridTemplateColumns="repeat(2,1fr)"; grid.style.gap="10px";
  (t.players||[]).forEach(pid=>{
    const name= state.profiles.find(p=>p.id===pid)?.name||"?";
    const val = +r.chips?.[pid]||0;
    const row=document.createElement("div");
    row.innerHTML = `<label>${name} (Chips)<input type="number" min="0" step="1" data-chip="${pid}" value="${val===0? "0": String(val)}" inputmode="numeric"></label>`;
    const inp=row.querySelector("input");
    inp.addEventListener("focus", ()=>{ if(inp.value==="0") inp.value=""; });
    inp.addEventListener("blur",  ()=>{ if(inp.value==="") inp.value="0"; updateSumHint(); });
    inp.addEventListener("input", updateSumHint);
    grid.appendChild(row);
  });
  formRound.appendChild(grid);

  // Einsatz + Dauer
  const wrap=document.createElement("div"); wrap.className="grid"; wrap.style.gridTemplateColumns="repeat(2,1fr)"; wrap.style.gap="10px";
  wrap.innerHTML=`
    <label>Modus
      <select id="r_stake">
        <option value="none">Ohne Einsatz</option>
        <option value="with">Mit Einsatz</option>
      </select>
    </label>
    <label id="stakeEuroWrap" style="display:none">Einsatz pro Person (€)
      <input type="text" id="r_stake_euro" placeholder="##,##" value="${r.euroPerPersonCents!=null? (r.euroPerPersonCents/100).toFixed(2).replace('.',','): ''}">
    </label>
    <label>Dauer (Minuten)
      <input type="number" id="r_duration" min="0" step="1" value="${r.durationMin||0}" />
    </label>`;
  formRound.appendChild(wrap);

  const stakeSel=$("r_stake"), euroInp=$("r_stake_euro"), stakeEuroWrap=$("stakeEuroWrap");
  stakeSel.value = (r.euroPerPersonCents!=null)? "with":"none";
  stakeEuroWrap.style.display = (stakeSel.value==="with")? "":"none";
  stakeSel.onchange = ()=> stakeEuroWrap.style.display = (stakeSel.value==="with")? "":"none";

  function updateSumHint(){
    const s=(t.players||[]).reduce((a,p)=> a+(+formRound.querySelector(`[data-chip="${p}"]`).value||0),0);
    const target=t.playerCount*t.startChips;
    const diff=target-s;
    sumHint.textContent = diff===0? `✓ Alles gut — Summe: ${s} / ${target}` : (diff>0? `Es fehlen noch ${diff} Chips — Summe: ${s} / ${target}` : `${-diff} Chips zu viel — Summe: ${s} / ${target}`);
    sumHint.style.color = diff===0? 'var(--good)': (diff>0? '#ffd79c':'#ffb2b2');
  }
  updateSumHint();

  dlgRound.showModal();
  $("roundCancel").onclick=()=> dlgRound.close();
  $("roundSave").onclick=()=>{
    const date = $("r_date").value || todayIso();
    const chips = {}; (t.players||[]).forEach(pid=> chips[pid]= +(formRound.querySelector(`[data-chip="${pid}"]`).value||0));
    let euroPerPersonCents=null;
    if(stakeSel.value==="with"){
      let txt=(euroInp.value||"").replace(".",",");
      if(txt.includes(",")){ const [a,b="0"]=txt.split(","); txt = `${a}.${b.padEnd(2,"0").slice(0,2)}`; }
      const euro=parseFloat(txt)||0; euroPerPersonCents = Math.round(euro*100);
    }
    const durationMin = Math.max(0, +$("r_duration").value || 0);
    const obj = { id: rid||uid("r"), date, chips, comments:r.comments||[], euroPerPersonCents, durationMin, comment: r.comment||"" };
    if(rid){ const i=t.rounds.findIndex(x=> x.id===rid); if(i>=0) t.rounds[i]=obj; } else t.rounds.push(obj);
    save(); dlgRound.close(); render("tournament");
  };
}

function deleteRound(tid, rid){
  const t=state.tournaments.find(x=> x.id===tid); if(!t) return;
  if(confirm("Runde wirklich löschen?")){
    t.rounds = t.rounds.filter(r=> r.id!==rid);
    save(); render("tournament");
  }
}
function openComment(tid, rid){
  const t=state.tournaments.find(x=> x.id===tid); if(!t) return;
  const dlg=$("dlgComment");
  const r=t.rounds.find(x=> x.id===rid);
  $("commentText").value=(r.comments?.[0]?.text)||"";
  dlg.showModal();
  $("commentCancel").onclick=()=> dlg.close();
  $("commentSave").onclick=()=>{
    const txt=($("commentText").value||"").trim();
    r.comments = txt? [{by:currentProfileId, at:new Date().toISOString(), text:txt}] : [];
    save(); dlg.close(); render("tournament");
  };
}

/* ---------- Turnier-Einstellungen ---------- */
const dlgSet=$("dlgTourSettings");
function openTourSettings(){
  const t=state.tournaments.find(x=> x.id===curTournamentId); if(!t) return;
  $("setStartChips").value=t.startChips; $("setPlayerCount").value=t.playerCount;
  const wrap=$("setAdmins"); wrap.innerHTML="";
  (t.players||[]).forEach(pid=>{
    const p=state.profiles.find(x=>x.id===pid);
    const checked=(t.admins||[]).includes(pid);
    const lab=document.createElement("label"); lab.style.display="flex"; lab.style.gap="8px"; lab.style.alignItems="center";
    lab.innerHTML=`<input type='checkbox' value='${pid}' ${checked?'checked':''}> ${p?.name||"?"}`;
    wrap.appendChild(lab);
  });
  dlgSet.showModal();
  $("setCancel").onclick=()=> dlgSet.close();
  $("setSave").onclick=()=>{
    const t=state.tournaments.find(x=> x.id===curTournamentId); if(!t) return;
    t.startChips=Math.max(1,+$("setStartChips").value||t.startChips);
    t.playerCount=Math.max(2,+$("setPlayerCount").value||t.playerCount);
    t.admins=[...wrap.querySelectorAll("input:checked")].map(i=> i.value);
    save(); dlgSet.close(); render("tournament");
  };
}
/* ===========================================================
   PROFIL-QUICK-VIEW (mit Druck & KPI-Zeilen)
   =========================================================== */
$("profBack").addEventListener("click", ()=> show("home"));
$("profPrint").addEventListener("click", ()=> window.print());
$("profEdit").addEventListener("click", ()=> { if(currentProfileId) openProfileEdit(currentProfileId); });

function openProfileView(pid, scopeDefault="all"){
  show("profile");
  const p = state.profiles.find(x=> x.id===pid);
  if(!p) return;

  // Profil-Titel + Avatar
  $("profTitle").innerHTML = `<span class="avatarWrap"><img class="avatar mid" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}"></span> ${p.name}`;

  // Streak-Badge im Profil
  const wrap=$("profTitle").querySelector(".avatarWrap");
  wrap.querySelector(".streakBadge")?.remove();
  const s=computeStreak(pid);
  if(s>0){
    const b=document.createElement("span");
    b.className="streakBadge";
    b.textContent=String(s);
    wrap.appendChild(b);
  }

  // Profil bearbeiten-Button nur für eingeloggten Spieler und nur im Profil-View
  $("profEdit").style.display = (pid === currentProfileId && scopeDefault === "all") ? "" : "none";

  // Dropdown für Scope
  const sel=$("profScopeSel");
  sel.innerHTML = `<option value="all"${scopeDefault==="all"?" selected":""}>Gesamt (alle Turniere)</option>` +
    state.tournaments.map(t=> `<option value="${t.id}"${(scopeDefault==="tour" && t.id===curTournamentId)?" selected":""}>${t.name}</option>`).join("");
  sel.onchange=()=> renderProfile(pid, sel.value);

  renderProfile(pid, sel.value);
}

function renderProfileKpis(pid, rows){
  const n = rows.length;
  const avgChips = n ? Math.round(rows.reduce((a,b)=> a + (b.chips||0), 0) / n) : 0;
  const avgPct   = n ?        rows.reduce((a,b)=> a + (b.pct||0),   0) / n   : 0;

  let g=0,s=0,b=0,x=0;
  rows.forEach(r=>{
    if(r.rank===1) g++; else if(r.rank===2) s++; else if(r.rank===3) b++; else x++;
  });

  const euroSum = rows.reduce((a,b)=> a + (b.euroDelta ?? 0), 0);
  const mins    = rows.reduce((a,b)=> a + (b.durationMin||0), 0);

  const k = $("profMeta");
  k.innerHTML = `
    <div class="row sub">Runden: <b>${n}</b></div>
    <div class="row sub">Ø Chips: <b>${avgChips}</b> · Ø %Stack: <b>${avgPct.toFixed(1)}%</b></div>
    <div class="row sub">🥇 <b>${g}</b> · 🥈 <b>${s}</b> · 🥉 <b>${b}</b> · 🗑️ <b>${x}</b></div>
    <div class="row sub">💰 <b>${euroSum>=0?'+':''}${euroSum.toFixed(2)} €</b> (Gewinn/Verlust) · ⏱ <b>${mins}</b> min</div>`;
}

function renderProfile(pid, scope){
  // 1) Runden einsammeln und nach Turnier gruppieren
  const blocks = [];
  const pushRow = (t, row) => {
    let b = blocks.find(x => x.tourId === t.id);
    if(!b){ b = { tourId: t.id, tourName: t.name, rows: [] }; blocks.push(b); }
    b.rows.push(row);
  };

  state.tournaments.forEach(t=>{
    if(scope==="tour" && t.id!==curTournamentId) return;
    if(scope!=="all" && scope!=="tour" && t.id!==scope) return;
    if(!(t.players||[]).includes(pid)) return;

    (t.rounds||[]).forEach(r=>{
      const totalChips = (t.players||[]).reduce((a,pp)=> a+(+r.chips?.[pp]||0),0);
      const myChips    = +r.chips?.[pid] || 0;
      const myPct      = totalChips ? (myChips/totalChips*100) : 0;

      const ranks  = rankCompetition((t.players||[]).map(pp => ({name:pp, value:+(r.chips?.[pp]||0)})));
      const myRank = ranks[pid] || (t.players?.length || 4);

      const target = (t.playerCount||t.players?.length||0) * (t.startChips||0);
      const status = totalChips===target ? "OK" : (totalChips<target ? "Unvollständig" : "Überschüssig");

      // €-Delta nur, wenn Einsatz hinterlegt
      let euroDelta = null;
      if(r.euroPerPersonCents!=null){
        const participants = (t.players||[]).filter(pp => (+r.chips?.[pp]||0)>0).length;
        const potCents     = r.euroPerPersonCents * participants;
        const chipValue    = totalChips>0 ? potCents/totalChips : 0;
        euroDelta = Math.round(myChips*chipValue - r.euroPerPersonCents)/100; // €
      }

      pushRow(t, {
        date: r.date,
        tour: t.name,
        rank: myRank,
        chips: myChips,
        pct: myPct,
        status,
        euroDelta,
        durationMin: r.durationMin||0
      });
    });
  });

  blocks.sort((a,b)=> (a.tourName||"").localeCompare(b.tourName||""));
  blocks.forEach(b => b.rows.sort((a,b)=> (b.date||"").localeCompare(a.date||"")));

  // 2) KPIs & Sparkline aus gefilterten Zeilen
  const allRows = blocks.flatMap(b=> b.rows);
  renderProfileKpis(pid, allRows);

  const pv = $("pv_spark");
  pv.innerHTML = "";
  if(allRows.length){
    const series = [...allRows].reverse().map(x => x.pct);
    pv.innerHTML = series.map(v => {
      const h = Math.max(4, Math.min(100, Math.round(v || 0)));
      return `<span title="${(v||0).toFixed(1)}%" style="height:${h}%"></span>`;
    }).join("");
  }

  // 3) Tabelle
  const tbody = $("profRows");
  tbody.innerHTML = "";

  if(blocks.length===0){
    const tr=document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="sub">Keine Runden im gewählten Bereich.</td>`;
    tbody.appendChild(tr);
    return;
  }

  blocks.forEach((b, bi)=>{
    const head = document.createElement("tr");
    head.innerHTML = `<td colspan="6" style="padding-top:${bi? '12px':'0'}"><b>${b.tourName}</b></td>`;
    tbody.appendChild(head);

    b.rows.forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDate(r.date)}</td>
        <td>${b.tourName}</td>
        <td>#${r.rank}</td>
        <td>${r.chips}</td>
        <td>${r.pct.toFixed(1)}%</td>
        <td>${r.status}${r.euroDelta!=null? ` · ${(r.euroDelta>=0? "+":"")}${r.euroDelta.toFixed(2)} €`: ""}${r.durationMin? ` · ⏱ ${r.durationMin} min`:""}</td>`;
      tbody.appendChild(tr);
    });
  });
}

/* Hilfsfunktion (wird in All-Time genutzt) */
function collectPlayerRounds(pid){
  const rows=[];
  state.tournaments.forEach(t=>{
    if(!(t.players||[]).includes(pid)) return;
    (t.rounds||[]).forEach(r=>{
      const sumRound=(t.players||[]).reduce((a,pp)=> a+(+r.chips?.[pp]||0),0);
      const my=+r.chips?.[pid]||0;
      const pct=sumRound? (my/sumRound*100):0;
      const ranks=rankCompetition((t.players||[]).map(pp=> ({name:pp, value:+(r.chips?.[pp]||0)})));
      rows.push({t, r, myChips:my, myPct:pct, rank:ranks[pid], euroPerPersonCents:r.euroPerPersonCents||0, durationMin:r.durationMin||0});
    });
  });
  return rows.sort((a,b)=> (b.r.date||"").localeCompare(a.r.date||""));
}

/* ===========================================================
   All-Time (mit Spielzeit)
   =========================================================== */
function openAllTime(){
  const dlg=$("dlgAllTime");
  // Spieler-Auswahl
  const c=$("at_players"); c.innerHTML="";
  state.profiles.forEach(p=>{
    const lab=document.createElement("label"); lab.style.display="flex"; lab.style.gap="8px"; lab.style.alignItems="center";
    lab.innerHTML=`<input type="checkbox" value="${p.id}" checked> ${p.name}`;
    c.appendChild(lab);
  });

  dlg.showModal();
  $("atCancel").onclick=()=> dlg.close();
  $("atApply").onclick=()=>{
    const ids=[...$("at_players").querySelectorAll("input:checked")].map(i=> i.value);
    const sortBy=$("at_sort").value;
    const dir=$("at_dir").value;
    renderAllTimeResult(ids, sortBy, dir);
    dlg.close();
  };
}

function renderAllTimeResult(ids, sortBy, dir){
  const rows=[];
  ids.forEach(pid=>{
    const rounds = collectPlayerRounds(pid); // {t, r, myChips, myPct, durationMin, ...}
    if(!rounds.length) return;

    const games   = rounds.length;
    const chipsAvg= sum(rounds.map(r=> r.myChips))/games;
    const pctAvg  = sum(rounds.map(r=> r.myPct))/games;

    // Gewinn/Verlust berechnen (nicht Einsatz)
    let euroSum = 0; // €
    let mins    = 0;
    rounds.forEach(row=>{
      mins += row.durationMin||0;
      const t = row.t, r = row.r;
      if(r.euroPerPersonCents!=null){
        const participants = (t.players||[]).filter(pp => (+r.chips?.[pp]||0)>0).length;
        const totalChips   = (t.players||[]).reduce((a,pp)=> a+(+r.chips?.[pp]||0), 0);
        const potCents     = r.euroPerPersonCents * participants;
        const chipValue    = totalChips>0 ? potCents/totalChips : 0; // Cent pro Chip
        const deltaEuro    = Math.round(row.myChips*chipValue - r.euroPerPersonCents) / 100; // €
        euroSum += deltaEuro;
      }
    });

    rows.push({pid,games,chipsAvg,pctAvg,euroSum,mins});
  });

  const keyMap = {avgChips:'chipsAvg', avgStack:'pctAvg', euroBalance:'euroSum', games:'games'};
  const key = keyMap[sortBy] || 'pctAvg';
  rows.sort((a,b)=> (dir==='asc'? 1:-1) * ((a[key]||0)-(b[key]||0)));

  // UI-Modal füllen
  $("at_header").textContent =
    `Sortiert nach: ${$("at_sort").selectedOptions[0].text} (${dir==='asc'?'aufsteigend':'absteigend'})`;

  const tb=$("at_rows"); tb.innerHTML="";
  rows.forEach(r=>{
    const p=state.profiles.find(x=>x.id===r.pid);
    const tr=document.createElement("tr");
    tr.innerHTML = `<td>${p?.name||"?"}</td>
      <td class="al-right">${r.games}</td>
      <td class="al-right">${r.chipsAvg.toFixed(1)}</td>
      <td class="al-right">${r.pctAvg.toFixed(1)}%</td>
      <td class="al-right">${r.euroSum>=0?'+':''}${r.euroSum.toFixed(2)} €</td>
      <td class="al-right">${r.mins} min</td>`;
    tb.appendChild(tr);
  });

  // Print-Only-Tabelle füllen
  $("printAtMeta").textContent =
    `Sortiert nach: ${$("at_sort").selectedOptions[0].text} (${dir==='asc'?'aufsteigend':'absteigend'})`;

  const ptb = $("printAtRows"); ptb.innerHTML="";
  rows.forEach(r=>{
    const p=state.profiles.find(x=>x.id===r.pid);
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:6px;border-bottom:1px solid #ddd">${p?.name||"?"}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #ddd">${r.games}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #ddd">${r.chipsAvg.toFixed(1)}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #ddd">${r.pctAvg.toFixed(1)}%</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #ddd">${r.euroSum>=0?'+':''}${r.euroSum.toFixed(2)} €</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #ddd">${r.mins} min</td>`;
    ptb.appendChild(tr);
  });

  // Dialog öffnen + Print-Button
  const resultDlg = $("dlgAllTimeResult");
  resultDlg.showModal();
  $("atResClose").onclick = () => resultDlg.close();
  $("atResPrint").onclick = () => {
    document.body.classList.add("printing-at");
    window.print();
    setTimeout(()=> document.body.classList.remove("printing-at"), 0);
  };
}

/* ===========================================================
   Streak
   =========================================================== */
function computeStreak(pid){
  // Zählt Tage in Folge mit irgendeiner gespielten Runde (berücksichtigt streakWeek)
  const week = state.profilePrefs[pid]?.streakWeek || {1:true,2:true,3:true,4:true,5:false,6:false,0:false};
  // Hole alle Datums, an denen der Spieler Runden hatte
  const dates=new Set();
  state.tournaments.forEach(t=>{
    (t.rounds||[]).forEach(r=>{
      if((t.players||[]).includes(pid) && (r.chips?.[pid]>0 || r.chips?.[pid]===0)){
        dates.add(r.date);
      }
    });
  });
  if(!dates.size) return 0;

  // Von heute rückwärts zählen – nur Tage zählen, die in week=true
  let streak=0;
  const d=new Date(); // heute
  for(let i=0;i<365;i++){
    const dow=d.getDay();               // 0=So..6=Sa
    const iso=d.toISOString().slice(0,10);
    const relevant = !!week[dow];
    const played = dates.has(iso);
    if(relevant){
      if(played){ streak++; }
      else { break; }
    }
    d.setDate(d.getDate()-1);
  }
  return streak;
}

/* ===========================================================
   INIT
   =========================================================== */
window.addEventListener("DOMContentLoaded", async ()=>{
  await ensureAuth();
  // Raum aus URL
  try{
    const u=new URL(location.href);
    const r=u.searchParams.get("room"); if(r) roomId=r;
  }catch(e){}
  bindRealtime();
});
