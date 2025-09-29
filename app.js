/* ===========================================================
   Poker-Stammtisch – Firebase Edition (vollständig)
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
let roomId = "stammtisch";      // ?room=xyz ändert Raum
let dbRef  = null;

let state = {
  version: 10,
  profiles: [],     // {id,name,pwHash?,avatarDataUrl}
  tournaments: [],  // {id,name,startDate,startChips,playerCount,players:[pid],admins:[pid],rounds:[{id,date,chips:{pid:num},comments:[],euroPerPersonCents?:number,durationMin?:number,comment?:string}]}
  preferences: {},
  profilePrefs: {}  // per pid: { streakWeek:{0..6:bool} } — reserviert
};

let currentProfileId = null;
let curTournamentId  = null;

/* ===========================================================
   Firebase
   =========================================================== */
async function ensureAuth(){
  try {
    if(!firebase.auth?.().currentUser && firebase.auth){
      await firebase.auth().signInAnonymously();
    }
  } catch(e){ console.error("Auth error", e); }
}

function bindRealtime(){
  dbRef = firebase.database().ref(`rooms/${roomId}/state`);
  dbRef.on("value", snap=>{
    const v = snap.val();
    if(v){
      state = migrate(normalize(v));
    } else {
      state = migrate(normalize(state));
      dbRef.set(state);
    }
    // WICHTIG: im Startscreen KEIN Header-Avatar einblenden
    render("auth");
  });
}

function save(){ if(dbRef) dbRef.set(state); }

/* ===========================================================
   Normalize + Migrate
   =========================================================== */
function normalize(d){
  const out = {
    version: d?.version || 10,
    profiles: Array.isArray(d?.profiles)? d.profiles: [],
    tournaments: Array.isArray(d?.tournaments)? d.tournaments: [],
    preferences: d?.preferences || {},
    profilePrefs: d?.profilePrefs || {}
  };
  return out;
}

function migrate(d){
  d.version = 10;
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

    // Runde normalisieren: values[] -> chips{}
    t.rounds = t.rounds.map(r=>{
      const rr = {
        id: r.id||uid("r"),
        date: r.date||todayIso(),
        chips: r.chips||{},
        comments: r.comments||[],
        euroPerPersonCents: r.euroPerPersonCents ?? null,
        durationMin: r.durationMin ?? 0,
        comment: r.comment || ""
      };
      if(!Object.keys(rr.chips).length && Array.isArray(r.values)){
        const obj={}; r.values.forEach(v=> obj[v.pid]=+v.chips||0); rr.chips=obj;
      }
      return rr;
    });
  });

  if(!d.profilePrefs) d.profilePrefs = {};
  d.profiles.forEach(p=>{
    if(!d.profilePrefs[p.id]) d.profilePrefs[p.id] = { streakWeek: {0:false,1:true,2:true,3:true,4:true,5:false,6:false} };
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

  // Avatar im Header nur anzeigen, wenn NICHT im Auth-Screen
  if(view === "auth"){
    $("btnHeaderProfile")?.classList.add("hidden");
  } else if (currentProfileId){
    showHeaderAvatar(currentProfileId);
  }

  if(view==="auth") renderAuth();
  if(view==="home") renderHome();
  if(view==="tournament" && curTournamentId) renderTournament(curTournamentId);
}

/* ---------- Header-Avatar ---------- */
function showHeaderAvatar(pid){
  const p = state.profiles.find(x=>x.id===pid); if(!p) return;
  const btn=$("btnHeaderProfile"), img=$("headerAvatar");
  if(!btn || !img) return;
  img.src = p.avatarDataUrl || genDefaultAvatar(p.name);
  btn.classList.remove("hidden");
  btn.onclick = ()=> openProfileView(pid, curTournamentId ? "tour" : "all");
}

/* ===========================================================
   AUTH
   =========================================================== */
$("btnLoginProfile").addEventListener("click", ()=>{
  const remembered = localStorage.getItem("pst_lastProfile");
  if(remembered && state.profiles.find(p=>p.id===remembered)){
    loginFlow(remembered);
  }else{
    showLoginList();
  }
});
$("linkRegister").addEventListener("click", (e)=>{ e.preventDefault(); openProfileEdit(null); });
$("linkOtherProfile").addEventListener("click", (e)=>{ e.preventDefault(); showLoginList(); });

function renderAuth(){
  // Startkreis zeigt gemerktes Profilbild
  const remembered = localStorage.getItem("pst_lastProfile");
  const btn = $("btnLoginProfile");
  if(remembered){
    const prof = state.profiles.find(p=>p.id===remembered);
    if(prof){
      btn.innerHTML = `<img src="${prof.avatarDataUrl||genDefaultAvatar(prof.name)}" style="width:100%;height:100%;border-radius:60px;object-fit:cover;border:2px solid #3a406f">`;
    }else{
      btn.textContent = "👥";
    }
  }else{
    btn.textContent = "👥";
  }

  // Grid rendern
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
  grid.style.display = state.profiles.length? "grid":"none";
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
  showHeaderAvatar(pid);   // Avatar erst NACH Login
  show("home");
}

/* ===========================================================
   PROFILE – erstellen/bearbeiten
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
    save(); dlgProf.close(); show("home"); alert("Profil gespeichert.");
  };
}
$("btnLogout").addEventListener("click", ()=>{
  currentProfileId=null; curTournamentId=null;
  $("btnHeaderProfile").classList.add("hidden"); // Avatar verstecken
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
  const sum=(t.players||[]).reduce((a,p)=> a+(+last.chips?.[p]||0),0);
  const total=t.playerCount*t.startChips;
  const hasIncomplete = t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0) < total);
  const hasOvershoot =  t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+r.chips?.[p]||0),0) > total);
  return { last:{sum,total}, hasIncomplete, hasOvershoot, total };
}

function renderTournament(tid){
  const t=state.tournaments.find(x=>x.id===tid); if(!t) return;
  $("dashTitle").textContent = t.name;
  $("dashSub").textContent   = `Start: ${fmtDate(t.startDate)} · Spieler: ${(t.players||[]).map(pid=> state.profiles.find(p=>p.id===pid)?.name||"?").join(", ")} · Soll: ${t.playerCount*t.startChips}`;

  // Leaderboard
  renderLeaderboard(t);

  // Rundenliste
  renderRounds(t);

  // Statuszeile
  const info=computeTournamentInfo(t);
  const ss=$("sumState");
  if(info.last){
    const {sum,total}=info.last; const isC=sum===total;
    ss.textContent = isC? `Letzte Runde: ${sum} / ${total}` : `Letzte Runde: ${sum} / ${total} · ${sum<total? 'unvollständig':'überschüssig'}`;
    ss.className='pill '+(isC?'good': (sum<total?'warn':'bad'));
  } else { ss.textContent='Letzte Runde: —'; ss.className='pill'; }
  $("flagIncomplete").style.display = info.hasIncomplete? '': 'none';
  $("flagOvershoot").style.display  = info.hasOvershoot?  '': 'none';
}

function renderLeaderboard(t){
  const leader=$("leaderGrid"); leader.innerHTML="";
  const totals={}, counts={};
  (t.players||[]).forEach(pid=>{ totals[pid]=0; counts[pid]=0; });
  const asc=[...t.rounds].sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  asc.forEach(r=>{
    (t.players||[]).forEach(pid=>{
      totals[pid]+= (+r.chips?.[pid]||0); counts[pid]+=1;
    });
  });
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
    card.onclick=()=> openProfileView(pid, "tour"); // WICHTIG: nur Turnier-Scope
    leader.appendChild(card);
  });
}
function renderRounds(t){
  const tbody=$("roundsBody"); tbody.innerHTML="";
  const rounds=[...t.rounds].sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  const targetTotal=t.playerCount*t.startChips;

  rounds.forEach(r=>{
    const sum=(t.players||[]).reduce((acc,pid)=> acc+(+r.chips?.[pid]||0),0);
    const isC=sum===targetTotal; const isUnder=sum<targetTotal;
    // Einsatz-Runden visuell markiert (overshoot-Klasse = gold/rot-Optik)
    const rowClass = (r.euroPerPersonCents!=null) ? "row overshoot" : (isC? "row": (isUnder? "row incomplete":"row overshoot"));

    const ranks = rankCompetition((t.players||[]).map(pid=> ({name:pid, value:+(r.chips?.[pid]||0)})));
    const order=(t.players||[]).slice().sort((a,b)=> ranks[a]-ranks[b]);

    const inner=document.createElement("table"); inner.style.width="100%";
    let html="";
    const first=order[0];
    const pctFirst = sum? ((+r.chips?.[first]||0)/sum*100):0;
    const stakeBadge = r.euroPerPersonCents!=null? ` <span class="pill" style="margin-left:6px">💰 ${(r.euroPerPersonCents/100).toFixed(2)} €</span>`:"";
    const durBadge = (r.durationMin && r.durationMin>0)? ` <span class="pill" style="margin-left:6px">⏱ ${r.durationMin} min</span>`:"";

    html+=`
      <tr>
        <td style="min-width:120px;padding:0 8px 8px 8px" rowspan="${order.length}">
          <b>${fmtDate(r.date)}</b>${stakeBadge}${durBadge}
        </td>
        <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[first]}</td>
        <td style="padding:0 8px 4px 8px">${state.profiles.find(p=>p.id===first)?.name||"?"}</td>
        <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${r.chips?.[first]||0}</b> · ${pctFirst.toFixed(1)}%</span></td>
      </tr>`;
    for(let i=1;i<order.length;i++){
      const pid=order[i]; const pct=sum? ((+r.chips?.[pid]||0)/sum*100):0;
      html+=`
        <tr>
          <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[pid]}</td>
          <td style="padding:0 8px 4px 8px">${state.profiles.find(p=>p.id===pid)?.name||"?"}</td>
          <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${r.chips?.[pid]||0}</b> · ${pct.toFixed(1)}%</span></td>
        </tr>`;
    }
    const commentStr = r.comment ? ("• "+r.comment) : ((r.comments&&r.comments[0]?.text) ? "• "+r.comments[0].text : "—");
    html += `
      <tr>
        <td colspan="4" style="padding:6px 8px 10px">
          <div class="footerFlex">
            <div class="${isC?'ok': (isUnder?'':'bad')}">Rundensumme: <b>${sum}</b> / ${targetTotal} · ${isC? '✓ OK': (isUnder? '✗ Unvollständig':'✗ Überschüssig')}</div>
            <div class="sub" style="flex:1">Kommentar: ${commentStr}</div>
            <div>
              <button class="btn small ghost" data-edit-id="${r.id}">Bearbeiten</button>
              <button class="btn small ghost" data-cmt-id="${r.id}">Kommentar</button>
              <button class="btn small danger" data-del-id="${r.id}">Löschen</button>
            </div>
          </div>
        </td>
      </tr>`;
    inner.innerHTML=html;
    const tr=document.createElement("tr"); tr.className=rowClass; const td=document.createElement("td"); td.colSpan=4; td.appendChild(inner); tr.appendChild(td); tbody.appendChild(tr);
  });

  qsa("[data-edit-id]").forEach(b=> b.addEventListener("click", ()=> openRoundEdit(t.id, b.getAttribute("data-edit-id"))));
  qsa("[data-del-id]").forEach(b=> b.addEventListener("click", ()=> deleteRound(t.id, b.getAttribute("data-del-id"))));
  qsa("[data-cmt-id]").forEach(b=> b.addEventListener("click", ()=> openComment(t.id, b.getAttribute("data-cmt-id"))));
}

function rankCompetition(items){ const s=[...items].sort((a,b)=> b.value-a.value); let rank=0,seen=0,prev=Infinity; const map={}; for(const it of s){ seen++; if(it.value!==prev){ rank=seen; prev=it.value;} map[it.name]=rank; } return map; }

/* ---------- Runden CRUD ---------- */
const dlgRound=$("dlgRound"), formRound=$("roundForm"), sumHint=$("sumHint");
function openRoundEdit(tid, rid){
  const t=state.tournaments.find(x=> x.id===tid); if(!t) return alert('Turnier fehlt');
  const r = rid? t.rounds.find(x=> x.id===rid) : {date: todayIso(), chips:{}, comments:[], euroPerPersonCents:null, durationMin:0, comment:""};

  $("dlgRoundTitle").textContent = rid? "Runde bearbeiten":"Neue Runde";
  formRound.innerHTML="";
  formRound.insertAdjacentHTML("beforeend", `<label>Datum<input type="date" id="r_date" value="${r.date}"></label>`);

  // Chips-Inputs
  const grid=document.createElement("div"); grid.className="grid2";
  (t.players||[]).forEach(pid=>{
    const name= state.profiles.find(p=>p.id===pid)?.name||"?";
    const val = +r.chips?.[pid]||0;
    const row=document.createElement("div");
    row.innerHTML = `<label>${name} (Chips)<input type="number" min="0" step="1" data-chip="${pid}" value="${val===0? "0": String(val)}" inputmode="numeric"></label>`;
    const inp=row.querySelector("input");
    // 0-Placeholder UX
    inp.addEventListener("focus", ()=>{ if(inp.value==="0") inp.value=""; });
    inp.addEventListener("blur",  ()=>{ if(inp.value==="") inp.value="0"; updateSumHint(); });
    inp.addEventListener("input", updateSumHint);
    grid.appendChild(row);
  });
  formRound.appendChild(grid);

  // Einsatz Umschalter + Feld
  const stakeId = "r_stake";
  const euroId  = "r_stake_euro";
  const stakeWrap = document.createElement("div");
  stakeWrap.innerHTML = `
    <div class="grid2">
      <label>Modus
        <select id="${stakeId}">
          <option value="none">Ohne Einsatz</option>
          <option value="with">Mit Einsatz</option>
        </select>
      </label>
      <label id="stakeEuroWrap" style="display:none">Einsatz pro Person (€)
        <input type="text" id="${euroId}" placeholder="##,##" value="${r.euroPerPersonCents!=null? (r.euroPerPersonCents/100).toFixed(2).replace('.',','): ''}">
      </label>
    </div>`;
  formRound.appendChild(stakeWrap);

  // Dauer + Kommentar Felder im Dialog (unterhalb, bereits im HTML vorhanden)
  $("r_duration").value = r.durationMin || 0;
  $("r_comment").value  = r.comment || "";

  const stakeSel=$(stakeId), euroInp=$(euroId), stakeEuroWrap=$("stakeEuroWrap");
  stakeSel.value = (r.euroPerPersonCents!=null)? "with":"none";
  stakeEuroWrap.style.display = (stakeSel.value==="with")? "":"none";
  stakeSel.onchange = ()=> stakeEuroWrap.style.display = (stakeSel.value==="with")? "":"none";

  function updateSumHint(){
    const sum=(t.players||[]).reduce((a,p)=> a+(+formRound.querySelector(`[data-chip="${p}"]`).value||0),0);
    const target=t.playerCount*t.startChips;
    const diff=target-sum;
    sumHint.textContent = diff===0? `✓ Alles gut — Summe: ${sum} / ${target}` : (diff>0? `Es fehlen noch ${diff} Chips — Summe: ${sum} / ${target}` : `${-diff} Chips zu viel — Summe: ${sum} / ${target}`);
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
    const commentTxt = ($("r_comment").value || "").trim();

    const obj = { id: rid||uid("r"), date, chips, comments:r.comments||[], euroPerPersonCents, durationMin, comment: commentTxt };
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
    if(!r.comment) r.comment = ""; // separater Kurzkommentar bleibt erhalten
    save(); dlg.close(); render("tournament");
  };
}

/* ---------- Turnier-Einstellungen ---------- */
const dlgSet=$("dlgTourSettings");
function openTourSettings(){
  const t=state.tournaments.find(x=> x.id===curTournamentId); if(!t) return;
  $("setStartChips").value=t.startChips; $("setPlayerCount").value=t.playerCount;

  // Admins: nur Spieler des Turniers (dein Punkt 11)
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
    t.startChips=Math.max(1,+$("setStartChips").value||t.startChips);
    t.playerCount=Math.max(2,+$("setPlayerCount").value||t.playerCount);
    t.admins=[...wrap.querySelectorAll("input:checked")].map(i=> i.value);
    save(); dlgSet.close(); render("tournament");
  };
}

/* ===========================================================
   PROFIL-QUICK-VIEW (mit PDF)
   =========================================================== */
$("profBack").addEventListener("click", ()=> show("home"));
$("profPdf").addEventListener("click", ()=> exportProfilePdf(currentProfileId, $("profScopeSel").value||"all"));

function openProfileView(pid, scopeDefault="all"){
  show("profile");
  const p = state.profiles.find(x=> x.id===pid); if(!p) return;
  $("profTitle").innerHTML = `<span class="avatarWrap"><img class="avatar mid" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}"></span> ${p.name}`;

  const sel=$("profScopeSel");
  // Wenn aus Turnier geöffnet, nur genau dieses Turnier vorselektieren
  sel.innerHTML = `<option value="all"${scopeDefault==="all"?" selected":""}>Gesamt (alle Turniere)</option>` + state.tournaments.map(t=> `<option value="${t.id}"${(scopeDefault==="tour" && t.id===curTournamentId)?" selected":""}>${t.name}</option>`).join("");
  sel.onchange=()=> renderProfile(pid, sel.value);
  renderProfile(pid, sel.value);
}

function renderProfile(pid, scope){
  const rows = [];
  state.tournaments.forEach(t=>{
    if(scope==="tour" && t.id!==curTournamentId) return;
    if(scope!=="all" && scope!=="tour" && t.id!==scope) return;
    if(!(t.players||[]).includes(pid)) return;
    (t.rounds||[]).forEach(r=>{
      const sum=(t.players||[]).reduce((a,pp)=> a+(+r.chips?.[pp]||0),0);
      const chips=+r.chips?.[pid]||0;
      const pct=sum? (chips/sum*100):0;
      const ranks=rankCompetition((t.players||[]).map(pp=> ({name:pp, value:+(r.chips?.[pp]||0)})));
      const status= sum===(t.playerCount*t.startChips)?'OK': (sum<(t.playerCount*t.startChips)?'Unvollständig':'Überschüssig');
      let euroDelta=null;
      if(r.euroPerPersonCents!=null){
        const participants = (t.players||[]).filter(pp => (+r.chips?.[pp]||0) > 0).length;
        const potCents = r.euroPerPersonCents * participants;
        const chipValue = sum>0? potCents / sum : 0;
        euroDelta = Math.round(chips * chipValue - r.euroPerPersonCents)/100;
      }
      rows.push({date:r.date, tour:t.name, rank:ranks[pid]||4, chips, pct, status, euroDelta, durationMin: r.durationMin||0});
    });
  });
  rows.sort((a,b)=> (b.date||"").localeCompare(a.date||""));

  const n=rows.length;
  const avgChips=n? rows.reduce((a,b)=> a+b.chips,0)/n : 0;
  const avgPct=n? rows.reduce((a,b)=> a+b.pct,0)/n : 0;
  const dist=[1,2,3,4].map(k=> rows.filter(x=> x.rank===k).length);
  const euroGames= rows.filter(r=> r.euroDelta!=null);
  const euroSum  = euroGames.reduce((a,b)=> a+(b.euroDelta||0),0);
  const totalDur = rows.reduce((a,b)=> a+(b.durationMin||0),0);

  $("profSub").textContent = `Runden: ${n} · Ø Chips: ${Math.round(avgChips)} · Ø %Stack: ${avgPct.toFixed(1)}% · 🥇 ${dist[0]} · 🥈 ${dist[1]} · 🥉 ${dist[2]} · 🗑️ ${dist[3]} · 💰 ${euroGames.length} (Summe: ${euroSum.toFixed(2)} €) · ⏱ ${totalDur} min`;

  // Sparkline
  const pv=$("pv_spark"); const ser=[...rows].reverse().map(x=> x.pct);
  pv.innerHTML = ser.map(v=> `<span title='${v.toFixed(1)}%' style='flex:1;background:linear-gradient(180deg,#6ee7ff,#8b5cff);align-self:flex-end;height:${Math.max(4,Math.min(100,Math.round(v)))}%'></span>`).join("");

  // Tabelle
  const tbody=$("profRows"); tbody.innerHTML="";
  rows.forEach(r=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(r.date)}</td>
      <td>${r.tour}</td>
      <td>#${r.rank}</td>
      <td>${r.chips}</td>
      <td>${r.pct.toFixed(1)}%</td>
      <td>${r.status}${r.euroDelta!=null? ` · ${(r.euroDelta>=0? "+":"")}${r.euroDelta.toFixed(2)} €`: ""}${r.durationMin? ` · ⏱ ${r.durationMin} min`:""}</td>`;
    tbody.appendChild(tr);
  });
}

/* ---------- PDF Quickview ---------- */
$("profPdf")?.addEventListener("click", ()=> exportProfilePdf(currentProfileId, $("profScopeSel").value||"all"));
async function exportProfilePdf(pid, scope){
  await loadPdfLibs();
  const p=state.profiles.find(x=>x.id===pid); if(!p) return;
  const { jsPDF } = window.jspdf;
  const doc=new jsPDF("p","mm","a4");
  const pageW=doc.internal.pageSize.getWidth(), pageH=doc.internal.pageSize.getHeight(), margin=12;
  doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.text(`Profil-Quickview – ${p.name}`, margin, 18);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(80);
  doc.text(`Stand: ${fmtDate(todayIso())} · Scope: ${scope==="all"?"alle Turniere": (scope==="tour"?"dieses Turnier":"ausgewählt")}`, margin, 24);
  let y=30;
  const kpiCard=qs("#view_profile .card:nth-of-type(1)"); if(kpiCard){ const c=await html2canvas(kpiCard,{backgroundColor:"#fff",scale:2}); const i=c.toDataURL("image/jpeg",0.92); const w=pageW-margin*2; const h=w/(c.width/c.height); if(y+h>pageH-margin){doc.addPage(); y=margin;} doc.addImage(i,"JPEG",margin,y,w,h,"","FAST"); y+=h+8; }
  const tableCard=qs("#view_profile .card:last-of-type"); if(tableCard){ const c=await html2canvas(tableCard,{backgroundColor:"#fff",scale:2}); const i=c.toDataURL("image/jpeg",0.92); const w=pageW-margin*2; const h=w/(c.width/c.height); if(y+h>pageH-margin){doc.addPage(); y=margin;} doc.addImage(i,"JPEG",margin,y,w,h,"","FAST"); y+=h+10; }
  doc.setDrawColor(200); doc.line(margin, pageH - margin - 18, pageW - margin, pageH - margin - 18);
  doc.setFontSize(9); doc.setTextColor(120); doc.text("© Brenner · Poker-Stammtisch", margin, pageH - margin);
  doc.save(`poker_${p.name}_quickview_${todayIso()}.pdf`);
}
async function loadPdfLibs(){
  if(!window.html2canvas){ await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.3/dist/html2canvas.min.js"; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
  if(!window.jspdf){ await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
}

/* ===========================================================
   ALL-TIME Bester – Dialog + Ergebnis + PDF
   =========================================================== */
function openAllTime(){
  // Dialog befüllen
  const box = $("at_players"); box.innerHTML="";
  state.profiles.forEach(p=>{
    const lab=document.createElement("label"); lab.style.display="flex"; lab.style.gap="8px"; lab.style.alignItems="center";
    lab.innerHTML = `<input type="checkbox" value="${p.id}" checked> ${p.name}`;
    box.appendChild(lab);
  });
  $("at_sort").value="avgStack";
  $("at_dir").value="desc";

  const dlg=$("dlgAllTime");
  dlg.showModal();
  $("atCancel").onclick=()=> dlg.close();
  $("atApply").onclick=()=>{
    const selIds=[...box.querySelectorAll("input:checked")].map(i=> i.value);
    const sortBy=$("at_sort").value;
    const dir=$("at_dir").value;

    const players = state.profiles.filter(p=> selIds.includes(p.id));
    const stats = players.map(p=>{
      let games=0,sumChips=0,sumPct=0,euro=0;
      state.tournaments.forEach(t=>{
        (t.rounds||[]).forEach(r=>{
          const chips=+r.chips?.[p.id]||0;
          if(chips>0 || (r.chips && p.id in r.chips)){
            games++; sumChips+=chips;
            const sum=(t.players||[]).reduce((a,pp)=> a+(+r.chips?.[pp]||0),0);
            sumPct += sum? (chips/sum*100):0;
            if(r.euroPerPersonCents!=null){
              const participants=(t.players||[]).filter(pp => (+r.chips?.[pp]||0)>0).length;
              const pot=r.euroPerPersonCents*participants;
              const chipVal=sum>0? pot/sum:0;
              euro += Math.round(chips*chipVal - r.euroPerPersonCents)/100;
            }
          }
        });
      });
      return { id:p.id, name:p.name,
        games,
        avgChips: games? sumChips/games:0,
        avgStack: games? sumPct/games:0,
        euroBalance: euro
      };
    });

    stats.sort((a,b)=>{
      const k=sortBy; const x=a[k], y=b[k];
      return (dir==="asc"? (x>y?1:-1) : (x<y?1:-1));
    });

    // Ergebnis-Seite
    const container=qs(".container");
    container.innerHTML=`
      <div class="card"><h3>All-Time – Ergebnis</h3>
        <div class="sub">Sortiert nach: ${$("at_sort").selectedOptions[0].text} (${dir==="asc"?"aufsteigend":"absteigend"})</div>
      </div>
      <div class="card" style="margin-top:10px">
        <table class="tbl" style="margin-top:0">
          <thead><tr><th>Spieler</th><th>Spiele</th><th>Ø Chips</th><th>Ø %Stack</th><th>€ Bilanz</th></tr></thead>
          <tbody id="allTimeRows"></tbody>
        </table>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="btnAllTimePdf">📄 PDF</button>
        <button class="btn secondary" id="btnBackHome2">← Übersicht</button>
      </div>`;
    $("btnBackHome2").onclick=()=> show("home");
    $("btnAllTimePdf").onclick=async ()=>{
      await loadPdfLibs();
      const { jsPDF } = window.jspdf;
      const doc=new jsPDF("p","mm","a4"); const pageW=doc.internal.pageSize.getWidth(); const pageH=doc.internal.pageSize.getHeight(); const margin=12;
      doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.text(`All-Time – Ergebnis`, margin, 18);
      doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(80); doc.text(`Stand: ${fmtDate(todayIso())}`, margin, 24);
      let y=30; const card=qs(".container .card:nth-of-type(2)"); if(card){ const c=await html2canvas(card,{backgroundColor:"#fff",scale:2}); const i=c.toDataURL("image/jpeg",0.92); const w=pageW-margin*2; const h=w/(c.width/c.height); if(y+h>pageH-margin){doc.addPage(); y=margin;} doc.addImage(i,"JPEG",margin,y,w,h,"","FAST"); y+=h+10; }
      doc.setDrawColor(200); doc.line(margin, pageH - margin - 18, pageW - margin, pageH - margin - 18);
      doc.setFontSize(9); doc.setTextColor(120); doc.text("© Brenner · Poker-Stammtisch", margin, pageH - margin);
      doc.save(`poker_alltime_${todayIso()}.pdf`);
    };
    $("allTimeRows").innerHTML = stats.map(s=> `<tr>
      <td>${s.name}</td><td>${s.games}</td><td>${s.avgChips.toFixed(1)}</td><td>${s.avgStack.toFixed(1)}%</td><td>${s.euroBalance.toFixed(2)} €</td>
    </tr>`).join("");

    dlg.close();
  };
}

/* ===========================================================
   START
   =========================================================== */
window.addEventListener("load", async ()=>{
  const params=new URLSearchParams(location.search);
  roomId=params.get("room")||"stammtisch";
  await ensureAuth();
  bindRealtime();
});
