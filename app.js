/* Enduro Crono — beta
   Cronometro offline per allenamenti enduro.
   Tutti i dati restano sul telefono (localStorage). */
'use strict';

const STORE_KEY = 'ec.v1';
const NEAR_METERS = 600;       // una pista "nota" entro questa distanza viene proposta
const DEBOUNCE_MS = 350;       // evita doppi tocchi accidentali sullo stesso pilota

/* ---------- dati ---------- */

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      d.sessions ||= []; d.riderNames ||= []; d.tracks ||= [];
      return d;
    }
  } catch (e) { console.error(e); }
  return { sessions: [], riderNames: [], tracks: [] };
}

let db = load();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { toast('Errore di salvataggio: memoria piena?'); }
}

function getSession(id) { return db.sessions.find(s => s.id === id); }

function rememberRider(name) {
  const n = name.trim();
  if (!n) return;
  db.riderNames = [n, ...db.riderNames.filter(x => x.toLowerCase() !== n.toLowerCase())].slice(0, 40);
}

function rememberTrack(track) {
  if (!track.name) return;
  const existing = db.tracks.find(t => t.name.toLowerCase() === track.name.toLowerCase());
  if (existing) {
    if (track.lat != null && existing.lat == null) { existing.lat = track.lat; existing.lon = track.lon; }
    existing.lastUsed = Date.now();
  } else {
    db.tracks.push({ name: track.name, lat: track.lat ?? null, lon: track.lon ?? null, lastUsed: Date.now() });
  }
}

/* ---------- utilità ---------- */

function fmt(ms) {
  if (ms == null || isNaN(ms)) return '–';
  ms = Math.max(0, Math.round(ms));
  const cs = Math.floor(ms / 10) % 100;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  const p2 = n => String(n).padStart(2, '0');
  return h ? `${h}:${p2(m)}:${p2(s)}.${p2(cs)}` : `${m}:${p2(s)}.${p2(cs)}`;
}

function fmtDelta(ms) {
  if (!ms) return '';
  return '+' + (ms >= 60000 ? fmt(ms) : (ms / 1000).toFixed(2) + 's');
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function distMeters(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// istante preciso del tocco (non quando il codice gira)
function eventTime(e) {
  if (e && e.timeStamp && performance.timeOrigin) {
    const t = performance.timeOrigin + e.timeStamp;
    if (Math.abs(t - Date.now()) < 2000) return t;
  }
  return Date.now();
}

function stats(runs) {
  const times = runs.map(r => r.ms);
  if (!times.length) return { count: 0, total: 0, best: null, worst: null, avg: null };
  const total = times.reduce((a, b) => a + b, 0);
  return { count: times.length, total, best: Math.min(...times), worst: Math.max(...times), avg: total / times.length };
}

function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} }

let toastTimer;
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="toast-action">${esc(action.label)}</button>` : '');
  el.hidden = false;
  if (action) el.querySelector('.toast-action').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 2600);
}

function openModal(html, onMount) {
  const m = document.getElementById('modal');
  document.getElementById('modalBody').innerHTML = html;
  m.hidden = false;
  m.onclick = e => { if (e.target === m) closeModal(); };
  onMount && onMount(document.getElementById('modalBody'));
}
function closeModal() { document.getElementById('modal').hidden = true; }

function confirmBox(text, okLabel, onOk, danger = true) {
  openModal(`
    <p class="modal-text">${esc(text)}</p>
    <div class="row gap">
      <button class="btn ghost" data-x="no">Annulla</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${esc(okLabel)}</button>
    </div>`, body => {
    body.querySelector('[data-x=no]').onclick = closeModal;
    body.querySelector('[data-x=ok]').onclick = () => { closeModal(); onOk(); };
  });
}

/* ---------- navigazione ---------- */

const app = document.getElementById('app');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('subtitle');
const backBtn = document.getElementById('backBtn');

function route() {
  const h = location.hash.slice(1);
  const [view, id, tab] = h.split('/');
  stopTicker();
  if (view === 'new') return viewNew();
  if (view === 's' && getSession(id)) return viewSession(id, tab || 'crono');
  return viewHome();
}
window.addEventListener('hashchange', route);
backBtn.onclick = () => { location.hash = ''; };

function setHeader(title, sub, back) {
  titleEl.textContent = title;
  subEl.textContent = sub || '';
  subEl.hidden = !sub;
  backBtn.hidden = !back;
}

/* ---------- HOME ---------- */

function viewHome() {
  setHeader('Enduro Crono', '', false);
  const sessions = [...db.sessions].sort((a, b) => b.createdAt - a.createdAt);
  const list = sessions.map(s => {
    const runs = s.riders.reduce((n, r) => n + r.runs.length, 0);
    const running = s.riders.some(r => r.startedAt);
    return `
      <a class="card session-card" href="#s/${s.id}">
        <div class="session-top">
          <strong>${esc(s.track.name || 'Pista senza nome')}</strong>
          ${running ? '<span class="pill live">IN CORSO</span>' : ''}
        </div>
        <div class="muted">${fmtDate(s.createdAt)}</div>
        <div class="muted small">${s.riders.length} ${s.riders.length === 1 ? 'pilota' : 'piloti'} · ${runs} ${runs === 1 ? 'tempo' : 'tempi'}${s.track.lat != null ? ' · 📍' : ''}</div>
      </a>`;
  }).join('');

  app.innerHTML = `
    <button class="btn primary big" id="newBtn">+ Nuova sessione</button>
    ${sessions.length ? `<h2 class="section">Sessioni</h2>${list}` : `
      <div class="empty">
        <p><strong>Nessuna sessione ancora.</strong></p>
        <p class="muted">Crea una sessione, aggiungi i piloti e premi START quando partono. Funziona anche senza segnale: i tempi restano salvati sul telefono.</p>
      </div>`}
    <p class="footnote">Versione beta · dati salvati solo su questo telefono</p>`;
  document.getElementById('newBtn').onclick = () => { location.hash = 'new'; };
}

/* ---------- NUOVA SESSIONE ---------- */

function viewNew() {
  setHeader('Nuova sessione', '', true);
  const draft = { track: { name: '', lat: null, lon: null, acc: null }, riders: [] };

  const tracksSorted = [...db.tracks].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

  app.innerHTML = `
    <label class="label" for="trackName">Pista / posto</label>
    <input id="trackName" class="input" list="trackList" placeholder="Es. Fettucciato Monte Rosso" autocomplete="off">
    <datalist id="trackList">${tracksSorted.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>
    <div id="gpsBox" class="gps muted small">📍 Rilevo la posizione…</div>

    <label class="label" for="riderName">Piloti</label>
    <div class="row gap">
      <input id="riderName" class="input" placeholder="Nome pilota" autocomplete="off" enterkeyhint="done">
      <button class="btn primary" id="addRider">Aggiungi</button>
    </div>
    <div id="riderChips" class="chips"></div>
    <div id="pastRiders"></div>

    <button class="btn primary big" id="startSession">Inizia sessione</button>`;

  const trackInput = document.getElementById('trackName');
  const riderInput = document.getElementById('riderName');
  const gpsBox = document.getElementById('gpsBox');

  function renderRiders() {
    document.getElementById('riderChips').innerHTML = draft.riders.map((n, i) =>
      `<span class="chip">${esc(n)}<button data-i="${i}" aria-label="Rimuovi">×</button></span>`).join('') ||
      '<span class="muted small">Nessun pilota aggiunto</span>';
    document.querySelectorAll('#riderChips button').forEach(b => b.onclick = () => {
      draft.riders.splice(+b.dataset.i, 1); renderRiders();
    });
    const past = db.riderNames.filter(n => !draft.riders.some(r => r.toLowerCase() === n.toLowerCase()));
    document.getElementById('pastRiders').innerHTML = past.length ? `
      <div class="muted small">Tocca per aggiungere:</div>
      <div class="chips">${past.map(n => `<button class="chip add" data-n="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : '';
    document.querySelectorAll('#pastRiders button').forEach(b => b.onclick = () => { addRider(b.dataset.n); });
  }
  function addRider(name) {
    const n = (name ?? riderInput.value).trim();
    if (!n) return;
    if (draft.riders.some(r => r.toLowerCase() === n.toLowerCase())) { toast('Pilota già presente'); return; }
    draft.riders.push(n);
    riderInput.value = '';
    renderRiders();
  }
  document.getElementById('addRider').onclick = () => { addRider(); riderInput.focus(); };
  riderInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRider(); } });
  renderRiders();

  // GPS: rileva posizione e propone la pista nota più vicina
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(pos => {
      draft.track.lat = pos.coords.latitude;
      draft.track.lon = pos.coords.longitude;
      draft.track.acc = Math.round(pos.coords.accuracy);
      let near = null, best = Infinity;
      for (const t of db.tracks) {
        if (t.lat == null) continue;
        const d = distMeters(draft.track, t);
        if (d < best) { best = d; near = t; }
      }
      gpsBox.innerHTML = `📍 Posizione rilevata (±${draft.track.acc} m)`;
      if (near && best < NEAR_METERS && !trackInput.value) {
        trackInput.value = near.name;
        gpsBox.innerHTML += ` · sei vicino a <strong>${esc(near.name)}</strong>`;
      }
    }, err => {
      gpsBox.textContent = err.code === 1
        ? '📍 Posizione non autorizzata (facoltativa)'
        : '📍 Posizione non disponibile (facoltativa)';
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  } else {
    gpsBox.textContent = '📍 GPS non disponibile';
  }

  document.getElementById('startSession').onclick = () => {
    if (riderInput.value.trim()) addRider();
    if (!draft.riders.length) { toast('Aggiungi almeno un pilota'); riderInput.focus(); return; }
    draft.track.name = trackInput.value.trim() || 'Pista senza nome';
    const s = {
      id: uid(),
      createdAt: Date.now(),
      track: draft.track,
      visibility: 'private',
      riders: draft.riders.map(n => ({ id: uid(), name: n, startedAt: null, runs: [] }))
    };
    draft.riders.forEach(rememberRider);
    rememberTrack(draft.track);
    db.sessions.push(s);
    save();
    location.hash = 's/' + s.id;
  };
}

/* ---------- SESSIONE ---------- */

let ticker = null;
function stopTicker() { if (ticker) cancelAnimationFrame(ticker); ticker = null; releaseWakeLock(); }

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* non supportato o negato */ }
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && location.hash.startsWith('#s/')) requestWakeLock();
});

const lastTap = new Map();

function viewSession(id, tab) {
  const s = getSession(id);
  setHeader(s.track.name, fmtDate(s.createdAt), true);
  requestWakeLock();

  app.innerHTML = `
    <div class="tabs">
      <a class="tab ${tab === 'crono' ? 'on' : ''}" href="#s/${id}/crono">Cronometro</a>
      <a class="tab ${tab === 'classifica' ? 'on' : ''}" href="#s/${id}/classifica">Classifica</a>
    </div>
    <div id="sessionBody"></div>`;

  if (tab === 'classifica') renderRanking(s);
  else renderCrono(s);
}

function renderCrono(s) {
  const body = document.getElementById('sessionBody');
  body.classList.toggle('compact', s.riders.length > 2);
  body.innerHTML = s.riders.map(r => riderCard(r)).join('') + `
    <div class="session-actions">
      <button class="btn ghost" id="addRiderBtn">+ Pilota</button>
      <button class="btn ghost" id="shareBtn">Condividi</button>
      <button class="btn ghost" id="menuBtn">Altro…</button>
    </div>`;

  body.querySelectorAll('.go').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      toggleRider(s, btn.dataset.r, eventTime(e));
    });
    btn.addEventListener('click', e => e.preventDefault());
  });
  body.querySelectorAll('.cancel-start').forEach(b => b.onclick = () => {
    const r = s.riders.find(x => x.id === b.dataset.r);
    r.startedAt = null; save(); renderCrono(s); toast('Partenza annullata');
  });
  body.querySelectorAll('.run').forEach(b => b.onclick = () => runMenu(s, b.dataset.r, b.dataset.run));
  body.querySelectorAll('.rider-name').forEach(b => b.onclick = () => riderMenu(s, b.dataset.r));
  document.getElementById('addRiderBtn').onclick = () => addRiderModal(s);
  document.getElementById('shareBtn').onclick = () => shareSession(s);
  document.getElementById('menuBtn').onclick = () => sessionMenu(s);

  startTicker(s);
}

function riderCard(r) {
  const st = stats(r.runs);
  const running = !!r.startedAt;
  const runsHtml = r.runs.map((run, i) => {
    let cls = '';
    if (st.count > 1 && run.ms === st.best) cls = 'best';
    else if (st.count > 1 && run.ms === st.worst) cls = 'worst';
    return `<button class="run ${cls}" data-r="${r.id}" data-run="${run.id}">
      <span class="run-n">${i + 1}</span><span class="run-t">${fmt(run.ms)}</span>
      ${st.count > 1 && run.ms !== st.best ? `<span class="run-d">${fmtDelta(run.ms - st.best)}</span>` : ''}
    </button>`;
  }).join('');

  return `
    <section class="card rider ${running ? 'running' : ''}" id="rider-${r.id}">
      <div class="rider-head">
        <button class="rider-name" data-r="${r.id}">${esc(r.name)}</button>
        <div class="rider-sum">
          ${st.count ? `<span>${st.count} ${st.count === 1 ? 'tempo' : 'tempi'}</span><span>Totale <strong>${fmt(st.total)}</strong></span>` : '<span class="muted">nessun tempo</span>'}
        </div>
      </div>
      <div class="clock" data-clock="${r.id}">${running ? fmt(Date.now() - r.startedAt) : (st.count ? fmt(r.runs[r.runs.length - 1].ms) : '0:00.00')}</div>
      <button class="go ${running ? 'stop' : 'start'}" data-r="${r.id}">${running ? 'STOP' : 'START'}</button>
      ${running ? `<button class="link cancel-start" data-r="${r.id}">Partito per sbaglio? Annulla partenza</button>` : ''}
      ${st.count ? `
        <div class="best-line">
          <span class="dot best"></span> Migliore <strong>${fmt(st.best)}</strong>
          ${st.count > 1 ? `<span class="sep">·</span> Media <strong>${fmt(st.avg)}</strong>` : ''}
        </div>
        <div class="runs">${runsHtml}</div>` : ''}
    </section>`;
}

function toggleRider(s, riderId, t) {
  const r = s.riders.find(x => x.id === riderId);
  if (!r) return;
  const prev = lastTap.get(riderId) || 0;
  if (t - prev < DEBOUNCE_MS) return;
  lastTap.set(riderId, t);

  if (!r.startedAt) {
    r.startedAt = t;
    vibrate(60);
    save();
    renderCrono(s);
  } else {
    const ms = t - r.startedAt;
    const startedAt = r.startedAt;
    const run = { id: uid(), ms, at: t };
    r.runs.push(run);
    r.startedAt = null;
    vibrate([40, 60, 40]);
    save();
    renderCrono(s);
    const st = stats(r.runs);
    const msg = `${r.name}: ${fmt(ms)}` + (st.count > 1 && ms === st.best ? ' · nuovo migliore!' : '');
    toast(msg, {
      label: 'Annulla stop', run: () => {
        r.runs = r.runs.filter(x => x.id !== run.id);
        r.startedAt = startedAt;
        save(); renderCrono(s);
      }
    });
  }
}

function startTicker(s) {
  if (ticker) cancelAnimationFrame(ticker);
  const els = [...document.querySelectorAll('[data-clock]')];
  const tick = () => {
    const now = Date.now();
    for (const el of els) {
      const r = s.riders.find(x => x.id === el.dataset.clock);
      if (r && r.startedAt) el.textContent = fmt(now - r.startedAt);
    }
    ticker = requestAnimationFrame(tick);
  };
  if (s.riders.some(r => r.startedAt)) tick();
}

function runMenu(s, riderId, runId) {
  const r = s.riders.find(x => x.id === riderId);
  const idx = r.runs.findIndex(x => x.id === runId);
  const run = r.runs[idx];
  openModal(`
    <h3>${esc(r.name)} · tempo ${idx + 1}</h3>
    <p class="big-time">${fmt(run.ms)}</p>
    <p class="muted small">Registrato alle ${new Date(run.at).toLocaleTimeString('it-IT')}</p>
    <div class="col gap">
      <button class="btn danger" data-x="del">Elimina questo tempo</button>
      <button class="btn ghost" data-x="close">Chiudi</button>
    </div>`, body => {
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=del]').onclick = () => {
      closeModal();
      confirmBox(`Eliminare il tempo ${fmt(run.ms)} di ${r.name}?`, 'Elimina', () => {
        r.runs.splice(idx, 1); save(); renderCrono(s); toast('Tempo eliminato');
      });
    };
  });
}

function riderMenu(s, riderId) {
  const r = s.riders.find(x => x.id === riderId);
  openModal(`
    <h3>${esc(r.name)}</h3>
    <label class="label">Nome</label>
    <input class="input" id="rn" value="${esc(r.name)}">
    <div class="col gap">
      <button class="btn primary" data-x="save">Salva nome</button>
      <button class="btn danger" data-x="del">Rimuovi pilota dalla sessione</button>
      <button class="btn ghost" data-x="close">Chiudi</button>
    </div>`, body => {
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=save]').onclick = () => {
      const n = body.querySelector('#rn').value.trim();
      if (n) { r.name = n; rememberRider(n); save(); }
      closeModal(); renderCrono(s);
    };
    body.querySelector('[data-x=del]').onclick = () => {
      closeModal();
      confirmBox(`Rimuovere ${r.name} e tutti i suoi ${r.runs.length} tempi?`, 'Rimuovi', () => {
        s.riders = s.riders.filter(x => x.id !== r.id); save(); renderCrono(s);
      });
    };
  });
}

function addRiderModal(s) {
  const past = db.riderNames.filter(n => !s.riders.some(r => r.name.toLowerCase() === n.toLowerCase()));
  openModal(`
    <h3>Aggiungi pilota</h3>
    <input class="input" id="nr" placeholder="Nome pilota" enterkeyhint="done">
    ${past.length ? `<div class="chips">${past.map(n => `<button class="chip add" data-n="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
    <div class="row gap">
      <button class="btn ghost" data-x="close">Annulla</button>
      <button class="btn primary" data-x="add">Aggiungi</button>
    </div>`, body => {
    const add = name => {
      const n = (name ?? body.querySelector('#nr').value).trim();
      if (!n) return;
      if (s.riders.some(r => r.name.toLowerCase() === n.toLowerCase())) { toast('Pilota già presente'); return; }
      s.riders.push({ id: uid(), name: n, startedAt: null, runs: [] });
      rememberRider(n); save(); closeModal(); renderCrono(s);
    };
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=add]').onclick = () => add();
    body.querySelector('#nr').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    body.querySelectorAll('.chip.add').forEach(b => b.onclick = () => add(b.dataset.n));
  });
}

function sessionMenu(s) {
  openModal(`
    <h3>Sessione</h3>
    <label class="label">Nome pista</label>
    <input class="input" id="tn" value="${esc(s.track.name)}">
    <p class="muted small">${s.track.lat != null ? `📍 ${s.track.lat.toFixed(5)}, ${s.track.lon.toFixed(5)}` : '📍 Nessuna posizione salvata'}</p>
    <div class="col gap">
      <button class="btn primary" data-x="save">Salva</button>
      ${s.track.lat != null ? '<button class="btn ghost" data-x="map">Apri posizione nelle mappe</button>' : ''}
      <button class="btn danger" data-x="del">Elimina sessione</button>
      <button class="btn ghost" data-x="close">Chiudi</button>
    </div>`, body => {
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=save]').onclick = () => {
      const n = body.querySelector('#tn').value.trim();
      if (n) { s.track.name = n; rememberTrack(s.track); save(); }
      closeModal(); route();
    };
    const mapBtn = body.querySelector('[data-x=map]');
    if (mapBtn) mapBtn.onclick = () => {
      window.open(`https://www.google.com/maps?q=${s.track.lat},${s.track.lon}`, '_blank');
    };
    body.querySelector('[data-x=del]').onclick = () => {
      closeModal();
      confirmBox('Eliminare la sessione e tutti i tempi? Non si può annullare.', 'Elimina', () => {
        db.sessions = db.sessions.filter(x => x.id !== s.id); save(); location.hash = '';
      });
    };
  });
}

function renderRanking(s) {
  const body = document.getElementById('sessionBody');
  const rows = s.riders.map(r => ({ r, st: stats(r.runs) }));
  const ranked = rows.filter(x => x.st.count).sort((a, b) => a.st.best - b.st.best);
  const none = rows.filter(x => !x.st.count);
  const top = ranked.length ? ranked[0].st.best : 0;

  // classifica sul totale solo tra chi ha lo stesso numero di tempi (confronto equo)
  const maxCount = Math.max(0, ...rows.map(x => x.st.count));

  body.innerHTML = `
    <h2 class="section">Miglior tempo</h2>
    ${ranked.length ? ranked.map((x, i) => `
      <div class="card rank-row">
        <span class="pos p${i + 1}">${i + 1}</span>
        <div class="rank-main">
          <strong>${esc(x.r.name)}</strong>
          <div class="muted small">${x.st.count} ${x.st.count === 1 ? 'tempo' : 'tempi'} · totale ${fmt(x.st.total)} · media ${fmt(x.st.avg)}</div>
        </div>
        <div class="rank-time">
          <strong>${fmt(x.st.best)}</strong>
          ${i ? `<div class="muted small">${fmtDelta(x.st.best - top)}</div>` : ''}
        </div>
      </div>`).join('') : '<p class="muted">Ancora nessun tempo registrato.</p>'}
    ${none.length ? `<p class="muted small">Senza tempi: ${none.map(x => esc(x.r.name)).join(', ')}</p>` : ''}
    ${maxCount > 1 ? `
      <h2 class="section">Somma tempi (${maxCount} ${maxCount === 1 ? 'passaggio' : 'passaggi'})</h2>
      <p class="muted small">Solo i piloti che hanno completato tutti i ${maxCount} passaggi.</p>
      ${rows.filter(x => x.st.count === maxCount).sort((a, b) => a.st.total - b.st.total).map((x, i, arr) => `
        <div class="card rank-row">
          <span class="pos p${i + 1}">${i + 1}</span>
          <div class="rank-main"><strong>${esc(x.r.name)}</strong></div>
          <div class="rank-time"><strong>${fmt(x.st.total)}</strong>
            ${i ? `<div class="muted small">${fmtDelta(x.st.total - arr[0].st.total)}</div>` : ''}</div>
        </div>`).join('')}` : ''}`;
}

function sessionText(s) {
  const lines = [`🏍 ${s.track.name} — ${fmtDate(s.createdAt)}`];
  for (const r of s.riders) {
    const st = stats(r.runs);
    if (!st.count) continue;
    lines.push('', `${r.name}: migliore ${fmt(st.best)} · totale ${fmt(st.total)}`);
    lines.push(r.runs.map((x, i) => `  ${i + 1}) ${fmt(x.ms)}${st.count > 1 && x.ms === st.best ? ' ★' : ''}`).join('\n'));
  }
  if (s.track.lat != null) lines.push('', `📍 https://www.google.com/maps?q=${s.track.lat.toFixed(5)},${s.track.lon.toFixed(5)}`);
  return lines.join('\n');
}

async function shareSession(s) {
  const text = sessionText(s);
  try {
    if (navigator.share) { await navigator.share({ title: s.track.name, text }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Tempi copiati: incollali dove vuoi'); }
  catch (_) { toast('Condivisione non disponibile'); }
}

/* ---------- avvio ---------- */

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
  });
}

route();
