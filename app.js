/* ===========================================================
   Poker-Stammtisch (Firebase Edition) – App-Logik
   Kompatibel mit der 2-teiligen index.html von oben (ohne Dialog-Tags)
   =========================================================== */

/* --------- Kurz-Helfer --------- */
const $  = (id)=> document.getElementById(id);
const qs = (sel)=> document.querySelector(sel);
const qsa= (sel)=> Array.from(document.querySelectorAll(sel));
const todayIso = ()=> new Date().toISOString().slice(0,10);

function uid(p="id"){ return `${p}_${Date.now()}_${Math.floor(Math.random()*1e6)}`; }
function fmtDate(iso){ if(!iso) return "—"; const [y,m,d]=iso.split("-"); return `${d}.${m}.${y}`; }
function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }

/* --------- State --------- */
let roomId = "stammtisch"; // via URL-Param überschreibbar
let dbRef = null;
let state = {
  version: 1,
  profiles: [],               // [{id,name,pwHash?,avatarDataUrl?}]
  tournaments: [],            // [{id,name,startDate,startChips,playerCount,players:[pid],rounds:[{id,date,values:[{pid,chips}],comment?,euroPerPersonCents?}]}]
  preferences: {              // Geräteübergreifend (einfach)
    streakWeekDefault: {0:false,1:true,2:true,3:true,4:true,5:false,6:false}
  },
  profilePrefs: {}            // pro Profil: { [pid]: { streakWeek:{0..6:bool} } }
};
let currentProfileId = null;
let currentTournamentId = null;

/* --------- Firebase Init + Sync --------- */
async function ensureAuth(){
  try{
    if(!firebase.auth().currentUser){
      await firebase.auth().signInAnonymously();
    }
  }catch(e){ console.error("Auth error:", e); }
}

function bindRealtime(){
  dbRef = firebase.database().ref(`rooms/${roomId}/state`);
  dbRef.on("value", snap=>{
    const v = snap.val();
    if(v){
      // Migration light – felder ergänzen
      if(!v.preferences) v.preferences = {streakWeekDefault:{0:false,1:true,2:true,3:true,4:true,5:false,6:false}};
      if(!v.profilePrefs) v.profilePrefs = {};
      v.profiles = Array.isArray(v.profiles)? v.profiles: [];
      v.tournaments = Array.isArray(v.tournaments)? v.tournaments: [];
      state = v;
    }
    renderAuth();
    // Auto-Wiedereinstieg, wenn lokales Profil gemerkt ist
    const remembered = localStorage.getItem("pst_lastProfile");
    if(remembered && state.profiles.find(p=>p.id===remembered)){
      // Header-Avatar setzen
      showHeaderAvatar(remembered);
    }
  });
}

function saveState(){
  if(dbRef) dbRef.set(state);
}

/* --------- Views Switch --------- */
function showView(id){
  qsa("section").forEach(s=> s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

/* --------- Header Avatar --------- */
function showHeaderAvatar(pid){
  const p = state.profiles.find(x=> x.id===pid);
  if(!p) return;
  const btn = $("btnHeaderProfile");
  const img = $("headerAvatar");
  img.src = p.avatarDataUrl || genDefaultAvatar(p.name||"");
  btn.classList.remove("hidden");
  btn.onclick = ()=> openProfileQuick(pid);
}

/* --------- Default Avatar (SVG) --------- */
function genDefaultAvatar(name){
  const letter = (name||"?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>
    <rect width='100%' height='100%' fill='#1a1f44'/><circle cx='32' cy='24' r='14' fill='#8b5cff'/>
    <rect x='16' y='38' width='32' height='18' rx='9' fill='#6ee7ff'/>
    <text x='32' y='60' text-anchor='middle' font-family='Arial' font-size='10' fill='#e9ecf2'>${letter}</text>
  </svg>`;
  return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));
}

/* ===========================================================
   AUTH
   =========================================================== */
function renderAuth(){
  showView("view_auth");

  // Startfläche: Registrieren + Anderes Profil
  $("linkRegister").onclick = ()=> {
    const name = prompt("Name für neues Profil:");
    if(!name) return;
    const pid = uid("p");
    state.profiles.push({id:pid, name, avatarDataUrl: genDefaultAvatar(name)});
    if(!state.profilePrefs[pid]){
      state.profilePrefs[pid] = { streakWeek: {...(state.preferences.streakWeekDefault||{})} };
    }
    saveState();
    renderAuth();
  };

  $("linkOtherProfile").onclick = ()=> showLoginList();

  $("btnLoginProfile").onclick = ()=>{
    // Wenn ein Profil gemerkt ist → Schnell-Login
    const remembered = localStorage.getItem("pst_lastProfile");
    const prof = state.profiles.find(p=> p.id===remembered);
    if(prof){
      loginProfile(prof.id);
    } else {
      showLoginList();
    }
  };

  // Auth-Grid zeigen, falls Profile existieren
  const grid = $("authList");
  grid.innerHTML = "";
  if(state.profiles.length){
    state.profiles.forEach(p=>{
      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px">
          <img class="avatar mid" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}" alt="${p.name}"/>
          <div><b>${p.name}</b><div class="sub">Tippen zum Einloggen</div></div>
        </div>`;
      card.onclick = ()=> loginProfile(p.id);
      grid.appendChild(card);
    });
    grid.style.display = "grid";
  } else {
    grid.style.display = "none";
  }
}

function showLoginList(){
  // Einfach die Grid-Liste sichtbar lassen – Nutzer tippt auf Card
  const grid = $("authList");
  grid.style.display = "grid";
}

function loginProfile(pid){
  currentProfileId = pid;
  localStorage.setItem("pst_lastProfile", pid);
  showHeaderAvatar(pid);
  renderHome();
}

/* ===========================================================
   HOME
   =========================================================== */
function renderHome(){
  showView("view_home");
  const me = state.profiles.find(p=> p.id===currentProfileId);
  $("whoPill").textContent = "Eingeloggt als: " + (me?.name || "—");

  $("btnLogout").onclick = ()=>{
    currentProfileId = null;
    showView("view_auth");
    renderAuth();
  };

  $("btnNewTournament").onclick = ()=> {
    if(!currentProfileId) return alert("Bitte zuerst einloggen.");
    const name = prompt("Turniername?");
    if(!name) return;
    const startDate = prompt("Startdatum (YYYY-MM-DD)?", todayIso()) || todayIso();
    const startChips = parseInt(prompt("Start-Chips pro Person?", "640")||"640",10);
    // Spieler auswählen (einfach): alle Profile vorab, Kommas
    const ids = prompt("Spieler-IDs (Komma, leer = alle):\n" + state.profiles.map(p=>`${p.name} (${p.id})`).join(", ")) || "";
    let players = [];
    if(ids.trim()===""){
      players = state.profiles.map(p=>p.id);
    } else {
      players = ids.split(",").map(s=>s.trim()).filter(Boolean);
    }
    if(players.length<2) return alert("Mind. 2 Spieler.");
    const t = {
      id: uid("t"),
      name, startDate,
      startChips: isNaN(startChips)? 640: startChips,
      playerCount: players.length,
      players, rounds: []
    };
    state.tournaments.push(t);
    saveState();
    openTournament(t.id);
  };

  $("btnAllTime").onclick = ()=> openAllTimeDialog();

  // Listen rendern
  const mine = $("myTournamentList"); mine.innerHTML="";
  const other= $("otherTournamentList"); other.innerHTML="";
  const list = [...state.tournaments].sort((a,b)=>(b.startDate||"").localeCompare(a.startDate||""));
  list.forEach(t=>{
    const inTour = (t.players||[]).includes(currentProfileId);
    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";
    const total = (t.playerCount||0) * (t.startChips||0);
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div>
          <h3 style="margin:0">${t.name}</h3>
          <div class="sub">Start: ${fmtDate(t.startDate)} · Spieler: ${(t.players||[]).length} · Soll: ${total}</div>
        </div>
        <div><button class="btn small">Öffnen</button></div>
      </div>`;
    card.onclick = ()=> openTournament(t.id);
    (inTour? mine: other).appendChild(card);
  });
}

/* ===========================================================
   TURNIER
   =========================================================== */
function openTournament(tid){
  currentTournamentId = tid;
  renderTournament();
}

function renderTournament(){
  showView("view_tournament");
  const t = state.tournaments.find(x=> x.id===currentTournamentId);
  if(!t) return;

  $("dashTitle").textContent = t.name;
  $("dashSub").textContent   = `Start: ${fmtDate(t.startDate)} · Spieler: ${(t.players||[]).length} · Soll: ${t.playerCount*t.startChips}`;

  $("btnBackHome").onclick = ()=> renderHome();
  $("btnTourSettings").onclick = ()=> {
    // Nur Admins aus Spielerliste? – Weiche: einfache Settings via prompt
    const newStartChips = parseInt(prompt("Start-Chips pro Person:", t.startChips)||t.startChips,10);
    const newPlayerCount = parseInt(prompt("Soll-Spielerzahl:", t.playerCount)||t.playerCount,10);
    t.startChips = isNaN(newStartChips)? t.startChips: newStartChips;
    t.playerCount= isNaN(newPlayerCount)? t.playerCount: newPlayerCount;
    saveState(); renderTournament();
  };

  // Runde hinzufügen
  $("addRoundBtn").onclick = ()=> addRoundPrompt(t);

  // Leaderboard
  renderLeaderboard(t);

  // Rundenliste
  renderRounds(t);

  // Sum-Flags
  const info = computeTournamentInfo(t);
  const ss = $("sumState");
  if(info.last){
    const {sum,total} = info.last;
    const isC = sum===total;
    ss.textContent = isC? `Letzte Runde: ${sum} / ${total}` : `Letzte Runde: ${sum} / ${total} · ${sum<total? 'unvollständig':'überschüssig'}`;
    ss.className = "pill "+(isC? "good": (sum<total? "warn":"bad"));
  } else {
    ss.textContent = "Letzte Runde: —";
    ss.className = "pill";
  }
  $("flagIncomplete").style.display = info.hasIncomplete? "": "none";
  $("flagOvershoot").style.display  = info.hasOvershoot?  "": "none";
}

function computeTournamentInfo(t){
  if(!t || !Array.isArray(t.rounds) || t.rounds.length===0){
    return { last:null, hasIncomplete:false, hasOvershoot:false, total:(t?t.playerCount*t.startChips:0) };
  }
  const sorted=[...t.rounds].sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  const last=sorted[0];
  const sum=(t.players||[]).reduce((a,pid)=> a+(+(last.values?.find(v=>v.pid===pid)?.chips||0)),0);
  const total=t.playerCount*t.startChips;
  const hasIncomplete = t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+(r.values?.find(v=>v.pid===p)?.chips||0)),0) < total);
  const hasOvershoot =  t.rounds.some(r=> (t.players||[]).reduce((a,p)=> a+(+(r.values?.find(v=>v.pid===p)?.chips||0)),0) > total);
  return { last:{sum,total}, hasIncomplete, hasOvershoot, total };
}

function renderLeaderboard(t){
  const grid = $("leaderGrid"); grid.innerHTML="";
  // Ø %Stack pro Spieler
  const totals = {}; const counts = {};
  (t.players||[]).forEach(pid=>{ totals[pid]=0; counts[pid]=0; });
  const asc=[...t.rounds].sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  asc.forEach(r=>{
    const sum=(t.players||[]).reduce((a,p)=> a+(+(r.values?.find(v=>v.pid===p)?.chips||0)),0);
    (t.players||[]).forEach(pid=>{
      const chips= +(r.values?.find(v=>v.pid===pid)?.chips||0);
      totals[pid]+=chips; counts[pid]+=1;
    });
  });
  const avgPct={};
  (t.players||[]).forEach(pid=>{
    const avgChips = counts[pid]? totals[pid]/counts[pid]: 0;
    const total = t.playerCount*t.startChips;
    avgPct[pid] = total? (avgChips/total)*100: 0;
  });
  const order = (t.players||[]).slice().sort((a,b)=> avgPct[b]-avgPct[a]);

  order.forEach((pid,i)=>{
    const p= state.profiles.find(x=>x.id===pid);
    const card = document.createElement("div");
    card.className = "card";
    const medal = i===0? "🥇": i===1? "🥈": i===2? "🥉": "";
    card.innerHTML = `
      <h3>${medal? medal+" ": ""}<img class="avatar mini" src="${p?.avatarDataUrl||genDefaultAvatar(p?.name)}"/> ${p?.name||"?"}</h3>
      <div class="sub">Ø %Stack: <b>${avgPct[pid].toFixed(1)}%</b></div>
      <div class="bar gray"><span style="width:${clamp(avgPct[pid],0,100)}%"></span></div>`;
    card.onclick = ()=> openProfileQuick(pid);
    grid.appendChild(card);
  });
}

function renderRounds(t){
  const tbody = $("roundsBody"); tbody.innerHTML="";
  const rounds = [...t.rounds].sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  const targetTotal = t.playerCount*t.startChips;

  rounds.forEach(r=>{
    const sum=(t.players||[]).reduce((acc,pid)=> acc+(+(r.values?.find(v=>v.pid===pid)?.chips||0)),0);
    const isC=sum===targetTotal; const isUnder=sum<targetTotal;
    const rowClass = isC? "row": (isUnder? "row incomplete":"row overshoot");

    // Ranking für die Runde
    const ranks = {};
    const arr=(t.players||[]).map(pid=>({pid, chips:+(r.values?.find(v=>v.pid===pid)?.chips||0)}));
    arr.sort((a,b)=> b.chips-a.chips);
    let rank=0, seen=0, prev=Infinity;
    arr.forEach(it=>{ seen++; if(it.chips!==prev){ rank=seen; prev=it.chips;} ranks[it.pid]=rank; });

    // Zeilen-HTML
    const inner=document.createElement("table"); inner.style.width="100%";
    let html="";
    arr.forEach((it,idx)=>{
      const pct = sum? (it.chips/sum*100):0;
      html += `
        <tr>
          ${idx===0? `<td style="min-width:120px;padding:0 8px 8px 8px" rowspan="${arr.length}"><b>${fmtDate(r.date)}</b></td>`:""}
          <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[it.pid]}</td>
          <td style="padding:0 8px 4px 8px">${state.profiles.find(p=>p.id===it.pid)?.name||"?"}</td>
          <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${it.chips}</b> · ${pct.toFixed(1)}%</span></td>
        </tr>`;
    });
    html += `
      <tr>
        <td colspan="3" style="padding:6px 8px 10px">
          <div class="footerFlex" style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">
            <div class="${isC?'ok': (isUnder?'':'bad')}">Rundensumme: <b>${sum}</b> / ${targetTotal} · ${isC? '✓ OK': (isUnder? '✗ Unvollständig':'✗ Überschüssig')}</div>
            <div class="sub" style="flex:1">Kommentar: ${r.comment? "• "+r.comment : "—"}</div>
            <div>
              <button class="btn small ghost" data-edit="${r.id}">Bearbeiten</button>
              <button class="btn small ghost" data-cmt="${r.id}">Kommentar</button>
              <button class="btn small danger" data-del="${r.id}">Löschen</button>
            </div>
          </div>
        </td>
      </tr>`;
    inner.innerHTML = html;

    const tr=document.createElement("tr"); tr.className=rowClass;
    const td=document.createElement("td"); td.colSpan=4; td.appendChild(inner);
    tr.appendChild(td); tbody.appendChild(tr);
  });

  // Button-Aktionen
  qsa("[data-edit]").forEach(b=> b.onclick = ()=> {
    const rid = b.getAttribute("data-edit");
    editRoundPrompt(t.id, rid);
  });
  qsa("[data-del]").forEach(b=> b.onclick = ()=> {
    const rid = b.getAttribute("data-del");
    if(confirm("Runde wirklich löschen?")){
      const i = t.rounds.findIndex(x=>x.id===rid);
      if(i>=0){ t.rounds.splice(i,1); saveState(); renderTournament(); }
    }
  });
  qsa("[data-cmt]").forEach(b=> b.onclick = ()=> {
    const rid = b.getAttribute("data-cmt");
    const r = t.rounds.find(x=> x.id===rid);
    const txt = prompt("Kommentar für diese Runde:", r.comment||"") || "";
    r.comment = txt.trim();
    saveState(); renderTournament();
  });
}

/* Runde neu (prompt-basiert, handyfreundlich) */
function addRoundPrompt(t){
  const date = prompt("Datum (YYYY-MM-DD):", todayIso()) || todayIso();
  const values=[];
  (t.players||[]).forEach(pid=>{
    const name = state.profiles.find(p=>p.id===pid)?.name || "?";
    let v = prompt(`Chips für ${name}:`, "0");
    if(v===null) v="0";
    v = v.toString().replace(",",".");
    const chips = parseInt(v,10)||0;
    values.push({pid, chips});
  });
  // Einsatz optional
  const withStake = confirm("Diese Runde MIT Einsatz? OK = Ja, Abbrechen = Nein");
  let euroPerPersonCents = null;
  if(withStake){
    let e = prompt("Einsatz pro Person (€), z.B. 10 oder 10,00:", "0");
    if(e===null) e="0";
    e = e.toString().replace(",",".");
    const euro = parseFloat(e)||0;
    euroPerPersonCents = Math.round(euro*100);
  }
  t.rounds.push({ id:uid("r"), date, values, comment:"", euroPerPersonCents });
  saveState(); renderTournament();
}

/* Runde bearbeiten */
function editRoundPrompt(tid, rid){
  const t = state.tournaments.find(x=>x.id===tid); if(!t) return;
  const r = t.rounds.find(x=>x.id===rid); if(!r) return;
  const values=[];
  (t.players||[]).forEach(pid=>{
    const name = state.profiles.find(p=>p.id===pid)?.name || "?";
    const cur = +(r.values?.find(v=>v.pid===pid)?.chips||0);
    let v = prompt(`Neue Chips für ${name}:`, String(cur));
    if(v===null) v=String(cur);
    v = v.toString().replace(",",".");
    const chips = parseInt(v,10)||0;
    values.push({pid, chips});
  });
  r.values = values;
  // Einsatz optional bearbeiten
  const hasStake = r.euroPerPersonCents!=null;
  const changeStake = confirm(`Einsatz anpassen? (aktuell: ${hasStake? (r.euroPerPersonCents/100).toFixed(2)+" €": "ohne"})`);
  if(changeStake){
    const ans = prompt("Einsatz pro Person (€) – leer für ohne:", hasStake? (r.euroPerPersonCents/100).toFixed(2): "");
    if(ans===null){
      // nichts
    } else if(ans.trim()===""){
      r.euroPerPersonCents = null;
    } else {
      const euro = parseFloat(ans.replace(",","."));
      r.euroPerPersonCents = isNaN(euro)? r.euroPerPersonCents : Math.round(euro*100);
    }
  }
  saveState(); renderTournament();
}

/* ===========================================================
   PROFIL-QUICKVIEW
   =========================================================== */
function openProfileQuick(pid){
  showView("view_profile");
  const p = state.profiles.find(x=>x.id===pid);
  if(!p){ alert("Profil fehlt"); return; }
  $("profBack").onclick = ()=> {
    // wenn aus Turnier gekommen, wieder Turnier; sonst Home
    if(currentTournamentId) renderTournament(); else renderHome();
  };
  // Scope (nur Turnier oder alle)
  const sel = $("profScopeSel");
  sel.innerHTML = `<option value="tour">Aktuelles Turnier</option><option value="all" selected>Alle Turniere</option>`;
  sel.onchange = ()=> renderProfileView(pid, sel.value);
  renderProfileView(pid, sel.value);

  $("profPdf").onclick = ()=> exportProfilePdf(pid, sel.value);
}

function collectRoundsForProfile(pid, scope){
  const rows=[];
  state.tournaments.forEach(t=>{
    if(scope==="tour" && t.id!==currentTournamentId) return;
    // nur Runden dieses Spielers
    (t.rounds||[]).forEach(r=>{
      const v = r.values?.find(x=>x.pid===pid);
      if(v){
        const sum = (t.players||[]).reduce((a,pp)=> a+(+(r.values?.find(x=>x.pid===pp)?.chips||0)),0);
        const pct = sum? (v.chips/sum*100):0;
        // Rang
        const arr=(t.players||[]).map(pp=>({pp, chips:+(r.values?.find(x=>x.pid===pp)?.chips||0)})).sort((a,b)=> b.chips-a.chips);
        let rank=0, seen=0, prev=Infinity, myRank=4;
        arr.forEach(it=>{ seen++; if(it.chips!==prev){ rank=seen; prev=it.chips; } if(it.pp===pid) myRank=rank; });
        // Geld?
        let euroDelta = null;
        if(r.euroPerPersonCents!=null){
          const participants = (t.players||[]).filter(pp => +(r.values?.find(x=>x.pid===pp)?.chips||0) > 0).length;
          const potCents = r.euroPerPersonCents * participants;
          const chipValue = sum>0? potCents / sum : 0; // cents pro chip
          euroDelta = Math.round(v.chips * chipValue - r.euroPerPersonCents)/100;
        }
        rows.push({date:r.date, tour:t.name, chips:v.chips, pct, rank:myRank, status: sum===(t.playerCount*t.startChips)?'OK': (sum<(t.playerCount*t.startChips)?'Unvollständig':'Überschüssig'), euroDelta});
      }
    });
  });
  rows.sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  return rows;
}

function renderProfileView(pid, scope){
  const p = state.profiles.find(x=>x.id===pid);
  $("profTitle").innerHTML = `<img class="avatar mid" src="${p.avatarDataUrl||genDefaultAvatar(p.name)}"/> ${p.name}`;
  // kleine Übersicht: Anzahl Turniere + Runden
  const tourCount = state.tournaments.filter(t=> (t.players||[]).includes(pid)).length;
  const roundCount = state.tournaments.reduce((acc,t)=> acc + (t.rounds||[]).filter(r=> r.values?.some(v=>v.pid===pid)).length, 0);
  $("profSub").textContent = `Teilnahme an ${tourCount} Turnier(en) · Gespielte Runden: ${roundCount}`;

  const rows = collectRoundsForProfile(pid, scope);
  const n = rows.length;
  const avgChips = n? rows.reduce((a,b)=> a+b.chips,0)/n : 0;
  const avgPct   = n? rows.reduce((a,b)=> a+b.pct,0)/n : 0;
  const dist=[1,2,3,4].map(k=> rows.filter(x=> x.rank===k).length);
  const euroGames = rows.filter(r=> r.euroDelta!=null);
  const euroSum   = euroGames.reduce((a,b)=> a+(b.euroDelta||0),0);

  // KPI-Karten
  const kpis = $("profKpis"); kpis.innerHTML="";
  const kpi = (label,val)=> {
    const d=document.createElement("div"); d.className="card";
    d.innerHTML = `<h3>${label}</h3><div class="sub" style="font-size:14px"><b>${val}</b></div>`;
    return d;
  };
  kpis.appendChild(kpi("Ø Chips/Runde", Math.round(avgChips)));
  kpis.appendChild(kpi("Ø %Stack", `${avgPct.toFixed(1)}%`));
  kpis.appendChild(kpi("🥇/🥈/🥉/🗑️", `${dist[0]} / ${dist[1]} / ${dist[2]} / ${dist[3]}`));
  kpis.appendChild(kpi("💰 Spiele mit Einsatz", `${euroGames.length} · Summe: ${euroSum.toFixed(2)} €`));

  // Sparkline
  const pv = $("pv_spark"); pv.innerHTML = "";
  const ser = [...rows].reverse().map(x=> x.pct);
  pv.innerHTML = ser.map(v=> `<span title='${v.toFixed(1)}%' style='flex:1;background:linear-gradient(180deg,#6ee7ff,#8b5cff);align-self:flex-end;height:${Math.max(4,Math.min(100,Math.round(v)))}%'></span>`).join("");

  // Tabelle
  const tbody = $("profRows"); tbody.innerHTML="";
  rows.forEach(r=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(r.date)}</td>
      <td>${r.tour}</td>
      <td>#${r.rank}</td>
      <td>${r.chips}</td>
      <td>${r.pct.toFixed(1)}%</td>
      <td>${r.status}${r.euroDelta!=null? ` · ${(r.euroDelta>=0? "+":"")}${r.euroDelta.toFixed(2)} €`: ""}</td>`;
    tbody.appendChild(tr);
  });
}

/* ===========================================================
   PDF – Profil QuickView (A4)
   =========================================================== */
async function exportProfilePdf(pid, scope){
  const p = state.profiles.find(x=>x.id===pid);
  // Lazy load libs
  await loadPdfLibs();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF("p","mm","a4");
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 12;

  // Titel
  doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.setTextColor(0);
  doc.text(`Profil-Quickview – ${p.name}`, margin, 18);
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(80);
  doc.text(`Stand: ${fmtDate(todayIso())} · Scope: ${scope==="tour"?"aktuelles Turnier":"alle Turniere"}`, margin, 24);

  let y = 30;

  // KPIs aus dem DOM (einfach Screenshot vom KPI-Card-Grid + Tabelle)
  // 1) KPI-Grid
  const kpiEl = $("profKpis");
  if(kpiEl){
    const canvas = await window.html2canvas(kpiEl, { backgroundColor:"#ffffff", scale:2 });
    const img = canvas.toDataURL("image/jpeg",0.92);
    const maxW = pageW - margin*2;
    const ratio = canvas.width/canvas.height;
    const w = maxW; const h = w/ratio;
    if(y+h>pageH-margin){ doc.addPage(); y=margin; }
    doc.addImage(img,"JPEG", margin, y, w, h, undefined, "FAST");
    y += h + 8;
  }

  // 2) Sparkline + Tabelle (Screenshot vom letzten Profil-Card Container)
  const cardEl = qs("#view_profile .card:last-of-type");
  if(cardEl){
    const canvas = await window.html2canvas(cardEl, { backgroundColor:"#ffffff", scale:2 });
    const img = canvas.toDataURL("image/jpeg",0.92);
    const maxW = pageW - margin*2;
    const ratio = canvas.width/canvas.height;
    const w = maxW; const h = w/ratio;
    if(y+h>pageH-margin){ doc.addPage(); y=margin; }
    doc.addImage(img,"JPEG", margin, y, w, h, undefined, "FAST");
    y += h + 12;
  }

  // Footer
  doc.setDrawColor(200); doc.line(margin, pageH - margin - 18, pageW - margin, pageH - margin - 18);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text("© Brenner · Poker-Stammtisch", margin, pageH - margin);

  doc.save(`poker_${p.name}_quickview_${todayIso()}.pdf`);
}

async function loadPdfLibs(){
  // einmalig laden
  if(!window.html2canvas){
    await new Promise((res,rej)=>{
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.3/dist/html2canvas.min.js";
      s.onload=res; s.onerror=rej; document.head.appendChild(s);
    });
  }
  if(!window.jspdf){
    await new Promise((res,rej)=>{
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      s.onload=res; s.onerror=rej; document.head.appendChild(s);
    });
  }
}

/* ===========================================================
   ALL-TIME – einfache Übersicht mit PDF
   =========================================================== */
function openAllTimeDialog(){
  // Schnelle Filterung: Namen (oder leer = alle)
  const sel = prompt("Spielernamen (Komma, leer = alle):", "");
  let players = state.profiles;
  if(sel && sel.trim()){
    const names = sel.split(",").map(s=> s.trim().toLowerCase());
    players = players.filter(p=> names.includes((p.name||"").toLowerCase()));
  }

  // Stats sammeln
  const stats = players.map(p=>{
    let games=0, sumChips=0, sumPct=0, cashGames=0, euroBalance=0;
    state.tournaments.forEach(t=>{
      (t.rounds||[]).forEach(r=>{
        const v = r.values?.find(x=>x.pid===p.id);
        if(v){
          games++; sumChips += v.chips;
          const sum = (t.players||[]).reduce((a,pp)=> a+(+(r.values?.find(x=>x.pid===pp)?.chips||0)),0);
          sumPct += (sum? (v.chips/sum*100):0);
          if(r.euroPerPersonCents!=null){
            cashGames++;
            const participants = (t.players||[]).filter(pp => +(r.values?.find(x=>x.pid===pp)?.chips||0) > 0).length;
            const potCents = r.euroPerPersonCents * participants;
            const chipValue = sum>0? potCents / sum : 0;
            const euroDelta = Math.round(v.chips * chipValue - r.euroPerPersonCents)/100;
            euroBalance += euroDelta;
          }
        }
      });
    });
    return {
      id:p.id, name:p.name,
      games,
      avgChips: games? sumChips/games : 0,
      avgStack: games? sumPct/games : 0,
      cashGames,
      euroBalance
    };
  });

  // Standard: nach %Stack absteigend
  stats.sort((a,b)=> b.avgStack - a.avgStack);

  // Render in Home-Container
  const container = qs(".container");
  container.innerHTML = `
    <div class="card"><h3>All-Time-Bester (aktuelle Auswahl)</h3>
      <div class="sub">Sortiert nach Ø %Stack (absteigend). PDF möglich.</div>
    </div>
    <div class="card" style="margin-top:10px">
      <table class="tbl" style="margin-top:0">
        <thead><tr>
          <th>Spieler</th><th>Spiele</th><th>Ø Chips</th><th>Ø %Stack</th><th>Cash Games</th><th>€ Bilanz</th>
        </tr></thead>
        <tbody id="allTimeRows"></tbody>
      </table>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" id="btnAllTimePdf">📄 PDF</button>
      <button class="btn secondary" id="btnBackHome2">← Übersicht</button>
    </div>`;

  const tbody = $("allTimeRows");
  tbody.innerHTML = stats.map(s=> `
    <tr>
      <td>${s.name}</td>
      <td>${s.games}</td>
      <td>${s.avgChips.toFixed(1)}</td>
      <td>${s.avgStack.toFixed(1)}%</td>
      <td>${s.cashGames}</td>
      <td>${s.euroBalance.toFixed(2)} €</td>
    </tr>`).join("");

  $("btnBackHome2").onclick = ()=> renderHome();
  $("btnAllTimePdf").onclick = async ()=>{
    await loadPdfLibs();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("p","mm","a4");
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 12;

    doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.setTextColor(0);
    doc.text(`All-Time-Bester – Auswahl`, margin, 18);
    doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(80);
    doc.text(`Stand: ${fmtDate(todayIso())}`, margin, 24);

    let y=30;
    const card = qs(".container .card:nth-of-type(2)");
    if(card){
      const canvas = await window.html2canvas(card, { backgroundColor:"#ffffff", scale:2 });
      const img = canvas.toDataURL("image/jpeg",0.92);
      const maxW = pageW - margin*2;
      const ratio = canvas.width/canvas.height;
      const w = maxW; const h = w/ratio;
      if(y+h>pageH-margin){ doc.addPage(); y=margin; }
      doc.addImage(img,"JPEG", margin, y, w, h, undefined, "FAST");
      y += h + 10;
    }

    doc.setDrawColor(200); doc.line(margin, pageH - margin - 18, pageW - margin, pageH - margin - 18);
    doc.setFontSize(9); doc.setTextColor(120);
    doc.text("© Brenner · Poker-Stammtisch", margin, pageH - margin);
    doc.save(`poker_alltime_${todayIso()}.pdf`);
  };
}

/* ===========================================================
   START
   =========================================================== */
window.addEventListener("load", async ()=>{
  // Raum aus URL
  const params = new URLSearchParams(location.search);
  roomId = params.get("room") || "stammtisch";

  await ensureAuth();
  bindRealtime();
});
