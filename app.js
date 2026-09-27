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

function confirmBox(text, okLabel, onOk, danger = true, noLabel = 'Annulla') {
  openModal(`
    <p class="modal-text">${esc(text)}</p>
    <div class="row gap">
      <button class="btn ghost" data-x="no">${esc(noLabel)}</button>
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

/* ---------- RICONOSCIMENTO PISTA (GPS + OpenStreetMap) ---------- */

const TRACK_RADIUS_M = 2000;   // piste ufficiali entro 2 km: copre errore GPS, paddock e parcheggi
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

function fetchTimeout(url, opts = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

async function findOfficialTracks(lat, lon) {
  const q = `[out:json][timeout:15];(` +
    `nwr(around:${TRACK_RADIUS_M},${lat},${lon})["sport"~"motocross|enduro|trial|supermoto|motor",i];` +
    `nwr(around:${TRACK_RADIUS_M},${lat},${lon})["highway"="raceway"]["sport"!~"karting|cycling|bmx|running|horse",i];` +
    `);out center tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetchTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      });
      const txt = await r.text();
      if (!r.ok || txt[0] !== '{') throw new Error('overpass ' + r.status);
      return JSON.parse(txt).elements.map(e => {
        const p = { lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon };
        return { name: e.tags?.name || null, sport: e.tags?.sport || '', dist: p.lat != null ? distMeters({ lat, lon }, p) : Infinity };
      }).filter(x => x.dist <= TRACK_RADIUS_M);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('overpass');
}

async function findLocality(lat, lon) {
  const r = await fetchTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=it`);
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const a = (await r.json()).address || {};
  const small = a.hamlet || a.locality || a.isolated_dwelling || a.neighbourhood || a.suburb || a.village;
  const town = a.town || a.city || a.municipality || a.village;
  const prov = (a['ISO3166-2-lvl6'] || '').replace(/^IT-/, '');
  let name = small && town && small !== town ? `${small}, ${town}` : (small || town || a.county || '');
  if (name && prov && /^[A-Z]{2}$/.test(prov)) name += ` (${prov})`;
  return name;
}

function coordsName(lat, lon) { return `Posizione ${lat.toFixed(4)}, ${lon.toFixed(4)}`; }

// Restituisce { name, source: 'mine' | 'official' | 'place', dist }
async function identifyPlace(lat, lon) {
  let mine = null, best = Infinity;
  for (const t of db.tracks) {
    if (t.lat == null) continue;
    const d = distMeters({ lat, lon }, t);
    if (d < best) { best = d; mine = t; }
  }
  if (mine && best < NEAR_METERS) return { name: mine.name, source: 'mine', dist: best };

  const tracks = await findOfficialTracks(lat, lon);
  const named = tracks.filter(t => t.name).sort((a, b) => a.dist - b.dist);
  if (named.length) return { name: named[0].name, source: 'official', dist: named[0].dist };

  const place = await findLocality(lat, lon);
  if (tracks.length) {
    const t = tracks.sort((a, b) => a.dist - b.dist)[0];
    const kind = /motocross/i.test(t.sport) ? 'Pista motocross' : /enduro/i.test(t.sport) ? 'Pista enduro' : 'Pista';
    return { name: place ? `${kind} · ${place}` : kind, source: 'official', dist: t.dist };
  }
  return { name: place || coordsName(lat, lon), source: 'place', dist: null };
}

function placeLabel(res) {
  if (res.source === 'mine') return `✅ Pista già usata: <strong>${esc(res.name)}</strong>`;
  if (res.source === 'official') return `✅ Pista agganciata: <strong>${esc(res.name)}</strong> (a ${Math.round(res.dist)} m)`;
  return `📍 Nessuna pista nel raggio di ${TRACK_RADIUS_M / 1000} km · località: <strong>${esc(res.name)}</strong>`;
}

// posizione migliore in pochi secondi (si ferma appena la precisione è buona)
function getBestPosition(maxMs = 9000, goodAcc = 25) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('nogps'));
    let best = null, done = false;
    const finish = () => {
      if (done) return; done = true;
      navigator.geolocation.clearWatch(id); clearTimeout(timer);
      best ? resolve(best) : reject(lastErr || new Error('timeout'));
    };
    let lastErr = null;
    const id = navigator.geolocation.watchPosition(pos => {
      if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
      if (pos.coords.accuracy <= goodAcc) finish();
    }, err => { lastErr = err; if (err.code === 1) finish(); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs });
    const timer = setTimeout(finish, maxMs);
  });
}

// assegna il nome alla pista di una sessione (se l'utente non l'ha scritto a mano)
async function resolveTrackName(track) {
  const res = await identifyPlace(track.lat, track.lon);
  if (track.auto) {
    track.name = res.name;
    track.source = res.source;
    track.pending = false;
    rememberTrack(track);
    save();
  }
  return res;
}

// sessioni create senza rete: prova a dare il nome appena torna il segnale
let resolvingPending = false;
async function resolvePending() {
  if (resolvingPending || !navigator.onLine) return;
  resolvingPending = true;
  try {
    for (const s of db.sessions) {
      if (!s.track.pending || s.track.lat == null) continue;
      try {
        await resolveTrackName(s.track);
        if (location.hash.startsWith('#s/' + s.id)) setHeader(s.track.name, fmtDate(s.createdAt), true);
        else if (!location.hash || location.hash === '#') route();
      } catch (_) { break; }
    }
  } finally { resolvingPending = false; }
}
window.addEventListener('online', resolvePending);

/* ---------- NUOVA SESSIONE ---------- */

function viewNew() {
  setHeader('Nuova sessione', '', true);
  const track = { name: '', lat: null, lon: null, acc: null, auto: true, pending: true, source: null };
  const draft = { riders: [] };
  const tracksSorted = [...db.tracks].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

  app.innerHTML = `
    <div class="card place-card">
      <div id="gpsBox" class="gps"><span class="spinner"></span> Cerco la pista con il GPS…</div>
      <input id="trackName" class="input" list="trackList" placeholder="Nome automatico" autocomplete="off">
      <datalist id="trackList">${tracksSorted.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>
      <div class="muted small">Il nome si mette da solo. Scrivilo solo se vuoi cambiarlo.</div>
    </div>

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
  const onThisView = () => location.hash === '#new';

  trackInput.addEventListener('input', () => { track.auto = !trackInput.value.trim(); });

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

  // riconoscimento automatico: continua anche dopo "Inizia sessione"
  let createdSession = null;
  const showName = () => {
    if (onThisView() && track.auto) trackInput.value = track.name;
    if (createdSession && location.hash.startsWith('#s/' + createdSession.id)) setHeader(track.name, fmtDate(createdSession.createdAt), true);
  };
  (async () => {
    let pos;
    try { pos = await getBestPosition(); }
    catch (err) {
      track.pending = false;
      if (onThisView()) gpsBox.textContent = err && err.code === 1
        ? '📍 Posizione non autorizzata: scrivi il nome a mano (facoltativo)'
        : '📍 GPS non disponibile: scrivi il nome a mano (facoltativo)';
      return;
    }
    track.lat = pos.coords.latitude; track.lon = pos.coords.longitude; track.acc = Math.round(pos.coords.accuracy);
    if (track.auto) track.name = coordsName(track.lat, track.lon);
    showName();
    if (onThisView()) gpsBox.innerHTML = `<span class="spinner"></span> Posizione trovata (±${track.acc} m), cerco piste vicine…`;
    try {
      const res = await resolveTrackName(track);
      showName();
      if (onThisView()) gpsBox.innerHTML = placeLabel(res);
    } catch (_) {
      if (onThisView()) gpsBox.innerHTML = '📡 Senza rete: salvo le coordinate, il nome arriva appena torna il segnale';
      if (createdSession) save();
    }
  })();

  document.getElementById('startSession').onclick = () => {
    if (riderInput.value.trim()) addRider();
    if (!draft.riders.length) { toast('Aggiungi almeno un pilota'); riderInput.focus(); return; }
    const typed = trackInput.value.trim();
    if (typed && !track.auto) { track.name = typed; track.pending = false; track.source = 'manual'; }
    if (!track.name) track.name = track.pending ? 'Rilevamento posizione…' : 'Pista senza nome';
    const s = {
      id: uid(),
      createdAt: Date.now(),
      track,
      visibility: 'private',
      riders: draft.riders.map(n => ({ id: uid(), name: n, startedAt: null, runs: [] }))
    };
    createdSession = s;
    draft.riders.forEach(rememberRider);
    if (!track.pending) rememberTrack(track);
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
  body.querySelectorAll('.abort').forEach(b => b.onclick = () => {
    const r = s.riders.find(x => x.id === b.dataset.r);
    if (!r || !r.startedAt) return;
    confirmBox(`Interrompere il tempo di ${r.name}? Il tempo in corso non verrà salvato.`, 'Sì, interrompi', () => {
      r.startedAt = null; save(); renderCrono(s);
    }, true, 'No, continua');
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
    return `<button class="run ${cls}" data-r="${r.id}" data-run="${run.id}"><span class="run-n">${i + 1}</span>${fmt(run.ms)}</button>`;
  }).join('');

  const clockText = running ? fmt(Date.now() - r.startedAt) : (st.count ? fmt(r.runs[r.runs.length - 1].ms) : '0:00.00');

  return `
    <section class="card rider ${running ? 'running' : ''}" id="rider-${r.id}">
      <div class="rider-row">
        <div class="rider-info">
          <button class="rider-name" data-r="${r.id}">${esc(r.name)}</button>
          <div class="clock" data-clock="${r.id}">${clockText}</div>
          <div class="rider-sum">${st.count
            ? `<span class="best-txt">▲ ${fmt(st.best)}</span> · Tot ${fmt(st.total)} · ${st.count}`
            : 'nessun tempo'}</div>
        </div>
        ${running ? `<button class="abort" data-r="${r.id}" aria-label="Interrompi tempo">✕</button>` : ''}
        <button class="go ${running ? 'stop' : 'start'}" data-r="${r.id}">${running ? 'STOP' : 'START'}</button>
      </div>
      ${st.count ? `<div class="runs">${runsHtml}</div>` : ''}
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
  } else {
    r.runs.push({ id: uid(), ms: t - r.startedAt, at: t });
    r.startedAt = null;
    vibrate([40, 60, 40]);
  }
  save();
  renderCrono(s);
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
      <button class="btn primary" data-x="save">Salva nome pilota</button>
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
      <button class="btn primary" data-x="save">Salva nome pista</button>
      ${s.track.lat != null ? '<button class="btn ghost" data-x="map">Apri posizione nelle mappe</button>' : ''}
      <button class="btn danger" data-x="del">Elimina sessione</button>
      <button class="btn ghost" data-x="close">Chiudi</button>
    </div>`, body => {
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=save]').onclick = () => {
      const n = body.querySelector('#tn').value.trim();
      if (n) { s.track.name = n; s.track.auto = false; s.track.pending = false; rememberTrack(s.track); save(); }
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
resolvePending();
