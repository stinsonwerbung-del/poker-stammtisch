/* ===========================================================
   Poker-Stammtisch – Firebase App (v10)
   - Realtime DB Sync
   - Profile / Turniere / Runden inkl. Einsatz
   - Quick-View + PDF (A4, farbige Medaillen/Avatare/🔥, Rest grau)
   - All-Time-Bestenliste (Filter + Zeitraum)
   - Admins nur Spieler des Turniers
   - "0"-Platzhalter-Handling, kein störender Focus auf Mobile
   - "Zuletzt genutztes Profil" merken (pro Gerät)
   - Migration alter Daten
   =========================================================== */

(() => {
  "use strict";

  // ---------- Hilfen ----------
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const DEC = 2;
  const fmtPct = (v) => (v ?? 0).toFixed(2).replace('.', ',');
  const fmtMoney = (cents) => {
    const s = Math.round(cents || 0);
    const sign = s < 0 ? "-" : "";
    const abs = Math.abs(s);
    const euros = Math.floor(abs / 100);
    const cents2 = String(abs % 100).padStart(2, "0");
    return `${sign}${euros},${cents2}€`;
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  };
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const uid = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // ---------- Firebase Room ----------
  const urlParams = new URLSearchParams(location.search);
  const ROOM = urlParams.get("room") || "stammtisch"; // euer Standardraum
  const VIEWER = urlParams.get("viewer") === "1";     // nur ansehen-Modus

  // ---------- State ----------
  let state = null;
  let currentProfileId = null;
  let currentTournamentId = null;
  let dbRef = null;

  // ---------- Assets / Default Avatar ----------
  const DEFAULT_AVATAR = (() => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256' viewBox='0 0 256 256'>
    <rect width='256' height='256' fill='#0f1221'/>
    <g transform='translate(128,128)'>
      <circle r='86' fill='#e43d30'/><circle r='68' fill='#ffffff'/>
      <circle r='54' fill='#e43d30'/><circle r='24' fill='#ffffff'/>
    </g></svg>`;
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  })();

  // ---------- Script Loader (for PDF) ----------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function ensurePdfLibs() {
    if (!window.html2canvas) {
      await loadScript("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js");
    }
    if (!window.jspdf) {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    }
  }

  // ---------- Migration ----------
  function normalize(raw) {
    // Akzeptiere entweder Objekt oder Legacy-Array (alte lokale JSON)
    if (Array.isArray(raw)) {
      const profiles = [
        { id: 'p1', name: 'Lorenzo' },
        { id: 'p2', name: 'Jacki' },
        { id: 'p3', name: 'Arnold' },
        { id: 'p4', name: 'Jonny' }
      ];
      const tid = 't1';
      const rounds = (raw || []).map(r => ({
        id: uid('r'),
        date: r.date || r.datum || todayIso(),
        chips: r.chips || {},
        complete: r.complete ?? true,
        comments: []
      }));
      return {
        version: 10,
        profiles,
        tournaments: [{
          id: tid, name: 'Stammtisch',
          startDate: rounds[0]?.date || todayIso(),
          players: profiles.map(p => p.id),
          startChips: 640,
          playerCount: 4,
          admins: [],
          rounds
        }]
      };
    }
    return raw || {};
  }

  function migrate(d) {
    const out = { version: 10, profiles: [], tournaments: [], ...d };

    // Profile auf Objekt- oder Array-Form abbilden
    if (Array.isArray(out.profiles)) {
      out.profiles.forEach(p => {
        p.id = p.id || uid('p');
        p.avatarDataUrl = p.avatarDataUrl || DEFAULT_AVATAR;
        p.streakWeek = p.streakWeek || { 0: false, 1: true, 2: true, 3: true, 4: true, 5: false, 6: false }; // Mo-Fr aktiv
      });
    } else if (out.profiles && typeof out.profiles === 'object') {
      // nichts
    } else {
      out.profiles = [];
    }

    // Turniere
    out.tournaments = Array.isArray(out.tournaments) ? out.tournaments : [];
    out.tournaments.forEach(t => {
      t.id = t.id || uid('t');
      t.name = t.name || "Turnier";
      t.startDate = t.startDate || todayIso();
      t.players = Array.isArray(t.players) ? t.players : [];
      t.startChips = t.startChips || 640;
      t.playerCount = t.playerCount || (t.players?.length || 4);
      t.admins = Array.isArray(t.admins) ? t.admins : [];
      t.rounds = Array.isArray(t.rounds) ? t.rounds : [];
      t.rounds = t.rounds.map(r => ({
        id: r.id || uid('r'),
        date: r.date || todayIso(),
        chips: r.chips || {},
        complete: !!r.complete,
        comments: Array.isArray(r.comments) ? r.comments : [],
        stakeMode: r.stakeMode === 'stake' ? 'stake' : 'none',
        stakePerPersonCents: Number.isFinite(r.stakePerPersonCents) ? r.stakePerPersonCents : 0
      }));
    });

    // Profile in Objekt-Map umwandeln (für schnelleren Zugriff)
    if (Array.isArray(out.profiles)) {
      const map = {};
      out.profiles.forEach(p => map[p.id] = p);
      out.profiles = map;
    } else {
      // sicherstellen dass Pflichtfelder gesetzt sind
      Object.values(out.profiles).forEach(p => {
        p.id = p.id || uid('p');
        p.avatarDataUrl = p.avatarDataUrl || DEFAULT_AVATAR;
        p.streakWeek = p.streakWeek || { 0: false, 1: true, 2: true, 3: true, 4: true, 5: false, 6: false };
      });
    }

    return out;
  }

  // ---------- Firebase ----------
  function initFirebase() {
    const path = `rooms/${ROOM}/state`;
    dbRef = firebase.database().ref(path);
    dbRef.on("value", (snap) => {
      const val = snap.val();
      if (!val) {
        // Erstinitialisierung
        state = migrate({
          profiles: {},
          tournaments: []
        });
        saveState(); // schreibt Grundgerüst
      } else {
        const before = state;
        state = migrate(normalize(val));
        renderAll(before);
      }
    });
  }
  function saveState() {
    if (!dbRef) return;
    dbRef.set(state);
  }

  // ---------- Login & "Profil merken" ----------
  const LS_LAST_PROFILE_KEY = `pst_last_profile_${ROOM}`;
  function rememberProfile(pid) {
    try { localStorage.setItem(LS_LAST_PROFILE_KEY, pid || ""); } catch {}
  }
  function readRememberedProfile() {
    try { return localStorage.getItem(LS_LAST_PROFILE_KEY) || ""; } catch { return ""; }
  }

  // ---------- Streaks ----------
  function profilePlayedOn(pid, iso) {
    return state.tournaments.some(t =>
      (t.players || []).includes(pid) &&
      (t.rounds || []).some(r => r.date === iso && (+r.chips?.[pid] || 0) > 0)
    );
  }
  function anyPlayedOn(iso) {
    return state.tournaments.some(t => (t.rounds || []).some(r => r.date === iso));
  }
  function isWeekday(iso) {
    const d = new Date(iso + "T00:00:00");
    const w = d.getDay(); // 0 So ... 6 Sa
    return w >= 1 && w <= 5;
  }
  function computeStreaks(pid) {
    if (!pid) return { current: 0, best: 0 };
    // frühestes Datum
    const allDates = state.tournaments.flatMap(t => (t.rounds || []).map(r => r.date)).filter(Boolean).sort();
    const startIso = allDates[0] || todayIso();
    const today = todayIso();
    let cur = 0, best = 0;
    for (let d = startIso; ; ) {
      const weekday = isWeekday(d);
      const any = anyPlayedOn(d);
      const me = profilePlayedOn(pid, d);

      // nutze pro Spieler: streakWeek (welche Tage pausiert)
      const p = state.profiles[pid];
      const dow = new Date(d + "T00:00:00").getDay(); // 0..6
      const pauseDay = p?.streakWeek?.[dow] === false; // false => pausiert
      if (weekday || true) {
        if (any) {
          if (me) { cur += 1; best = Math.max(best, cur); }
          else { if (!pauseDay) cur = 0; }
        } else {
          if (!pauseDay) cur = 0;
        }
      }
      if (d === today) break;
      const nd = new Date(d + "T00:00:00"); nd.setDate(nd.getDate() + 1); d = nd.toISOString().slice(0, 10);
    }
    return { current: cur, best };
  }

  // ---------- UI: Avatar im Header ----------
  function setHeaderAvatar(pid) {
    const btn = $("btnHeaderProfile");
    const img = $("headerAvatar");
    if (!pid || !state.profiles[pid]) {
      btn.classList.add("hidden");
      return;
    }
    img.src = state.profiles[pid].avatarDataUrl || DEFAULT_AVATAR;
    btn.classList.remove("hidden");
  }

  // ---------- Render Switch ----------
  function show(viewId) {
    qsa("section").forEach(s => s.classList.add("hidden"));
    $(viewId).classList.remove("hidden");
  }

  // ---------- Einstieg ----------
  window.addEventListener("load", () => {
    initFirebase();

    // Auth Landing Events
    $("btnLoginProfile").addEventListener("click", showLoginList);
    $("linkRegister").addEventListener("click", (e) => { e.preventDefault(); registerProfileFlow(); });
    $("linkOtherProfile").addEventListener("click", (e) => { e.preventDefault(); showLoginList(true); });

    // Header Avatar → Profil-Quick-View (Profilseite)
    $("btnHeaderProfile").addEventListener("click", () => {
      if (!currentProfileId) return;
      openProfileView(currentProfileId, /*scope*/"all");
    });

    // Home
    $("btnNewTournament").addEventListener("click", newTournamentFlow);
    $("btnAllTime").addEventListener("click", openAllTime);

    // Tournament view
    $("btnBackHome").addEventListener("click", () => showHome());
    $("addRoundBtn").addEventListener("click", () => openAddRoundPrompt());
    $("btnTourSettings").addEventListener("click", openTournamentSettings);

    // Profile view
    $("profBack").addEventListener("click", () => {
      if (currentTournamentId) show("view_tournament"); else showHome();
    });
    $("profPdf").addEventListener("click", exportProfilePdf);
  });

  // ---------- Render All ----------
  function renderAll(before) {
    // Wenn noch kein Profil gewählt, prüfe „zuletzt gemerkt“
    if (!currentProfileId) {
      const remembered = readRememberedProfile();
      if (remembered && state.profiles[remembered]) {
        // zeige direkt Auth mit großem Avatar (Click → Passwort falls gesetzt)
        currentProfileId = null; // erst nach Klick setzen
      }
    }
    // Header Avatar
    setHeaderAvatar(currentProfileId);
    if (!currentProfileId) {
      show("view_auth"); renderAuth();
    } else if (!currentTournamentId) {
      showHome();
    } else {
      renderTournament();
    }
  }
  // ---------- AUTH ----------
  function renderAuth() {
    const grid = $("authList");
    grid.innerHTML = "";

    // Wenn ein „gemerktes Profil“ existiert: als große Kachel anzeigen
    const remembered = readRememberedProfile();
    if (remembered && state.profiles[remembered]) {
      grid.style.display = "grid";
      const p = state.profiles[remembered];
      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px">
          <span class="avatarWrap"><img class="avatar big" src="${p.avatarDataUrl || DEFAULT_AVATAR}" alt="${p.name}"></span>
          <div><b>${p.name}</b><div class="sub">Tippen zum Einloggen</div></div>
        </div>`;
      card.onclick = async () => {
        // Passwort abfragen, wenn vorhanden
        if (p.pwHash) {
          const pw = prompt("Passwort für " + p.name + ":");
          if (!pw) return;
          const h = await sha256Hex(pw);
          if (h !== p.pwHash) return alert("Falsches Passwort");
        }
        currentProfileId = p.id;
        rememberProfile(p.id);
        showHome();
      };
      grid.appendChild(card);
    }

    // Liste aller Profile
    Object.values(state.profiles).forEach(p => {
      const btn = document.createElement("button");
      btn.className = "btn ghost";
      btn.style.display = "flex";
      btn.style.flexDirection = "column";
      btn.style.alignItems = "center";
      btn.style.justifyContent = "center";
      btn.style.padding = "16px";
      btn.style.borderRadius = "14px";
      btn.innerHTML = `<img class="avatar mid" src="${p.avatarDataUrl || DEFAULT_AVATAR}" alt="${p.name}"/><div style="margin-top:6px">${p.name}</div>`;
      btn.onclick = async () => {
        if (p.pwHash) {
          const pw = prompt("Passwort für " + p.name + ":");
          if (!pw) return;
          const h = await sha256Hex(pw);
          if (h !== p.pwHash) return alert("Falsches Passwort");
        }
        currentProfileId = p.id;
        rememberProfile(p.id);
        showHome();
      };
      grid.appendChild(btn);
    });

    grid.style.display = Object.keys(state.profiles).length ? "grid" : "none";
  }

  async function sha256Hex(str) {
    if (window.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback
    let h = 0; for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function registerProfileFlow() {
    const name = prompt("Name für neues Profil:");
    if (!name) return;
    const withPw = confirm("Passwort setzen?");
    let pwHash = null;
    if (withPw) {
      const p1 = prompt("Neues Passwort (mind. 4 Zeichen)");
      if (!p1 || p1.length < 4) return alert("Zu kurz");
      const p2 = prompt("Passwort wiederholen");
      if (p1 !== p2) return alert("Nicht gleich");
      sha256Hex(p1).then(h => {
        pwHash = h;
        createProfile(name, pwHash);
      });
    } else {
      createProfile(name, null);
    }
  }

  function createProfile(name, pwHash) {
    const pid = uid('p');
    state.profiles[pid] = {
      id: pid,
      name,
      pwHash,
      avatarDataUrl: DEFAULT_AVATAR,
      streakWeek: { 0:false,1:true,2:true,3:true,4:true,5:false,6:false }
    };
    saveState();
    renderAuth();
  }

  // ---------- HOME ----------
  function showHome() {
    if (!currentProfileId) { show("view_auth"); renderAuth(); return; }
    $("whoPill").textContent = "Eingeloggt als: " + (state.profiles[currentProfileId]?.name || "—");
    setHeaderAvatar(currentProfileId);
    show("view_home");
    renderHome();
  }

  function renderHome() {
    const mine = $("myTournamentList");
    const other = $("otherTournamentList");
    mine.innerHTML = other.innerHTML = "";

    const list = [...state.tournaments].sort((a,b) => (b.startDate||"").localeCompare(a.startDate||""));

    list.forEach(t => {
      const inTour = (t.players || []).includes(currentProfileId);
      const total = (t.playerCount || 0) * (t.startChips || 0);
      const names = (t.players || []).map(pid => state.profiles[pid]?.name || "?").join(", ");

      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      card.style.padding = "14px";
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div>
            <h3 style="margin:0">${t.name}</h3>
            <div class="sub">Start: ${fmtDate(t.startDate)} · Spieler: ${names} · Soll: ${total}</div>
          </div>
          <div><button class="btn small">Öffnen</button></div>
        </div>`;
      card.onclick = () => openTournament(t.id);

      (inTour ? mine : other).appendChild(card);
    });
  }

  function newTournamentFlow() {
    if (!currentProfileId) return alert("Bitte zuerst einloggen.");
    const name = prompt("Name des Turniers?");
    if (!name) return;
    const date = prompt("Startdatum (YYYY-MM-DD)?", todayIso()) || todayIso();
    const startChips = Math.max(1, parseInt(prompt("Start-Chips pro Person?", "640") || "640", 10));
    const playerCount = Math.max(2, parseInt(prompt("Spielerzahl (für Soll)?", "4") || "4", 10));

    // Spieler wählen (einfach alle existierenden anzeigen)
    const allPlayers = Object.values(state.profiles);
    const chosen = allPlayers.filter(p => confirm(`Nimmt ${p.name} teil?`)).map(p => p.id);
    if (chosen.length < 2) return alert("Mindestens 2 Spieler.");

    const t = {
      id: uid('t'),
      name, startDate: date, players: chosen,
      startChips, playerCount,
      admins: [currentProfileId],
      rounds: []
    };
    state.tournaments.push(t);
    saveState();
    openTournament(t.id);
  }

  // ---------- TOURNAMENT ----------
  function openTournament(tid) {
    currentTournamentId = tid;
    show("view_tournament");
    renderTournament();
  }

  function computeTournamentInfo(t) {
    if (!t || !Array.isArray(t.rounds) || t.rounds.length === 0) {
      return { last: null, hasIncomplete: false, hasOvershoot: false, total: (t ? t.playerCount * t.startChips : 0) };
    }
    const sorted = [...t.rounds].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const last = sorted[0];
    const sum = (t.players || []).reduce((a, p) => a + (+last.chips?.[p] || 0), 0);
    const total = t.playerCount * t.startChips;
    const hasIncomplete = t.rounds.some(r => (t.players || []).reduce((a, p) => a + (+r.chips?.[p] || 0), 0) < total);
    const hasOvershoot = t.rounds.some(r => (t.players || []).reduce((a, p) => a + (+r.chips?.[p] || 0), 0) > total);
    return { last: { sum, total }, hasIncomplete, hasOvershoot, total };
  }

  function rankCompetition(items) {
    const s = [...items].sort((a, b) => b.value - a.value);
    let rank = 0, seen = 0, prev = Infinity;
    const map = {};
    for (const it of s) {
      seen++;
      if (it.value !== prev) { rank = seen; prev = it.value; }
      map[it.name] = rank;
    }
    return map;
  }

  function computeTournamentStats(t) {
    const totals = {}, counts = {}, avgPct = {}, avgChips = {};
    (t.players || []).forEach(pid => { totals[pid] = 0; counts[pid] = 0; });
    const asc = [...t.rounds].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    asc.forEach(r => {
      const sum = (t.players || []).reduce((a, p) => a + (+r.chips?.[p] || 0), 0);
      (t.players || []).forEach(pid => {
        totals[pid] += (+r.chips?.[pid] || 0);
        counts[pid] += 1;
      });
    });
    (t.players || []).forEach(pid => {
      avgChips[pid] = counts[pid] ? totals[pid] / counts[pid] : 0;
      const maxRoundTotal = (t.playerCount * t.startChips) || 1;
      avgPct[pid] = (avgChips[pid] / maxRoundTotal) * 100;
    });
    const overallRank = rankCompetition((t.players || []).map(pid => ({ name: pid, value: avgPct[pid] })));
    return { players: (t.players || []).map(pid => ({
      id: pid,
      name: state.profiles[pid]?.name || "?",
      avgPct: avgPct[pid] || 0,
      avgChips: avgChips[pid] || 0,
      rank: overallRank[pid] || 4
    })) };
  }

  function renderTournament() {
    const t = state.tournaments.find(x => x.id === currentTournamentId);
    if (!t) return;

    $("dashTitle").textContent = t.name;
    $("dashSub").textContent = `Start: ${fmtDate(t.startDate)} · Spieler: ${(t.players || []).map(pid => state.profiles[pid]?.name || "?").join(", ")} · Soll: ${t.playerCount * t.startChips}`;

    // Status
    const info = computeTournamentInfo(t);
    const ss = $("sumState");
    if (info.last) {
      const { sum, total } = info.last;
      const isC = sum === total;
      ss.textContent = isC ? `Letzte Runde: ${sum} / ${total}` :
        `Letzte Runde: ${sum} / ${total} · ${sum < total ? 'unvollständig' : 'überschüssig'}`;
      ss.className = 'pill ' + (isC ? 'good' : (sum < total ? 'warn' : 'bad'));
    } else {
      ss.textContent = 'Letzte Runde: —';
      ss.className = 'pill';
    }
    $("flagIncomplete").style.display = info.hasIncomplete ? "" : "none";
    $("flagOvershoot").style.display = info.hasOvershoot ? "" : "none";

    // Leaderboard
    const stats = computeTournamentStats(t);
    const leader = $("leaderGrid");
    leader.innerHTML = "";
    stats.players.sort((a, b) => a.rank - b.rank).forEach(c => {
      const medal = c.rank === 1 ? '🥇' : c.rank === 2 ? '🥈' : c.rank === 3 ? '🥉' : '';
      const stBest = computeStreaks(c.id).best;
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>${medal ? medal + ' ' : ''}<img class="avatar mini" src="${state.profiles[c.id]?.avatarDataUrl || DEFAULT_AVATAR}"> ${c.name}</h3>
        <div class="sub">Ø Chips: <b>${Math.round(c.avgChips)}</b> · Ø %Stack: <b>${fmtPct(c.avgPct)}</b>%</div>
        <div class="rankRow"><div>Platz <b>${c.rank}</b></div><div class="sub">Best 🔥 ${stBest}</div></div>
        <div class="bar gray"><span style="width:${clamp(c.avgPct,0,100)}%"></span></div>`;
      card.style.cursor = "pointer";
      card.addEventListener("click", () => openProfileView(c.id, /*scope*/ t.id));
      leader.appendChild(card);
    });

    // Runden
    const tbody = $("roundsBody"); tbody.innerHTML = "";
    const rounds = [...t.rounds].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const targetTotal = t.playerCount * t.startChips;

    rounds.forEach(r => {
      const sum = (t.players || []).reduce((acc, pid) => acc + (+r.chips?.[pid] || 0), 0);
      const isC = sum === targetTotal; const isUnder = sum < targetTotal;
      const rowClass = isC ? 'row' : (isUnder ? 'row incomplete' : 'row overshoot');
      const ranks = rankCompetition((t.players || []).map(pid => ({ name: pid, value: +(+r.chips?.[pid] || 0) })));
      const order = (t.players || []).slice().sort((a, b) => ranks[a] - ranks[b]);

      const tr = document.createElement("tr"); tr.className = rowClass;
      const td = document.createElement("td"); td.colSpan = 4;

      let html = `<table style="width:100%"><tbody>`;
      order.forEach((pid, idx) => {
        const pct = sum ? ((+r.chips?.[pid] || 0) / sum * 100) : 0;
        if (idx === 0) {
          html += `<tr>
            <td style="min-width:120px;padding:0 8px 8px 8px" rowspan="${order.length}"><b>${fmtDate(r.date)}</b>${r.stakeMode==='stake' ? ' <span class="pill warn">Mit Einsatz</span>':''}</td>
            <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[pid]}</td>
            <td style="padding:0 8px 4px 8px">${state.profiles[pid]?.name||'?'}</td>
            <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${r.chips?.[pid]||0}</b> · ${fmtPct(pct)}%</span></td>
          </tr>`;
        } else {
          html += `<tr>
            <td style="min-width:150px;padding:0 8px 4px 8px">#${ranks[pid]}</td>
            <td style="padding:0 8px 4px 8px">${state.profiles[pid]?.name||'?'}</td>
            <td style="min-width:260px;padding:0 8px 4px 8px"><span class="sub"><b>${r.chips?.[pid]||0}</b> · ${fmtPct(pct)}%</span></td>
          </tr>`;
        }
      });

      // Einsatz-Berechnung (falls aktiv)
      let moneyLine = '';
      if (r.stakeMode === 'stake' && r.stakePerPersonCents > 0) {
        const participants = order.filter(pid => (+r.chips?.[pid] || 0) > 0);
        const pot = participants.length * r.stakePerPersonCents;
        const chipValue = sum ? pot / sum : 0;
        // Summe je Spieler
        const moneyRows = order.map(pid => {
          const chips = (+r.chips?.[pid] || 0);
          const val = Math.round(chips * chipValue) - (participants.includes(pid) ? r.stakePerPersonCents : 0);
          return { pid, val };
        });
        const sumVal = moneyRows.reduce((a, x) => a + x.val, 0);
        moneyLine = `<div class="sub">Einsatz: ${fmtMoney(r.stakePerPersonCents)} · Spieler: ${participants.length} · Pot: ${fmtMoney(pot)} · Chip: ${chipValue ? chipValue.toFixed(4) : '0'}€ · Summe Geld: ${fmtMoney(sumVal)}</div>`;
      }

      html += `
        <tr>
          <td colspan="3" style="padding:6px 8px 10px">
            <div class="sub">Kommentar: ${(r.comments && r.comments.length) ? r.comments.map(c => `• ${c.text}`).join(' \u00A0 ') : '—'}</div>
          </td>
          <td style="padding:6px 8px 10px">
            <div class="${isC ? 'ok' : (isUnder ? '' : 'bad')}">Summe: <b>${sum}</b> / ${targetTotal} · ${isC ? 'OK' : (isUnder ? 'Unvollständig' : 'Überschüssig')}</div>
            ${moneyLine}
            <div style="margin-top:6px; display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap">
              ${isTournamentAdmin(t) ? `<button class="btn small ghost" data-edit="${r.id}">Bearbeiten</button>` : ''}
              ${isTournamentAdmin(t) ? `<button class="btn small ghost" data-cmt="${r.id}">Kommentar</button>` : ''}
              ${isTournamentAdmin(t) ? `<button class="btn small danger" data-del="${r.id}">Löschen</button>` : ''}
            </div>
          </td>
        </tr>
      </tbody></table>`;
      td.innerHTML = html;
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    // Bind Buttons
    qsa("[data-edit]").forEach(b => b.addEventListener("click", () => openEditRoundPrompt(t.id, b.getAttribute("data-edit"))));
    qsa("[data-del]").forEach(b => b.addEventListener("click", () => deleteRound(t.id, b.getAttribute("data-del"))));
    qsa("[data-cmt]").forEach(b => b.addEventListener("click", () => editComment(t.id, b.getAttribute("data-cmt"))));
  }

  function isTournamentAdmin(t) {
    return !!(t.admins || []).includes(currentProfileId);
  }

  // Turnier-Einstellungen: Admins nur aus Spielern
  function openTournamentSettings() {
    const t = state.tournaments.find(x => x.id === currentTournamentId);
    if (!t) return;
    if (!isTournamentAdmin(t)) return alert("Nur Turnier-Admin.");
    const sc = Math.max(1, parseInt(prompt("Start-Chips pro Person:", String(t.startChips)) || String(t.startChips), 10));
    const pc = Math.max(2, parseInt(prompt("Soll-Spielerzahl:", String(t.playerCount)) || String(t.playerCount), 10));

    // Admins wählen (nur Spieler anzeigen)
    const newAdmins = (t.players || []).filter(pid => confirm(`Soll ${state.profiles[pid]?.name} Admin sein?`));
    t.startChips = sc; t.playerCount = pc; t.admins = newAdmins;
    saveState();
    renderTournament();
  }

  // ---------- Runden: Neu / Bearbeiten / Kommentar / Löschen ----------
  function openAddRoundPrompt() {
    const t = state.tournaments.find(x => x.id === currentTournamentId);
    if (!t) return;
    if (!isTournamentAdmin(t)) return alert("Nur Turnier-Admin.");

    const date = prompt("Datum (YYYY-MM-DD):", todayIso()) || todayIso();

    // Modus
    const mode = confirm("Mit Einsatz? OK=Ja / Abbrechen=Nein") ? 'stake' : 'none';
    let stakeCents = 0;
    if (mode === 'stake') {
      const euro = prompt("Einsatz pro Person (z.B. 2,50):", "0,00") || "0,00";
      stakeCents = parseMoneyToCents(euro);
    }

    const chips = {};
    (t.players || []).forEach(pid => {
      const placeholder = "0"; // „0“-Platzhalter
      let val = prompt(`Chips für ${state.profiles[pid]?.name} (leer=0):`, placeholder);
      if (val === null) val = "0";
      val = val.trim();
      if (val === "" || val === "0") chips[pid] = 0;
      else chips[pid] = parseInt(val, 10) || 0;
    });

    const sum = Object.values(chips).reduce((a, b) => a + b, 0);
    const complete = (sum === t.playerCount * t.startChips);
    const r = { id: uid('r'), date, chips, complete, comments: [], stakeMode: mode, stakePerPersonCents: stakeCents };
    t.rounds.push(r);
    saveState();
    renderTournament();
  }

  function openEditRoundPrompt(tid, rid) {
    const t = state.tournaments.find(x => x.id === tid);
    if (!t) return;
    if (!isTournamentAdmin(t)) return alert("Nur Turnier-Admin.");
    const r = t.rounds.find(x => x.id === rid);
    if (!r) return;

    const date = prompt("Datum (YYYY-MM-DD):", r.date) || r.date;

    const mode = confirm("Mit Einsatz? OK=Ja / Abbrechen=Nein") ? 'stake' : 'none';
    let stakeCents = r.stakePerPersonCents || 0;
    if (mode === 'stake') {
      const euro = prompt("Einsatz pro Person (z.B. 2,50):", r.stakePerPersonCents ? centsToInput(r.stakePerPersonCents) : "0,00") || "0,00";
      stakeCents = parseMoneyToCents(euro);
    }

    const chips = {};
    (t.players || []).forEach(pid => {
      const old = +r.chips?.[pid] || 0;
      let val = prompt(`Chips für ${state.profiles[pid]?.name}:`, String(old));
      if (val === null) val = String(old);
      val = val.trim();
      if (val === "" || val === "0") chips[pid] = 0;
      else chips[pid] = parseInt(val, 10) || 0;
    });

    const sum = Object.values(chips).reduce((a, b) => a + b, 0);
    const complete = (sum === t.playerCount * t.startChips);

    Object.assign(r, { date, chips, complete, stakeMode: mode, stakePerPersonCents: stakeCents });
    saveState();
    renderTournament();
  }

  function editComment(tid, rid) {
    const t = state.tournaments.find(x => x.id === tid);
    if (!t) return;
    if (!isTournamentAdmin(t)) return alert("Nur Turnier-Admin.");
    const r = t.rounds.find(x => x.id === rid);
    if (!r) return;
    const prev = (r.comments && r.comments[0]?.text) || "";
    const txt = prompt("Kommentar (kurze Notiz…)", prev) || "";
    r.comments = txt.trim() ? [{ by: currentProfileId, at: new Date().toISOString(), text: txt.trim() }] : [];
    saveState();
    renderTournament();
  }

  function deleteRound(tid, rid) {
    const t = state.tournaments.find(x => x.id === tid);
    if (!t) return;
    if (!isTournamentAdmin(t)) return alert("Nur Turnier-Admin.");
    if (!confirm("Runde wirklich löschen?")) return;
    t.rounds = t.rounds.filter(r => r.id !== rid);
    saveState();
    renderTournament();
  }

  function parseMoneyToCents(str) {
    const s = (str || "").trim().replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
    const v = parseFloat(s);
    if (!isFinite(v)) return 0;
    return Math.round(v * 100);
  }
  function centsToInput(c) {
    const s = Math.round(c || 0);
    const euros = Math.floor(s / 100);
    const cents = String(s % 100).padStart(2, "0");
    return `${euros},${cents}`;
  }

  // ---------- PROFILE VIEW ----------
  function openProfileView(pid, scope) {
    show("view_profile");
    const p = state.profiles[pid];
    if (!p) return;
    $("profTitle").innerHTML = `<img class="avatar mid" src="${p.avatarDataUrl || DEFAULT_AVATAR}"> ${p.name}`;
    // kleine Übersicht: Anzahl Turniere, Runden
    const myTours = state.tournaments.filter(t => (t.players || []).includes(pid));
    const roundsCount = myTours.reduce((acc, t) => acc + (t.rounds?.length || 0), 0);
    $("profSub").textContent = `Teilnahme an ${myTours.length} Turnier(en) · Runden: ${roundsCount}`;

    // Scope füllen
    const sel = $("profScopeSel");
    sel.innerHTML = `<option value="all">Gesamt (alle Turniere)</option>` +
      state.tournaments.map(t => `<option value="${t.id}" ${scope===t.id?'selected':''}>${t.name}</option>`).join('');
    sel.onchange = () => renderProfileTable(pid, sel.value);
    renderProfileTable(pid, scope || "all");
  }

  function renderProfileTable(pid, scope) {
    const rows = [];
    state.tournaments.forEach(t => {
      if (scope !== "all" && scope !== t.id) return;
      if (!(t.players || []).includes(pid)) return;
      (t.rounds || []).forEach(r => {
        const sum = (t.players || []).reduce((a, pp) => a + (+r.chips?.[pp] || 0), 0);
        const pct = sum ? ((+r.chips?.[pid] || 0) / sum * 100) : 0;
        const ranks = rankCompetition((t.players || []).map(pp => ({ name: pp, value: +(+r.chips?.[pp] || 0) })));
        const rank = ranks[pid] || 4;
        rows.push({
          date: r.date, tour: t.name, rank, chips: (+r.chips?.[pid] || 0),
          pct, status: sum === (t.playerCount * t.startChips) ? 'OK' : (sum < (t.playerCount * t.startChips) ? 'Unvollständig' : 'Überschüssig'),
          stake: r.stakeMode === 'stake',
          stakeCents: r.stakePerPersonCents || 0,
          t, r
        });
      });
    });
    rows.sort((a,b) => (b.date||"").localeCompare(a.date||""));

    const tbody = $("profRows"); tbody.innerHTML = rows.map(r => {
      return `<tr>
        <td>${fmtDate(r.date)}</td>
        <td>${r.tour}${r.stake ? ' <span class="pill warn">€</span>':''}</td>
        <td>#${r.rank}</td>
        <td>${r.chips}</td>
        <td>${fmtPct(r.pct)}%</td>
        <td>${r.status}</td>
      </tr>`;
    }).join('');

    // %Stack Verlauf (Spark)
    const ser = [...rows].reverse().map(x => x.pct);
    const pv = $("pv_spark");
    pv.innerHTML = ser.map(pv => `<span title='${fmtPct(pv)}%' style='flex:1;align-self:flex-end;height:${Math.max(4, Math.min(100, Math.round(pv)))}%'></span>`).join('');
  }

  // ---------- PDF Export (Profil / Quick-View) ----------
  async function exportProfilePdf() {
    await ensurePdfLibs();
    const { jsPDF } = window.jspdf;

    // Wir rendern A4 (595x842 pt) im Hochformat
    const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageW = 595, pageH = 842;
    const margin = 24;
    let y = margin;

    const p = state.profiles[currentProfileId];
    if (!p) return;

    // Kopf: Avatar farbig, Name (schwarz), kleine Kennzahlen
    const img = p.avatarDataUrl || DEFAULT_AVATAR;
    try {
      doc.addImage(img, "JPEG", margin, y, 48, 48, undefined, "FAST");
    } catch {
      try { doc.addImage(img, "PNG", margin, y, 48, 48, undefined, "FAST"); } catch {}
    }
    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text(p.name, margin + 60, y + 20);
    // Kennzahlen
    const myTours = state.tournaments.filter(t => (t.players || []).includes(currentProfileId));
    const roundsCount = myTours.reduce((acc, t) => acc + (t.rounds?.length || 0), 0);
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    doc.setTextColor(80);
    doc.text(`Turniere: ${myTours.length} · Runden: ${roundsCount}`, margin + 60, y + 38);
    y += 60;

    // Tabelle (aktuelle Profilansicht): wir screenshotten den Table-Bereich in Grau
    const cardEl = qs("#view_profile .card:last-of-type"); // der Tabellen-Card
    if (cardEl) {
      // Temporär Grau-Theme erzwingen (CSS schon gray bars)
      const canvas = await window.html2canvas(cardEl, { backgroundColor: "#ffffff", scale: 2 });
      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const maxW = pageW - margin * 2;
      const ratio = canvas.width / canvas.height;
      const w = maxW;
      const h = w / ratio;
      if (y + h > pageH - margin) { doc.addPage(); y = margin; }
      doc.addImage(imgData, "JPEG", margin, y, w, h, undefined, "FAST");
      y += h + 12;
    }

    // Footer
    doc.setDrawColor(200); doc.line(margin, pageH - margin - 18, pageW - margin, pageH - margin - 18);
    doc.setFontSize(9); doc.setTextColor(120);
    doc.text("© Brenner · Poker-Stammtisch", margin, pageH - margin);

    doc.save(`poker_${p.name}_quickview_${todayIso()}.pdf`);
  }
// =====================
// Teil 3/3 – Features + Export
// =====================

// ---------------------
// Runde bearbeiten
// ---------------------
function editRound(tourId, roundId) {
  const tour = state.tournaments.find(t => t.id === tourId);
  if (!tour) return;
  const round = tour.rounds.find(r => r.id === roundId);
  if (!round) return;

  // Dialog wiederverwenden
  const dlg = document.getElementById("dlgRound");
  const form = document.getElementById("roundForm");
  form.innerHTML = "";

  tour.players.forEach(pid => {
    const prof = state.profiles.find(p => p.id === pid);
    const val = round.results[pid] || 0;
    form.innerHTML += `
      <label>${prof.name}
        <input type="number" id="roundInput_${pid}" value="${val}" />
      </label>`;
  });

  document.getElementById("dlgRoundTitle").textContent = "Runde bearbeiten";
  dlg.showModal();

  document.getElementById("roundSave").onclick = () => {
    tour.players.forEach(pid => {
      const inp = document.getElementById("roundInput_" + pid);
      round.results[pid] = parseInt(inp.value || 0, 10);
    });
    saveState();
    dlg.close();
    renderTournament(tourId);
  };

  document.getElementById("roundCancel").onclick = () => dlg.close();
}

// ---------------------
// All-Time Übersicht
// ---------------------
function showAllTime() {
  // Spieler auswählen
  const sel = prompt("IDs der Spieler kommasepariert (z.B. p1,p2,p3). Leer = alle");
  let players = state.profiles;
  if (sel && sel.trim().length > 0) {
    const ids = sel.split(",").map(s => s.trim());
    players = players.filter(p => ids.includes(p.id));
  }

  // Daten sammeln
  const stats = players.map(p => {
    let games = 0, sumChips = 0, sumStack = 0, cashGames = 0, euroBalance = 0;
    state.tournaments.forEach(t => {
      t.rounds.forEach(r => {
        if (r.results[p.id] != null) {
          games++;
          sumChips += r.results[p.id];
          if (t.startChips) {
            sumStack += r.results[p.id] / (t.startChips * t.players.length);
          }
          if (r.euroPerPlayer) {
            cashGames++;
            const euro = (r.results[p.id] / (t.startChips * t.players.length)) * r.euroPerPlayer * t.players.length - r.euroPerPlayer;
            euroBalance += euro;
          }
        }
      });
    });
    return {
      id: p.id,
      name: p.name,
      games,
      avgChips: games > 0 ? (sumChips / games) : 0,
      avgStack: games > 0 ? (sumStack / games) * 100 : 0,
      cashGames,
      euroBalance
    };
  });

  // Sortieren nach %Stack
  stats.sort((a, b) => b.avgStack - a.avgStack);

  // Tabelle bauen
  let html = `<h2>All-Time Übersicht</h2>
    <table class="tbl"><thead><tr>
      <th>Spieler</th><th>Spiele</th><th>Ø Chips</th><th>Ø %Stack</th><th>Cash Games</th><th>€ Bilanz</th>
    </tr></thead><tbody>`;
  stats.forEach(s => {
    html += `<tr>
      <td>${s.name}</td>
      <td>${s.games}</td>
      <td>${s.avgChips.toFixed(1)}</td>
      <td>${s.avgStack.toFixed(1)}%</td>
      <td>${s.cashGames}</td>
      <td>${s.euroBalance.toFixed(2)} €</td>
    </tr>`;
  });
  html += "</tbody></table>";

  const container = document.querySelector(".container");
  container.innerHTML = html + `<div style="margin-top:10px">
    <button class="btn secondary" onclick="renderHome()">← Zurück</button>
    <button class="btn" onclick="exportPdf('All-Time Übersicht', document.querySelector('.container').innerHTML)">📄 PDF</button>
  </div>`;
}

// ---------------------
// PDF Export mit jsPDF
// ---------------------
function exportPdf(title, htmlContent) {
  import("https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.3/dist/html2canvas.min.js")
    .then(() => import("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"))
    .then(() => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF("p", "mm", "a4");
      doc.html(`<h2>${title}</h2>` + htmlContent, {
        callback: function (doc) {
          doc.save(title + ".pdf");
        },
        x: 10,
        y: 10,
        width: 190
      });
    });
}

// ---------------------
// Initialisierung
// ---------------------
window.addEventListener("load", () => {
  loadState();

  // Eventlistener binden
  document.getElementById("btnNewTournament").onclick = () => newTournament();
  document.getElementById("btnBackHome").onclick = () => renderHome();
  document.getElementById("btnAllTime").onclick = () => showAllTime();
  document.getElementById("profBack").onclick = () => renderHome();
  document.getElementById("profPdf").onclick = () => {
    const html = document.getElementById("view_profile").innerHTML;
    exportPdf("Profil Übersicht", html);
  };
});
