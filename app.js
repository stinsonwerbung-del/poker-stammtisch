/* ===========================================================
   Poker-Stammtisch – App-Logik mit Firebase (Realtime DB)
   =========================================================== */

// Globale Variablen
let state = { profiles: {}, tournaments: {}, streakPause: {} };
let currentProfile = null;
let currentTournament = null;
let dbRef = null;

// --- Hilfsfunktionen ---
function $(id) { return document.getElementById(id); }
function showView(id) {
  document.querySelectorAll("section").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

// --- Firebase Sync ---
function initFirebaseSync(room) {
  dbRef = firebase.database().ref("rooms/" + room + "/state");

  // Automatisch laden, wenn Daten geändert werden
  dbRef.on("value", snap => {
    if (snap.exists()) {
      state = snap.val();
      renderAll();
    }
  });
}

function saveState() {
  if (dbRef) dbRef.set(state);
}

// --- Profile ---
function renderAuth() {
  const list = $("authList");
  list.innerHTML = "";
  for (const pid in state.profiles) {
    const p = state.profiles[pid];
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.style.display = "flex";
    btn.style.flexDirection = "column";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.padding = "16px";
    btn.style.borderRadius = "14px";
    btn.innerHTML = `<div style="font-size:24px">${p.avatar || "👤"}</div><div>${p.name}</div>`;
    btn.onclick = () => { currentProfile = pid; showHome(); };
    list.appendChild(btn);
  }
  list.style.display = Object.keys(state.profiles).length ? "grid" : "none";
}

function showHome() {
  $("whoPill").textContent = "Eingeloggt als: " + (state.profiles[currentProfile]?.name || "—");
  showView("view_home");
  renderHome();
}

// Profil anlegen
$("linkRegister").onclick = () => {
  const name = prompt("Name für neues Profil:");
  if (!name) return;
  const pid = "p" + Date.now();
  state.profiles[pid] = { id: pid, name, avatar: "👤" };
  saveState();
  renderAuth();
};

// --- Home ---
function renderHome() {
  const mine = $("myTournamentList");
  const other = $("otherTournamentList");
  mine.innerHTML = other.innerHTML = "";

  for (const tid in state.tournaments) {
    const t = state.tournaments[tid];
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<b>${t.name}</b> <span class="sub">(${t.date || ""})</span>`;
    div.onclick = () => openTournament(tid);

    if (t.players && t.players.includes(currentProfile)) mine.appendChild(div);
    else other.appendChild(div);
  }
}

// Neues Turnier
$("btnNewTournament").onclick = () => {
  const name = prompt("Turniername?");
  if (!name) return;
  const tid = "t" + Date.now();
  state.tournaments[tid] = {
    id: tid,
    name,
    date: new Date().toISOString().substr(0, 10),
    startChips: 640,
    playerCount: Object.keys(state.profiles).length,
    players: [currentProfile],
    rounds: []
  };
  saveState();
  renderHome();
};

// --- Turnier ---
function openTournament(tid) {
  currentTournament = tid;
  showView("view_tournament");
  renderTournament();
}

function renderTournament() {
  const t = state.tournaments[currentTournament];
  if (!t) return;
  $("dashTitle").textContent = t.name;
  $("dashSub").textContent = `Start: ${t.date} · Spieler: ${t.players.length}`;

  // Leaderboard
  const grid = $("leaderGrid");
  grid.innerHTML = "";
  const scores = {};
  t.rounds.forEach(r => {
    r.values.forEach(v => {
      scores[v.pid] = (scores[v.pid] || 0) + v.chips;
    });
  });
  for (const pid of t.players) {
    const p = state.profiles[pid];
    const val = scores[pid] || 0;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h3>${p.name}</h3><div class="sub">Chips: ${val}</div>`;
    grid.appendChild(card);
  }

  // Runden-Tabelle
  const body = $("roundsBody");
  body.innerHTML = "";
  t.rounds.forEach(r => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.innerHTML = `
      <td>${r.date}</td>
      <td>${r.rank || ""}</td>
      <td>${r.values.map(v => state.profiles[v.pid]?.name + ": " + v.chips).join("<br>")}</td>
      <td>${r.comment || ""}</td>`;
    body.appendChild(tr);
  });
}

// Neue Runde
$("addRoundBtn").onclick = () => {
  const t = state.tournaments[currentTournament];
  if (!t) return;
  const values = [];
  for (const pid of t.players) {
    const chips = parseInt(prompt(`Chips für ${state.profiles[pid].name}?`), 10) || 0;
    values.push({ pid, chips });
  }
  t.rounds.push({
    date: new Date().toISOString().substr(0, 10),
    values
  });
  saveState();
  renderTournament();
};

// Rest auffüllen
$("btnFillRest")?.addEventListener("click", () => {
  const t = state.tournaments[currentTournament];
  if (!t) return;
  if (!t.rounds.length) return;
  const lastRound = t.rounds[t.rounds.length - 1];
  const sum = lastRound.values.reduce((a, v) => a + v.chips, 0);
  const target = t.startChips * t.playerCount;
  if (sum < target) {
    const rest = target - sum;
    lastRound.values[lastRound.values.length - 1].chips += rest;
    saveState();
    renderTournament();
  }
});

// --- Streak (Wochentage pausieren) ---
$("btnStreakSettings")?.addEventListener("click", () => {
  const dlg = $("dlgStreakSettings");
  const grid = $("weekPauseGrid");
  grid.innerHTML = "";
  const days = ["Mo","Di","Mi","Do","Fr","Sa","So"];
  days.forEach((d,i) => {
    const id = "day"+i;
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.id = id;
    chk.checked = state.streakPause?.[i] || false;
    const lbl = document.createElement("label");
    lbl.htmlFor = id;
    lbl.textContent = d;
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.appendChild(chk);
    row.appendChild(lbl);
    grid.appendChild(row);
  });
  dlg.showModal();
  $("streakSave").onclick = () => {
    state.streakPause = {};
    days.forEach((_,i) => {
      state.streakPause[i] = $("day"+i).checked;
    });
    saveState();
    dlg.close();
  };
  $("streakCancel").onclick = () => dlg.close();
});

// --- Logout ---
$("btnLogout").onclick = () => {
  currentProfile = null;
  currentTournament = null;
  showView("view_auth");
  renderAuth();
};

// --- Start ---
window.addEventListener("load", () => {
  const urlParams = new URLSearchParams(location.search);
  const room = urlParams.get("room") || "default";
  initFirebaseSync(room);
  showView("view_auth");
});
