/* Enduro Crono — beta
   Cronometro offline per allenamenti enduro.
   Tutti i dati restano sul telefono (localStorage); con l'accesso vengono anche salvati online. */
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

function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { toast('Errore di salvataggio: memoria piena?'); }
}
// ogni modifica: salva sul telefono e, se c'è l'accesso, invia online poco dopo
function save() { saveLocal(); scheduleSync(); }

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
  if (!view && !auth && !welcomeSeen()) return viewWelcome();   // primo avvio
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
  document.getElementById('betaTag').hidden = title !== 'Enduro Crono';   // BETA accanto al nome dell'app
  document.body.classList.toggle('in-session', !!back);                    // dentro una sessione: solo l'avatar
  renderUserBtn();
}

/* ---------- HOME ---------- */

function viewHome() {
  setHeader('Enduro Crono', '', false);
  const sessions = [...db.sessions].sort((a, b) => b.createdAt - a.createdAt);
  const list = sessions.map(s => {
    const runs = s.mode === 'mx' ? s.riders.reduce((n, r) => n + mxAllLaps(r).length, 0) : s.riders.reduce((n, r) => n + r.runs.length, 0);
    const running = s.mode === 'mx' ? s.riders.some(r => mxCurrent(r)) : s.riders.some(r => r.startedAt);
    return `
      <a class="card session-card" href="#s/${s.id}">
        <div class="session-top">
          <strong>${s.mode === 'mx' ? '<span class="mode-tag">MX</span> ' : ''}${esc(s.track.name || 'Pista senza nome')}</strong>
          ${running ? '<span class="pill live">IN CORSO</span>' : ''}
        </div>
        <div class="muted">${fmtDate(s.createdAt)}</div>
        <div class="muted small">${s.riders.length} ${s.riders.length === 1 ? 'pilota' : 'piloti'} · ${runs} ${s.mode === 'mx' ? (runs === 1 ? 'giro' : 'giri') : (runs === 1 ? 'tempo' : 'tempi')}${s.track.lat != null ? ' · 📍' : ''}</div>
      </a>`;
  }).join('');

  app.innerHTML = `<div class="home">
    <button class="btn primary big" id="newBtn">+ Nuova sessione</button>
    ${sessions.length ? `<h2 class="section">Sessioni</h2>${list}` : `
      <div class="empty">
        <p><strong>Nessuna sessione ancora.</strong></p>
        <p class="muted">Crea una sessione, aggiungi i piloti e premi START quando partono. Funziona anche senza segnale: i tempi restano salvati sul telefono.</p>
      </div>`}
    ${sessions.length ? '<p class="muted small center">Tieni premuto su una sessione per condividerla, rinominarla o eliminarla</p>' : ''}
    <div class="home-bottom">
      ${accountCardHtml()}
      <button class="link feedback-link" id="howtoBtn">❓ Come funziona</button>
      <button class="link feedback-link" id="feedbackBtn">💬 Invia un commento o segnala un problema</button>
      <p class="footnote">Versione beta · ${auth ? 'dati salvati sul telefono e online' : 'dati salvati solo su questo telefono'}</p>
    </div></div>`;
  document.getElementById('newBtn').onclick = () => { location.hash = 'new'; };
  wireAccountCard();
  document.getElementById('feedbackBtn').onclick = () => feedbackModal();
  document.getElementById('howtoBtn').onclick = () => howtoModal();

  // tieni premuto su una sessione: menu rapido
  app.querySelectorAll('.session-card').forEach(card => {
    let timer = null, startX = 0, startY = 0, fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; card.classList.remove('pressing'); };
    card.addEventListener('pointerdown', e => {
      fired = false; startX = e.clientX; startY = e.clientY;
      card.classList.add('pressing');
      timer = setTimeout(() => {
        fired = true; cancel(); vibrate(30);
        const sess = getSession(card.getAttribute('href').split('/')[1]);
        if (sess) sessionMenu(sess);
      }, 550);
    });
    card.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => card.addEventListener(ev, cancel));
    card.addEventListener('click', e => { if (fired) { e.preventDefault(); fired = false; } });
    card.addEventListener('contextmenu', e => e.preventDefault());
  });
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

  const mxd = { manches: 2, durationMin: 20, extraLaps: 0, free: false, ...(db.mxDefaults || {}) };
  let mode = db.lastMode || 'enduro';

  app.innerHTML = `
    <div class="tabs mode-tabs">
      <button class="tab" data-mode="enduro">Enduro</button>
      <button class="tab" data-mode="mx">Motocross</button>
    </div>

    <div id="mxSettings" class="card mx-settings">
      <div class="tabs sub-tabs">
        <button class="tab" data-free="1">Allenamento libero</button>
        <button class="tab" data-free="0">Manche</button>
      </div>
      <div id="freeHelp" class="muted small">Premi START e poi GIRO a ogni passaggio, senza limiti di tempo. Con la ✕ chiudi il turno e puoi ripartire quando vuoi.</div>
      <div id="mancheBox" class="col gap">
      <div class="stepper-row">
        <span class="stepper-label">Manche</span>
        <div class="stepper"><button data-step="manches" data-d="-1">−</button><output id="mxManches">${mxd.manches}</output><button data-step="manches" data-d="1">+</button></div>
      </div>
      <div class="stepper-row">
        <span class="stepper-label">Durata manche</span>
        <div class="stepper"><button data-step="durationMin" data-d="-1">−</button><output id="mxDur">${mxd.durationMin} min</output><button data-step="durationMin" data-d="1">+</button></div>
      </div>
      <label class="switch-row">
        <span><strong>+2 giri alla fine</strong><br><span class="muted small">Scaduto il tempo, altri 2 giri come in gara</span></span>
        <input type="checkbox" id="mxExtra" ${mxd.extraLaps ? 'checked' : ''}>
      </label>
      <div class="muted small">La manche finisce al primo passaggio dopo che il tempo è scaduto. Ogni pilota ha il suo tempo.</div>
      </div>
    </div>

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

  const mxBox = document.getElementById('mxSettings');
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.mode-tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.mode === m));
    mxBox.hidden = m !== 'mx';
  }
  document.querySelectorAll('.mode-tabs .tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));
  setMode(mode);
  function setFree(f) {
    mxd.free = f;
    mxBox.querySelectorAll('[data-free]').forEach(t => t.classList.toggle('on', (t.dataset.free === '1') === f));
    document.getElementById('mancheBox').hidden = f;
    document.getElementById('freeHelp').hidden = !f;
  }
  mxBox.querySelectorAll('[data-free]').forEach(t => t.onclick = () => setFree(t.dataset.free === '1'));
  setFree(!!mxd.free);
  const LIMITS = { manches: [1, 6, 1], durationMin: [1, 60, 1] };  // beta: 1 min per le prove
  mxBox.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const k = b.dataset.step, [lo, hi] = LIMITS[k];
    const dir = +b.dataset.d;
    const step = k === 'durationMin' && (mxd[k] + (dir > 0 ? 0 : -1)) >= 10 ? 5 : 1;
    let v = mxd[k] + dir * step;
    if (k === 'durationMin' && step === 5) v = Math.round(v / 5) * 5;
    mxd[k] = Math.min(hi, Math.max(lo, v));
    document.getElementById('mxManches').textContent = mxd.manches;
    document.getElementById('mxDur').textContent = mxd.durationMin + ' min';
  });

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
    mxd.extraLaps = document.getElementById('mxExtra').checked ? 2 : 0;
    const s = {
      id: uid(),
      createdAt: Date.now(),
      mode,
      track,
      visibility: 'private',
      riders: draft.riders.map(n => ({ id: uid(), name: n, startedAt: null, runs: [], manches: [] }))
    };
    if (mode === 'mx') {
      s.mx = mxd.free ? { free: true } : { manches: mxd.manches, durationMs: mxd.durationMin * 60000, extraLaps: mxd.extraLaps };
      db.mxDefaults = { ...mxd };
    }
    db.lastMode = mode;
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
      <a class="tab ${tab === 'classifica' ? 'on' : ''}" href="#s/${id}/classifica">${s.mode === 'mx' ? 'Analisi' : 'Classifica'}</a>
    </div>
    <div id="sessionBody"></div>`;

  if (tab === 'classifica') (s.mode === 'mx' ? mxRenderRanking : renderRanking)(s);
  else (s.mode === 'mx' ? mxRenderCrono : renderCrono)(s);
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
  }).reverse().join('');

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
      closeModal(); rerender(s);
    };
    body.querySelector('[data-x=del]').onclick = () => {
      closeModal();
      confirmBox(`Rimuovere ${r.name} e tutti i suoi tempi?`, 'Rimuovi', () => {
        s.riders = s.riders.filter(x => x.id !== r.id); save(); rerender(s);
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
      s.riders.push({ id: uid(), name: n, startedAt: null, runs: [], manches: [] });
      rememberRider(n); save(); closeModal(); rerender(s);
    };
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=add]').onclick = () => add();
    body.querySelector('#nr').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    body.querySelectorAll('.chip.add').forEach(b => b.onclick = () => add(b.dataset.n));
  });
}

function sessionMenu(s) {
  openModal(`
    <h3>${esc(s.track.name)}</h3>
    <p class="muted small">${fmtDate(s.createdAt)}${s.mode === 'mx' ? ' · Motocross' : ' · Enduro'}</p>
    <label class="label">Nome pista</label>
    <input class="input" id="tn" value="${esc(s.track.name)}">
    <p class="muted small">${s.track.lat != null ? `📍 ${s.track.lat.toFixed(5)}, ${s.track.lon.toFixed(5)}` : '📍 Nessuna posizione salvata'}</p>
    <div class="col gap">
      <button class="btn primary" data-x="save">Salva nome pista</button>
      <button class="btn ghost" data-x="share">Condividi tempi</button>
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
    body.querySelector('[data-x=share]').onclick = () => { closeModal(); shareSession(s); };
    const mapBtn = body.querySelector('[data-x=map]');
    if (mapBtn) mapBtn.onclick = () => {
      window.open(`https://www.google.com/maps?q=${s.track.lat},${s.track.lon}`, '_blank');
    };
    body.querySelector('[data-x=del]').onclick = () => {
      closeModal();
      confirmBox('Eliminare la sessione e tutti i tempi? Non si può annullare.', 'Elimina', () => {
        db.sessions = db.sessions.filter(x => x.id !== s.id); forgetDeleted(s.id); save();
        if (location.hash && location.hash !== '#') location.hash = ''; else route();
        toast('Sessione eliminata');
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
  const text = s.mode === 'mx' ? mxSessionText(s) : sessionText(s);
  try {
    if (navigator.share) { await navigator.share({ title: s.track.name, text }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Tempi copiati: incollali dove vuoi'); }
  catch (_) { toast('Condivisione non disponibile'); }
}

/* ---------- MOTOCROSS: manche a tempo, giri per pilota ---------- */

const MX_DEBOUNCE_MS = 2000;  // un giro non può durare meno di 2 s: evita i doppi tocchi

function rerender(s) { (s.mode === 'mx' ? mxRenderCrono : renderCrono)(s); }

function mxAllLaps(r) { return (r.manches || []).flatMap(m => m.laps); }
function mxCurrent(r) { const m = (r.manches || [])[r.manches.length - 1]; return m && m.status === 'running' ? m : null; }
function mxLast(r) { return (r.manches || [])[r.manches.length - 1] || null; }
function mxUnit(s) { return s.mx.free ? { long: 'Turno', low: 'turno', short: 'T' } : { long: 'Manche', low: 'manche', short: 'M' }; }
function mxDoneCount(r) { return (r.manches || []).filter(m => m.status !== 'running').length; }

// quanti passaggi mancano alla fine (null = tempo non ancora scaduto)
function mxRemaining(s, m, now) {
  if (s.mx.free || m.goalReached) return null;
  if (now - m.startedAt < s.mx.durationMs && !m.expired) return null;
  return s.mx.extraLaps + 1 - (m.afterExpiry || 0);
}
function mxBoard(rem) {
  if (rem == null) return '';
  if (rem <= 1) return 'ULTIMO GIRO';
  if (rem === 2) return 'PENULTIMO GIRO';
  return `+${rem - 1} GIRI`;
}

function mxLapStats(laps) {
  const t = laps.map(l => l.ms);
  if (!t.length) return { count: 0, total: 0, best: null, worst: null, avg: null, fade: null };
  const total = t.reduce((a, b) => a + b, 0);
  let fade = null;
  // calo di ritmo: media seconda metà vs prima metà (escluso il giro di partenza)
  const core = t.length >= 5 ? t.slice(1) : null;
  if (core) {
    const h = Math.floor(core.length / 2);
    const a = core.slice(0, h), b = core.slice(core.length - h);
    fade = b.reduce((x, y) => x + y, 0) / b.length - a.reduce((x, y) => x + y, 0) / a.length;
  }
  return { count: t.length, total, best: Math.min(...t), worst: Math.max(...t), avg: total / t.length, fade };
}

function mxRenderCrono(s) {
  const body = document.getElementById('sessionBody');
  const d = s.mx;
  body.innerHTML = `
    <div class="mx-info muted small">${d.free ? 'Allenamento libero' : `${d.manches} manche da ${Math.round(d.durationMs / 60000)} min${d.extraLaps ? ' + 2 giri' : ''}`} · tocca <strong>GIRO</strong> a ogni passaggio</div>` +
    s.riders.map(r => mxRiderCard(s, r)).join('') + `
    <div class="session-actions">
      <button class="btn ghost" id="addRiderBtn">+ Pilota</button>
      <button class="btn ghost" id="shareBtn">Condividi</button>
      <button class="btn ghost" id="menuBtn">Altro…</button>
    </div>`;

  body.querySelectorAll('.go').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      mxTap(s, btn.dataset.r, eventTime(e));
    });
    btn.addEventListener('click', e => e.preventDefault());
  });
  body.querySelectorAll('.abort').forEach(b => b.onclick = () => {
    const r = s.riders.find(x => x.id === b.dataset.r);
    const m = mxCurrent(r);
    if (!m) return;
    const pressedAt = Date.now();   // conta il momento del tocco sulla X, non quello della conferma
    const n = r.manches.length;
    const txt = m.goalReached
      ? `Chiudere la manche ${n} di ${r.name}? Obiettivo già raggiunto: i giri in più restano salvati.`
      : `Terminare adesso ${s.mx.free ? 'il turno' : 'la manche'} ${n} di ${r.name}? I giri già fatti restano salvati.`;
    confirmBox(txt, m.goalReached ? 'Sì, chiudi' : 'Sì, termina', () => {
      m.status = m.goalReached ? 'done' : 'stopped'; m.endedAt = pressedAt; save(); mxRenderCrono(s);
    }, !m.goalReached, 'No, continua');
  });
  body.querySelectorAll('.run').forEach(b => b.onclick = () => mxLapMenu(s, b.dataset.r, b.dataset.m, b.dataset.run));
  body.querySelectorAll('.rider-name').forEach(b => b.onclick = () => riderMenu(s, b.dataset.r));
  document.getElementById('addRiderBtn').onclick = () => addRiderModal(s);
  document.getElementById('shareBtn').onclick = () => shareSession(s);
  document.getElementById('menuBtn').onclick = () => sessionMenu(s);

  mxStartTicker(s);
}

function mxStatusText(s, r, now) {
  const m = mxCurrent(r);
  const d = s.mx;
  const tot = d.manches;
  if (d.free) {
    const n = r.manches.length;
    if (!m) {
      if (!n) return { text: 'Allenamento libero · pronto', cls: '' };
      return { text: `Turno ${n} chiuso · ${mxLapStats(mxLast(r).laps).count} giri`, cls: 'done' };
    }
    const cur = m.laps.length ? now - m.laps[m.laps.length - 1].at : now - m.startedAt;
    return { text: `T${n} · giro ${m.laps.length + 1} · ${fmtClock(cur)}`, cls: '' };
  }
  if (!m) {
    const done = mxDoneCount(r);
    if (done >= tot) return { text: 'Allenamento completato', cls: 'done' };
    if (done === 0) return { text: `Manche 1/${tot} · pronto`, cls: '' };
    const last = mxLast(r);
    return { text: `Manche ${done}/${tot} ${last.status === 'done' ? 'completata' : 'terminata'} · ${fmt(mxLapStats(last.laps).total)}`, cls: 'done' };
  }
  const idx = r.manches.length;
  if (m.goalReached) {
    const extra = m.laps.length - m.goalLaps;
    return { text: `✓ Completata${extra ? ` · +${extra} ${extra === 1 ? 'giro' : 'giri'}` : ''}`, cls: 'goal' };
  }
  const rem = mxRemaining(s, m, now);
  if (rem != null) return { text: `M${idx}/${tot} · ${mxBoard(rem)}`, cls: rem <= 1 ? 'last' : 'board' };
  const left = d.durationMs - (now - m.startedAt);
  return { text: `M${idx}/${tot} · mancano ${fmtClock(left)}`, cls: '' };
}

function fmtClock(ms) {
  ms = Math.max(0, ms);
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function mxRiderCard(s, r) {
  const now = Date.now();
  const m = mxCurrent(r);
  const shown = m || mxLast(r);
  const done = mxDoneCount(r);
  const finished = !s.mx.free && !m && done >= s.mx.manches;
  const st = mxStatusText(s, r, now);
  const laps = shown ? shown.laps : [];
  const ls = mxLapStats(laps);
  const mIndex = shown ? r.manches.indexOf(shown) : -1;

  const lapsHtml = laps.map((l, i) => {
    let cls = '';
    if (ls.count > 1 && l.ms === ls.best) cls = 'best';
    else if (ls.count > 1 && l.ms === ls.worst) cls = 'worst';
    return `<button class="run ${cls}" data-r="${r.id}" data-m="${mIndex}" data-run="${l.id}"><span class="run-n">${i + 1}</span>${fmt(l.ms)}</button>`;
  }).reverse().join('');

  let clock = '0:00.00';
  if (m) clock = fmt(now - m.startedAt);
  else if (shown && ls.count) clock = fmt(ls.total);

  let btnLabel = 'START', btnCls = 'start';
  if (m) { btnLabel = 'GIRO'; btnCls = 'lap'; }
  else if (finished) { btnLabel = 'FINITO'; btnCls = 'finished'; }
  else if (done > 0 && !s.mx.free) { btnLabel = `START M${done + 1}`; }

  const rem = m ? mxRemaining(s, m, now) : null;

  return `
    <section class="card rider ${m ? 'running' : ''} ${rem != null && rem <= 1 ? 'lastlap' : ''}" id="rider-${r.id}">
      <div class="rider-row">
        <div class="rider-info">
          <button class="rider-name" data-r="${r.id}">${esc(r.name)}</button>
          <div class="clock" data-clock="${r.id}">${clock}</div>
          <div class="mx-status ${st.cls}" data-status="${r.id}">${esc(st.text)}</div>
          ${ls.count ? `<div class="rider-sum"><span class="best-txt">▲ ${fmt(ls.best)}</span> · media ${fmt(ls.avg)} · ${ls.count} giri</div>` : ''}
        </div>
        ${m ? `<button class="abort" data-r="${r.id}" aria-label="Termina">✕</button>` : ''}
        <button class="go ${btnCls}" data-r="${r.id}" ${finished ? 'disabled' : ''}>${btnLabel}</button>
      </div>
      ${ls.count ? `<div class="runs">${lapsHtml}</div>` : ''}
    </section>`;
}

const mxLastTap = new Map();

function mxTap(s, riderId, t) {
  const r = s.riders.find(x => x.id === riderId);
  if (!r) return;
  r.manches ||= [];
  const prev = mxLastTap.get(riderId) || 0;
  if (t - prev < MX_DEBOUNCE_MS) return;
  mxLastTap.set(riderId, t);

  let m = mxCurrent(r);
  if (!m) {
    if (!s.mx.free && mxDoneCount(r) >= s.mx.manches) return;
    r.manches.push({ startedAt: t, laps: [], status: 'running', afterExpiry: 0 });
    vibrate(60);
    save(); mxRenderCrono(s);
    return;
  }
  const lastAt = m.laps.length ? m.laps[m.laps.length - 1].at : m.startedAt;
  m.laps.push({ id: uid(), ms: t - lastAt, at: t });
  if (!s.mx.free && !m.goalReached && t - m.startedAt >= s.mx.durationMs) {
    m.expired = true;
    m.afterExpiry = (m.afterExpiry || 0) + 1;
  }
  if (!m.goalReached && m.expired && m.afterExpiry >= s.mx.extraLaps + 1) {
    // obiettivo raggiunto: la manche è completa ma si può continuare a girare
    m.goalReached = true;
    m.goalAt = t;
    m.goalLaps = m.laps.length;
    vibrate([200, 100, 200, 100, 400]);
    toast(`🏁 ${r.name}: obiettivo raggiunto! Manche ${r.manches.length} completata in ${fmt(t - m.startedAt)} · ${m.goalLaps} giri. Se continua a girare i tempi vengono presi lo stesso.`);
  } else {
    const rem = mxRemaining(s, m, t);
    vibrate(rem != null && rem <= 1 ? [80, 60, 80, 60, 80] : [40, 50, 40]);
  }
  save(); mxRenderCrono(s);
}

function mxStartTicker(s) {
  if (ticker) cancelAnimationFrame(ticker);
  const clocks = [...document.querySelectorAll('[data-clock]')];
  const statuses = [...document.querySelectorAll('[data-status]')];
  let lastSec = -1;
  const tick = () => {
    const now = Date.now();
    for (const el of clocks) {
      const r = s.riders.find(x => x.id === el.dataset.clock);
      const m = r && mxCurrent(r);
      if (m) el.textContent = fmt(now - m.startedAt);
    }
    const sec = Math.floor(now / 250);
    if (sec !== lastSec) {
      lastSec = sec;
      for (const el of statuses) {
        const r = s.riders.find(x => x.id === el.dataset.status);
        if (!r || !mxCurrent(r)) continue;
        const st = mxStatusText(s, r, now);
        if (el.textContent !== st.text) {
          el.textContent = st.text;
          el.className = 'mx-status ' + st.cls;
          const card = document.getElementById('rider-' + r.id);
          const m = mxCurrent(r);
          const rem = mxRemaining(s, m, now);
          if (card) card.classList.toggle('lastlap', rem != null && rem <= 1);
          if (rem != null && !m._warned) { m._warned = true; vibrate([300, 100, 300]); }
        }
      }
    }
    ticker = requestAnimationFrame(tick);
  };
  if (s.riders.some(r => mxCurrent(r))) tick();
}

function mxLapMenu(s, riderId, mIdx, lapId) {
  const r = s.riders.find(x => x.id === riderId);
  const m = r.manches[+mIdx];
  const idx = m.laps.findIndex(l => l.id === lapId);
  const lap = m.laps[idx];
  openModal(`
    <h3>${esc(r.name)} · ${mxUnit(s).low} ${+mIdx + 1} · giro ${idx + 1}</h3>
    <p class="big-time">${fmt(lap.ms)}</p>
    <p class="muted small">Se elimini un giro, il suo tempo si somma al giro successivo (il pilota ha comunque percorso la pista).</p>
    <div class="col gap">
      <button class="btn danger" data-x="del">Elimina passaggio</button>
      <button class="btn ghost" data-x="close">Chiudi</button>
    </div>`, body => {
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=del]').onclick = () => {
      closeModal();
      confirmBox(`Eliminare il passaggio del giro ${idx + 1}?`, 'Elimina', () => {
        // tocco sbagliato: unisce questo giro al successivo
        const next = m.laps[idx + 1];
        if (next) next.ms += lap.ms;
        m.laps.splice(idx, 1);
        save(); mxRenderCrono(s); toast('Passaggio eliminato');
      });
    };
  });
}

/* --- analisi: classifica, grafico giri, confronto manche --- */

const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
};
function seriesColors() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? SERIES.dark : SERIES.light;
}

function lapChart(r, U = { long: 'Manche', short: 'M' }) {
  const manches = r.manches.filter(m => m.laps.length);
  if (!manches.length) return '';
  const colors = seriesColors();
  const W = 340, H = 200, L = 58, R = 30, T = 12, B = 36;
  const all = manches.flatMap(m => m.laps.map(l => l.ms));
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max(1000, (hi - lo) * 0.12);
  lo -= pad; hi += pad;
  const maxN = Math.max(...manches.map(m => m.laps.length));
  const x = i => L + (maxN === 1 ? (W - L - R) / 2 : i * (W - L - R) / (maxN - 1));
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);

  // tacche "tonde" in secondi (1, 2, 5, 10, 15, 30, 60 s)
  const stepS = [1, 2, 5, 10, 15, 30, 60, 120].find(x => (hi - lo) / 1000 / x <= 4) || 300;
  const ticks = [];
  for (let v = Math.ceil(lo / 1000 / stepS) * stepS * 1000; v <= hi; v += stepS * 1000) ticks.push(v);
  const mmss = v => { const t = Math.round(v / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
    <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${mmss(v)}</text>`).join('');
  const step = Math.max(1, Math.ceil(maxN / 8));
  const xl = Array.from({ length: maxN }, (_, i) => i).filter(i => i % step === 0 || i === maxN - 1)
    .map(i => `<text x="${x(i)}" y="${H - 22}" text-anchor="middle" class="axis">${i + 1}</text>`).join('') +
    `<text x="${L + (W - L - R) / 2}" y="${H - 4}" text-anchor="middle" class="axis-title">Giri</text>` +
    `<text transform="translate(11 ${T + (H - T - B) / 2}) rotate(-90)" text-anchor="middle" class="axis-title">Tempo</text>`;

  const lines = manches.map((m, si) => {
    const c = colors[si % colors.length];
    const pts = m.laps.map((l, i) => [x(i), y(l.ms)]);
    const best = Math.min(...m.laps.map(l => l.ms));
    const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="${m.laps[i].ms === best ? 5 : 4}" fill="${c}" class="pt"/>`).join('');
    const lp = pts[pts.length - 1];
    const label = manches.length > 1 && manches.length <= 4 ? `<text x="${lp[0] + 7}" y="${lp[1] + 4}" class="dlabel">${U.short}${r.manches.indexOf(m) + 1}</text>` : '';
    return `<path d="${path}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}${label}`;
  }).join('');

  const data = JSON.stringify(manches.map((m, si) => ({ n: U.short + (r.manches.indexOf(m) + 1), c: colors[si % colors.length], laps: m.laps.map(l => l.ms) })));
  const legend = manches.length > 1 ? `<div class="legend">${manches.map((m, si) =>
    `<span><i style="background:${colors[si % colors.length]}"></i>${U.long} ${r.manches.indexOf(m) + 1}</span>`).join('')}</div>` : '';

  return `
    <div class="chart" data-chart='${data.replace(/'/g, '&#39;')}' data-geo='${JSON.stringify({ W, H, L, R, T, B, lo, hi, maxN })}'>
      ${legend}
      <div class="chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tempi sul giro di ${esc(r.name)}">
          ${grid}${xl}
          <line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
          ${lines}
        </svg>
        <div class="tip" hidden></div>
      </div>
    </div>`;
}

function wireCharts(root) {
  root.querySelectorAll('.chart').forEach(ch => {
    const data = JSON.parse(ch.dataset.chart), g = JSON.parse(ch.dataset.geo);
    const svg = ch.querySelector('svg'), tip = ch.querySelector('.tip'), xh = ch.querySelector('.xhair');
    const show = e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width * g.W;
      const i = g.maxN === 1 ? 0 : Math.round((px - g.L) / ((g.W - g.L - g.R) / (g.maxN - 1)));
      if (i < 0 || i >= g.maxN) { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); return; }
      const xx = g.maxN === 1 ? g.L + (g.W - g.L - g.R) / 2 : g.L + i * (g.W - g.L - g.R) / (g.maxN - 1);
      xh.setAttribute('x1', xx); xh.setAttribute('x2', xx); xh.setAttribute('visibility', 'visible');
      const rows = data.filter(d => d.laps[i] != null)
        .map(d => `<div><i style="background:${d.c}"></i>${d.n} <strong>${fmt(d.laps[i])}</strong></div>`).join('');
      tip.innerHTML = `<div class="tip-h">Giro ${i + 1}</div>${rows}`;
      tip.hidden = false;
      const left = xx / g.W * rect.width;
      tip.style.left = Math.min(Math.max(left - tip.offsetWidth / 2, 0), rect.width - tip.offsetWidth) + 'px';
    };
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); });
  });
}

function mxRenderRanking(s) {
  const U = mxUnit(s);
  const body = document.getElementById('sessionBody');
  const rows = s.riders.map(r => ({ r, st: mxLapStats(mxAllLaps(r)) }));
  const ranked = rows.filter(x => x.st.count).sort((a, b) => a.st.best - b.st.best);
  const top = ranked.length ? ranked[0].st.best : 0;

  const perRider = s.riders.filter(r => mxAllLaps(r).length).map(r => {
    const table = r.manches.map((m, i) => {
      const ls = mxLapStats(m.laps);
      if (!ls.count) return '';
      const goal = m.goalReached ? m.goalLaps : null;
      const giri = goal != null ? `${goal}${ls.count > goal ? ` <span class="muted">+${ls.count - goal}</span>` : ''}` : ls.count;
      const totale = goal != null ? fmt(m.goalAt - m.startedAt) : fmt(ls.total);
      const fade = ls.fade == null ? '–' : (ls.fade > 0 ? `+${(ls.fade / 1000).toFixed(1)}s` : `${(ls.fade / 1000).toFixed(1)}s`);
      return `<tr><td>${U.short}${i + 1}${m.status === 'stopped' && !s.mx.free ? ' <span class="muted">(interrotta)</span>' : m.status === 'running' ? ' <span class="muted">(in corso)</span>' : ''}${m.goalReached ? ' ✓' : ''}</td>
        <td>${giri}</td><td>${totale}</td><td class="best-txt">${fmt(ls.best)}</td><td>${fmt(ls.avg)}</td>
        <td class="${ls.fade == null || Math.abs(ls.fade) < 100 ? '' : ls.fade > 0 ? 'worse' : 'better'}">${fade}</td></tr>`;
    }).join('');
    return `
      <div class="card">
        <h3 class="rider-h">${esc(r.name)}</h3>
        ${lapChart(r, U)}
        <div class="table-wrap"><table class="mx-table">
          <thead><tr><th>${U.long}</th><th>Giri</th><th>Totale</th><th>Migliore</th><th>Media</th><th>Calo</th></tr></thead>
          <tbody>${table}</tbody>
        </table></div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <h2 class="section">Giro più veloce</h2>
    ${ranked.length ? ranked.map((x, i) => `
      <div class="card rank-row">
        <span class="pos p${i + 1}">${i + 1}</span>
        <div class="rank-main"><strong>${esc(x.r.name)}</strong>
          <div class="muted small">${x.st.count} giri · media ${fmt(x.st.avg)}</div></div>
        <div class="rank-time"><strong>${fmt(x.st.best)}</strong>${i ? `<div class="muted small">${fmtDelta(x.st.best - top)}</div>` : ''}</div>
      </div>`).join('') : '<p class="muted">Ancora nessun giro registrato.</p>'}
    ${perRider ? `<h2 class="section">Giri e ${s.mx.free ? 'turni' : 'manche'}</h2>${perRider}
      <p class="muted small">Calo = quanto sono più lenti, in media, i giri della seconda metà rispetto alla prima (escluso il giro di partenza, servono almeno 5 giri). Positivo = hai perso ritmo.</p>` : ''}`;
  wireCharts(body);
}

function mxSessionText(s) {
  const lines = [`🏁 MX ${s.track.name} — ${fmtDate(s.createdAt)}`,
    s.mx.free ? 'Allenamento libero' : `${s.mx.manches} manche da ${Math.round(s.mx.durationMs / 60000)} min${s.mx.extraLaps ? ' + 2 giri' : ''}`];
  for (const r of s.riders) {
    if (!mxAllLaps(r).length) continue;
    lines.push('', r.name);
    r.manches.forEach((m, i) => {
      const ls = mxLapStats(m.laps);
      if (!ls.count) return;
      lines.push(`  ${mxUnit(s).long} ${i + 1}: ${ls.count} giri · ${fmt(ls.total)} · migliore ${fmt(ls.best)}`);
      lines.push('    ' + m.laps.map(l => fmt(l.ms) + (ls.count > 1 && l.ms === ls.best ? '★' : '')).join('  '));
    });
  }
  return lines.join('\n');
}

/* ---------- ACCOUNT E SINCRONIZZAZIONE (Supabase) ----------
   Il telefono resta la memoria principale: l'app funziona sempre offline.
   Con l'accesso fatto, ogni sessione nuova o modificata viene inviata intera
   (JSON in sessions.data) appena c'è rete. Le sessioni presenti solo online
   (es. telefono nuovo) vengono scaricate. Chiamate REST dirette, nessuna libreria. */

const SB_URL = 'https://fhiprgjadehxtpispyvr.supabase.co';
const SB_KEY = 'sb_publishable_whtoYN2-tjeQsTN5YDpHug_awNuDpYn';   // chiave pubblica: protetta dalle regole RLS
const AUTH_KEY = 'ec.auth';
const SYNC_DELAY_MS = 4000;

function loadAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch (_) { return null; }
}
let auth = loadAuth();
function saveAuth(a) {
  auth = a;
  try { a ? localStorage.setItem(AUTH_KEY, JSON.stringify(a)) : localStorage.removeItem(AUTH_KEY); } catch (_) {}
}

function syncState() {
  db.sync ||= { user: null, sent: {}, deleted: [], lastAt: null };
  return db.sync;
}

// impronta veloce del contenuto: serve solo a capire se una sessione è cambiata
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + str.length;
}
function sessionHash(s) { return hashStr(JSON.stringify(s)); }

async function sbFetch(path, opts = {}, withUser = true) {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (withUser && auth) headers.Authorization = 'Bearer ' + auth.access_token;
  const res = await fetchTimeout(SB_URL + path, { ...opts, headers }, 20000);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!res.ok) {
    const err = new Error((body && (body.msg || body.message || body.error_description || body.error)) || ('HTTP ' + res.status));
    err.status = res.status; err.code = body && (body.error_code || body.code);
    throw err;
  }
  return body;
}

function storeSession(data) {
  const u = data.user || (auth && auth.user) || {};
  const meta = u.user_metadata || {};
  saveAuth({
    access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user: {
      id: u.id, email: u.email,
      name: meta.full_name || meta.name || (auth && auth.user && auth.user.name) || null,
      avatar: meta.avatar_url || meta.picture || (auth && auth.user && auth.user.avatar) || null,
      username: meta.username || (auth && auth.user && auth.user.username) || null,
    },
    profile: (auth && auth.user && auth.user.id === u.id && auth.profile) || null,
  });
}

async function ensureToken() {
  if (!auth) throw new Error('non autenticato');
  if (auth.expires_at - Date.now() > 60000) return;
  try {
    const data = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: JSON.stringify({ refresh_token: auth.refresh_token }) }, false);
    storeSession(data);
  } catch (e) {
    // accesso scaduto o revocato: si esce, i dati sul telefono restano
    if (e.status === 400 || e.status === 401) { saveAuth(null); refreshAccountUI(); }
    throw e;
  }
}

// indirizzo dell'app, dove riportano Google e i link nelle email (autorizzato in Supabase > URL Configuration)
function appUrl() { return location.origin + location.pathname; }

/* --- registrazione e accesso con email e password --- */

async function signUpEmail(username, email, password) {
  const data = await sbFetch('/auth/v1/signup?redirect_to=' + encodeURIComponent(appUrl()), {
    method: 'POST', body: JSON.stringify({ email, password, data: { username } }) }, false);
  if (!data || !data.access_token) return false;   // serve la conferma via email
  storeSession(data);
  return true;
}

async function signInEmail(email, password) {
  const data = await sbFetch('/auth/v1/token?grant_type=password', {
    method: 'POST', body: JSON.stringify({ email, password }) }, false);
  storeSession(data);
}

async function sendPasswordReset(email) {
  await sbFetch('/auth/v1/recover?redirect_to=' + encodeURIComponent(appUrl()), {
    method: 'POST', body: JSON.stringify({ email }) }, false);
}

/* --- Google ---
   Strada principale: il pulsante ufficiale di Google (Google Identity Services) dà un "id_token"
   senza lasciare l'app, quindi nessuna pagina di accesso resta nella cronologia (tasto indietro).
   Se lo script di Google non si carica: passaggio dalla pagina di Google con ritorno #access_token=... */

const GOOGLE_CLIENT_ID = '119615516276-0mte5fajfe55t5ek3gfrvqggsnmb9jfg.apps.googleusercontent.com';
let gisPromise = null, gisNonce = null, gisReady = false;

function loadGis() {
  if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    const t = setTimeout(() => reject(new Error('timeout')), 6000);
    s.onload = () => { clearTimeout(t); window.google && google.accounts ? resolve() : reject(new Error('gis')); };
    s.onerror = () => { clearTimeout(t); reject(new Error('gis')); };
    document.head.appendChild(s);
  }).catch(e => { gisPromise = null; throw e; });
  return gisPromise;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initGis() {
  await loadGis();
  if (gisReady) return;
  gisNonce = uid();
  let hashed;
  try { hashed = await sha256Hex(gisNonce); } catch (_) { gisNonce = null; }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential, nonce: hashed,
    auto_select: false, cancel_on_tap_outside: true, use_fedcm_for_prompt: true, context: 'signin', itp_support: true,
  });
  gisReady = true;
}

async function onGoogleCredential(resp) {
  try {
    const data = await sbFetch('/auth/v1/token?grant_type=id_token', { method: 'POST',
      body: JSON.stringify({ provider: 'google', id_token: resp.credential, ...(gisNonce ? { nonce: gisNonce } : {}) }) }, false);
    storeSession(data);
    loggedIn();
  } catch (e) { toast('Accesso con Google non riuscito, riprova'); }
}

// dentro "box" c'è già il nostro pulsante di riserva: se Google risponde lo sostituisco con quello ufficiale
function mountGoogleButton(box, oneTap) {
  const fallback = box.querySelector('[data-x=google]');
  fallback.onclick = loginWithGoogleRedirect;
  if (!navigator.onLine) return;
  initGis().then(() => {
    if (!box.isConnected) return;
    const slot = document.createElement('div');
    slot.className = 'gis-slot';
    box.appendChild(slot);
    google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with',
      shape: 'rectangular', logo_alignment: 'center', width: Math.min(400, Math.max(200, box.clientWidth || 320)), locale: 'it' });
    fallback.hidden = true;
    if (oneTap) { try { google.accounts.id.prompt(); } catch (_) {} }
  }).catch(() => {});
}

function loginWithGoogleRedirect() {
  if (!navigator.onLine) { toast('Serve la connessione a internet'); return; }
  // replace: la schermata di accesso non resta nella cronologia
  location.replace(`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(appUrl())}`);
}

// ritorno da Google (o dal link "password dimenticata"): #access_token=...&refresh_token=...
function takeAuthRedirect() {
  const h = location.hash.slice(1);
  if (!/(^|&)(access_token|error_code|error)=/.test(h)) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return new URLSearchParams(h);
}

async function finishAuthRedirect(p) {
  if (!p.get('access_token')) {
    toast(p.get('error_code') === 'otp_expired' ? 'Link scaduto o già usato: chiedine uno nuovo' : 'Accesso non riuscito, riprova');
    return;
  }
  try {
    const user = await sbFetch('/auth/v1/user', { headers: { Authorization: 'Bearer ' + p.get('access_token') } }, false);
    storeSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
      expires_in: Number(p.get('expires_in')) || 3600, user });
    if (p.get('type') === 'recovery') { afterLogin(); route(); newPasswordModal(); return; }
    loggedIn();
  } catch (e) { toast('Accesso non riuscito, riprova'); }
}

function afterLogin() {
  setWelcomeSeen();
  const st = syncState();
  if (st.user !== auth.user.id) { st.user = auth.user.id; st.sent = {}; st.deleted = []; st.lastAt = null; saveLocal(); }
}

// dopo ogni accesso riuscito: profilo (nome da rider) e primo salvataggio online
async function loggedIn() {
  afterLogin();
  closeModal();
  route();
  syncNow().catch(() => {});
  const ok = await ensureProfile().catch(() => true);
  if (ok) toast(`Ciao ${myName()}! I tuoi tempi si salvano anche online`);
}

/* --- profilo: nome da rider e avatar (tabella profiles, visibile agli altri rider) --- */

function myName() { return (auth && auth.profile && auth.profile.username) || (auth && auth.user.username) || (auth && auth.user.name) || (auth ? auth.user.email.split('@')[0] : ''); }
function myAvatar() { return (auth && auth.profile && auth.profile.avatar_url) || (auth && auth.user.avatar) || null; }

function setProfile(p) { if (!auth) return; auth.profile = p; saveAuth(auth); refreshAccountUI(); }

// true = profilo a posto; false = serve scegliere il nome (si apre la finestra)
async function ensureProfile() {
  if (!auth) return true;
  await ensureToken();
  const rows = await sbFetch(`/rest/v1/profiles?id=eq.${auth.user.id}&select=username,avatar_url`) || [];
  if (rows[0] && rows[0].username) {
    const p = rows[0];
    if (!p.avatar_url && auth.user.avatar) {   // prima volta con Google: prendo la sua foto
      p.avatar_url = auth.user.avatar;
      sbFetch(`/rest/v1/profiles?id=eq.${auth.user.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ avatar_url: p.avatar_url }) }).catch(() => {});
    }
    setProfile(p);
    return true;
  }
  if (auth.user.username) {   // registrato con email: il nome l'ha già scelto
    try { await saveProfile({ username: auth.user.username }); return true; } catch (_) { /* nome preso: lo chiedo */ }
  }
  usernameModal(true);
  return false;
}

async function saveProfile(fields) {
  await ensureToken();
  const row = { id: auth.user.id, username: myName(), avatar_url: myAvatar(), ...fields };
  await sbFetch('/rest/v1/profiles?on_conflict=id', { method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  setProfile({ username: row.username, avatar_url: row.avatar_url });
}

function validUsername(n) { return /^[\p{L}\p{N} ._-]{3,20}$/u.test(n) && n.trim().length >= 3; }

// foto: ritagliata quadrata e rimpicciolita a 256 px sul telefono, poi caricata in avatars/<id>/avatar.jpg
function resizeImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('immagine'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('immagine')); };
    img.src = url;
  });
}

async function uploadAvatar(file) {
  const blob = await resizeImage(file);
  await ensureToken();
  const path = `avatars/${auth.user.id}/avatar.jpg`;
  await sbFetch('/storage/v1/object/' + path, { method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': '3600' }, body: blob });
  await saveProfile({ avatar_url: `${SB_URL}/storage/v1/object/public/${path}?v=${Date.now()}` });
}

function logout() {
  const token = auth && auth.access_token;
  if (token) fetchTimeout(SB_URL + '/auth/v1/logout', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } }).catch(() => {});
  try { window.google && google.accounts && google.accounts.id.disableAutoSelect(); } catch (_) {}
  saveAuth(null);
  refreshAccountUI();
}

function sessionRow(s) {
  return {
    id: s.id, owner: auth.user.id, mode: s.mode === 'mx' ? 'mx' : 'enduro', data: s,
    visibility: s.visibility || 'private', deleted: false,
    track_name: s.track.name || 'Pista senza nome',   // obbligatorio nel database
    lat: s.track.lat ?? null, lon: s.track.lon ?? null,
    started_at: new Date(s.createdAt).toISOString(), updated_at: new Date().toISOString(),
  };
}

function pendingCount() {
  const st = syncState();
  return db.sessions.filter(s => st.sent[s.id] !== sessionHash(s)).length + st.deleted.length;
}

let syncTimer = null, syncing = null, syncError = null;
function scheduleSync(delay = SYNC_DELAY_MS) {
  if (!auth) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

function syncNow() {
  if (!auth) return Promise.resolve();
  if (syncing) return syncing.then(() => syncNow());
  syncing = doSync().then(() => { syncError = null; }, e => { syncError = e; throw e; })
    .finally(() => { syncing = null; refreshAccountUI(); });
  refreshAccountUI();
  return syncing;
}

async function doSync() {
  if (!navigator.onLine) throw new Error('offline');
  await ensureToken();
  const st = syncState();
  const uidNow = auth.user.id;

  // 1) scarica: sessioni presenti solo online, ed eliminazioni fatte da un altro telefono
  // (prima solo l'elenco leggero, poi il contenuto delle sessioni che mancano qui)
  const list = await sbFetch(`/rest/v1/sessions?select=id,deleted&owner=eq.${uidNow}`) || [];
  let changed = false;
  const missing = [];
  for (const row of list) {
    const local = getSession(row.id);
    if (row.deleted) {
      // eliminata altrove: la tolgo qui solo se non l'ho modificata dopo l'ultimo invio
      if (local && st.sent[row.id] === sessionHash(local)) { db.sessions = db.sessions.filter(x => x.id !== row.id); changed = true; }
      delete st.sent[row.id];
    } else if (!local && !st.deleted.includes(row.id)) missing.push(row.id);
  }
  for (let i = 0; i < missing.length; i += 25) {
    const rows = await sbFetch(`/rest/v1/sessions?select=id,data&id=in.(${missing.slice(i, i + 25).join(',')})`) || [];
    for (const row of rows) {
      if (!row.data || row.data.id !== row.id || getSession(row.id)) continue;
      db.sessions.push(row.data); st.sent[row.id] = sessionHash(row.data); changed = true;
      if (row.data.track) rememberTrack(row.data.track);
    }
  }

  // 2) invia: sessioni nuove o modificate (a blocchi)
  const toSend = db.sessions.filter(s => st.sent[s.id] !== sessionHash(s));
  for (let i = 0; i < toSend.length; i += 25) {
    const chunk = toSend.slice(i, i + 25);
    const hashes = chunk.map(sessionHash);   // impronta di ciò che parte davvero
    await sbFetch('/rest/v1/sessions?on_conflict=id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk.map(sessionRow)) });
    chunk.forEach((s, k) => { st.sent[s.id] = hashes[k]; });
  }

  // 3) eliminazioni fatte su questo telefono
  if (st.deleted.length) {
    const ids = [...st.deleted];
    await sbFetch(`/rest/v1/sessions?id=in.(${ids.join(',')})&owner=eq.${uidNow}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ deleted: true, data: null, updated_at: new Date().toISOString() }) });
    st.deleted = st.deleted.filter(id => !ids.includes(id));
    ids.forEach(id => delete st.sent[id]);
  }

  st.lastAt = Date.now();
  saveLocal();
  if (changed && (location.hash === '' || location.hash === '#')) route();
}

function forgetDeleted(id) {
  const st = syncState();
  if (auth && st.sent[id] && !st.deleted.includes(id)) st.deleted.push(id);
  delete st.sent[id];
}

/* --- interfaccia account --- */

// avatar: foto se c'è, altrimenti iniziali su un colore fisso per ogni nome
function avatarHtml(size, cls = '') {
  const name = myName() || '?';
  const words = name.trim().split(/\s+/);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  const hue = parseInt(hashStr(name), 36) % 360;
  const url = myAvatar();
  return `<span class="avatar ${cls}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:hsl(${hue} 45% 42%)">` +
    `${esc(initials)}${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>`;
}

// in alto a destra: "Accedi" oppure avatar + nome
function renderUserBtn() {
  const b = document.getElementById('userBtn');
  if (!b) return;
  if (!auth) { b.className = 'user-btn login'; b.innerHTML = 'Accedi'; b.setAttribute('aria-label', 'Accedi o registrati'); }
  else {
    b.className = 'user-btn';
    b.innerHTML = `${avatarHtml(30)}<span class="user-name">${esc(myName())}</span>`;
    b.setAttribute('aria-label', 'Il tuo profilo');
  }
  b.onclick = () => (auth ? profileModal() : loginModal());
}

function accountCardHtml() {
  if (!auth) return `
    <button class="card account-card" id="accountBtn">
      <span class="acc-icon">👥</span>
      <span class="acc-text"><strong>Condividi i tuoi tempi con gli amici</strong>
        <span class="acc-sub">Registrati o accedi: i tempi si salvano anche online e puoi vedere quelli degli altri rider.</span></span>
    </button>`;
  return `
    <button class="card account-card" id="accountBtn">
      <span class="acc-icon on">☁</span>
      <span class="acc-text"><strong>Salvataggio online</strong>
        <span class="acc-sub" id="syncLine">${esc(syncLineText())}</span></span>
    </button>`;
}

function syncLineText() {
  if (syncing) return 'Sincronizzazione in corso…';
  const n = pendingCount();
  if (!navigator.onLine) return n ? `Senza rete · ${n} da inviare` : 'Senza rete · tutto già salvato online';
  if (syncError && n) return `Invio non riuscito · ${n} da inviare, riprovo più tardi`;
  if (n) return `${n} da inviare`;
  const st = syncState();
  return st.lastAt ? 'Tutto salvato online · ' + new Date(st.lastAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'Tutto salvato online';
}

let accountShown = null;   // stato (dentro/fuori) disegnato l'ultima volta in home
function refreshAccountUI() {
  renderUserBtn();
  document.querySelectorAll('#syncLine').forEach(l => { l.textContent = syncLineText(); });
  // entrato/uscito: ridisegno la home
  const onHome = location.hash === '' || location.hash === '#';
  if (onHome && accountShown !== null && accountShown !== !!auth && !document.querySelector('#modal:not([hidden])')) route();
}

function wireAccountCard() {
  accountShown = !!auth;
  const btn = document.getElementById('accountBtn');
  if (btn) btn.onclick = () => (auth ? profileModal() : registerModal());
}

function authErrorText(e) {
  const m = String(e && e.message || '').toLowerCase();
  if (e && e.name === 'AbortError' || !navigator.onLine || m.includes('failed to fetch')) return 'Serve la connessione a internet.';
  if (e.status === 429 || m.includes('rate limit')) return 'Troppe richieste: aspetta un minuto e riprova.';
  if (m.includes('invalid login credentials')) return 'Email o password sbagliate.';
  if (m.includes('already registered') || m.includes('already been registered') || e.code === 'user_already_exists') return 'Esiste già un account con questa email: accedi.';
  if (m.includes('not confirmed')) return 'Prima conferma l\'email: apri il link che ti abbiamo mandato.';
  if (m.includes('password')) return 'Password troppo debole: almeno 6 caratteri.';
  if (m.includes('expired') || m.includes('invalid')) return 'Link scaduto o non valido.';
  if (m.includes('email')) return 'Controlla l\'indirizzo email.';
  return 'Qualcosa non ha funzionato. Riprova.';
}

const GOOGLE_G = `<svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function googleBoxHtml() {
  return `<div class="google-box"><button class="btn google-btn" data-x="google">${GOOGLE_G}<span>Continua con Google</span></button></div>`;
}

// "Come funziona": nella schermata di benvenuto e dal link in home
function howtoHtml() {
  return `<ol class="howto">
    <li><b>1</b><div><strong>Crea una sessione</strong><span>Scegli Enduro o Motocross e aggiungi i piloti. La pista la trova da sola col GPS.</span></div></li>
    <li><b>2</b><div><strong>Cronometra</strong><span>Enduro: <em>START</em> alla partenza, <em>STOP</em> all'arrivo. Motocross: <em>GIRO</em> a ogni passaggio. La <em>X</em> annulla o chiude.</span></div></li>
    <li><b>3</b><div><strong>Guarda i risultati</strong><span>Tempi, classifica e grafico dei giri. Tieni premuto su una sessione per condividerla.</span></div></li>
  </ol>`;
}
function howtoModal() {
  openModal(`<h3>Come funziona</h3>${howtoHtml()}
    <p class="muted small">Funziona anche senza segnale: i tempi restano sul telefono.</p>
    <div class="col gap"><button class="btn primary" data-x="ok">Ho capito</button></div>`,
    body => { body.querySelector('[data-x=ok]').onclick = closeModal; });
}

const WELCOME_KEY = 'ec.welcome';
function welcomeSeen() { try { return !!localStorage.getItem(WELCOME_KEY); } catch (_) { return true; } }
function setWelcomeSeen() { try { localStorage.setItem(WELCOME_KEY, '1'); } catch (_) {} }

function viewWelcome() {
  setHeader('Enduro Crono', '', false);
  app.innerHTML = `
    <div class="welcome">
      <img src="icons/icon-192.png" alt="" class="welcome-icon">
      <h2>Benvenuto in Enduro Crono</h2>
      <p class="muted">Cronometra gli allenamenti di enduro e motocross. Funziona anche senza segnale.</p>
      ${howtoHtml()}
      <p>Crea il tuo account per salvare i tempi online, ritrovarli su un altro telefono e condividerli con gli amici.</p>
      <div class="col gap">
        <button class="btn primary big" data-x="register">Registrati</button>
        <button class="btn ghost" data-x="login">Ho già un account · Accedi</button>
      </div>
      <button class="link" data-x="skip">Usa senza account</button>
      <p class="muted small">Senza account i tempi restano solo su questo telefono. Puoi registrarti quando vuoi.</p>
      <a class="link" href="privacy.html">Informativa privacy</a>
    </div>`;
  app.querySelector('[data-x=register]').onclick = () => registerModal();
  app.querySelector('[data-x=login]').onclick = () => loginModal();
  app.querySelector('[data-x=skip]').onclick = () => { setWelcomeSeen(); route(); };
}

function fieldErr(body, sel) {
  const err = body.querySelector(sel);
  body.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { err.hidden = true; }));
  return msg => { err.textContent = msg; err.hidden = false; };
}

function busy(btn, on, label) { btn.disabled = on; btn.textContent = label; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registerModal() {
  openModal(`
    <h3>Crea il tuo account</h3>
    ${googleBoxHtml()}
    <p class="or"><span>oppure con la tua email</span></p>
    <label class="label" for="regName">Nome da rider</label>
    <input class="input" id="regName" autocomplete="nickname" maxlength="20" placeholder="Come ti vedranno gli amici">
    <label class="label" for="regEmail">Email</label>
    <input class="input" id="regEmail" type="email" inputmode="email" autocomplete="email" placeholder="nome@esempio.it">
    <label class="label" for="regPass">Password</label>
    <input class="input" id="regPass" type="password" autocomplete="new-password" placeholder="Almeno 6 caratteri">
    <p class="form-err" id="regErr" hidden></p>
    <p class="muted small">Creando l'account accetti l'<a href="privacy.html" class="inline-link">informativa privacy</a>.</p>
    <div class="col gap"><button class="btn primary" data-x="create">Crea account</button></div>
    <button class="link" data-x="tologin">Hai già un account? Accedi</button>`, body => {
    mountGoogleButton(body.querySelector('.google-box'));
    const show = fieldErr(body, '#regErr'), btn = body.querySelector('[data-x=create]');
    body.querySelector('[data-x=tologin]').onclick = () => loginModal();
    btn.onclick = async () => {
      const username = body.querySelector('#regName').value.trim();
      const email = body.querySelector('#regEmail').value.trim().toLowerCase();
      const password = body.querySelector('#regPass').value;
      if (!validUsername(username)) return show('Nome da rider: da 3 a 20 caratteri, lettere e numeri.');
      if (!EMAIL_RE.test(email)) return show('Scrivi un indirizzo email valido.');
      if (password.length < 6) return show('La password deve avere almeno 6 caratteri.');
      busy(btn, true, 'Creo l\'account…');
      try {
        const taken = await sbFetch(`/rest/v1/profiles?username=ilike.${encodeURIComponent(username.replace(/[%_]/g, '\\$&'))}&select=id`, {}, false);
        if (taken && taken.length) { busy(btn, false, 'Crea account'); return show('Questo nome da rider è già usato: scegline un altro.'); }
        if (await signUpEmail(username, email, password)) loggedIn();
        else openModal(`<h3>Conferma l'email</h3><p>Ti abbiamo scritto a <strong>${esc(email)}</strong>: apri il link per attivare l'account, poi accedi.</p>
          <div class="col gap"><button class="btn primary" data-x="ok">Ok</button></div>`, b => { b.querySelector('[data-x=ok]').onclick = closeModal; });
      } catch (e) { busy(btn, false, 'Crea account'); show(authErrorText(e)); }
    };
  });
}

function loginModal(prefill) {
  openModal(`
    <h3>Accedi</h3>
    ${googleBoxHtml()}
    <p class="or"><span>oppure con la tua email</span></p>
    <label class="label" for="loginEmail">Email</label>
    <input class="input" id="loginEmail" type="email" inputmode="email" autocomplete="email" placeholder="nome@esempio.it" value="${esc(prefill || '')}">
    <label class="label" for="loginPass">Password</label>
    <input class="input" id="loginPass" type="password" autocomplete="current-password">
    <p class="form-err" id="loginErr" hidden></p>
    <div class="col gap"><button class="btn primary" data-x="signin">Accedi</button></div>
    <button class="link" data-x="forgot">Password dimenticata?</button>
    <button class="link" data-x="toreg">Non hai un account? Registrati</button>`, body => {
    mountGoogleButton(body.querySelector('.google-box'));
    const show = fieldErr(body, '#loginErr'), btn = body.querySelector('[data-x=signin]');
    const emailIn = body.querySelector('#loginEmail');
    body.querySelector('[data-x=toreg]').onclick = () => registerModal();
    body.querySelector('[data-x=forgot]').onclick = async () => {
      const email = emailIn.value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return show('Scrivi prima la tua email, poi tocca "Password dimenticata?".');
      try { await sendPasswordReset(email); toast('Ti abbiamo mandato un\'email per cambiare la password'); }
      catch (e) { show(authErrorText(e)); }
    };
    btn.onclick = async () => {
      const email = emailIn.value.trim().toLowerCase(), password = body.querySelector('#loginPass').value;
      if (!EMAIL_RE.test(email)) return show('Scrivi un indirizzo email valido.');
      if (!password) return show('Scrivi la password.');
      busy(btn, true, 'Accesso…');
      try { await signInEmail(email, password); loggedIn(); }
      catch (e) { busy(btn, false, 'Accedi'); show(authErrorText(e)); }
    };
  });
}

function newPasswordModal() {
  openModal(`
    <h3>Nuova password</h3>
    <input class="input" id="newPass" type="password" autocomplete="new-password" placeholder="Almeno 6 caratteri">
    <p class="form-err" id="npErr" hidden></p>
    <div class="col gap"><button class="btn primary" data-x="ok">Salva password</button></div>`, body => {
    const show = fieldErr(body, '#npErr'), btn = body.querySelector('[data-x=ok]');
    btn.onclick = async () => {
      const password = body.querySelector('#newPass').value;
      if (password.length < 6) return show('La password deve avere almeno 6 caratteri.');
      busy(btn, true, 'Salvo…');
      try { await sbFetch('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password }) }); closeModal(); toast('Password cambiata'); ensureProfile().catch(() => {}); }
      catch (e) { busy(btn, false, 'Salva password'); show(authErrorText(e)); }
    };
  });
}

function usernameModal(first) {
  openModal(`
    <h3>${first ? 'Scegli il tuo nome da rider' : 'Cambia nome da rider'}</h3>
    <p class="muted">È il nome che vedranno gli amici accanto ai tuoi tempi.</p>
    <input class="input" id="uName" maxlength="20" autocomplete="nickname" value="${esc(first ? (auth.user.username || auth.user.name || '') : myName())}">
    <p class="form-err" id="uErr" hidden></p>
    <div class="row gap">
      <button class="btn ghost" data-x="no">${first ? 'Più tardi' : 'Annulla'}</button>
      <button class="btn primary" data-x="ok">Salva</button>
    </div>`, body => {
    const show = fieldErr(body, '#uErr'), btn = body.querySelector('[data-x=ok]');
    body.querySelector('[data-x=no]').onclick = closeModal;
    btn.onclick = async () => {
      const username = body.querySelector('#uName').value.trim();
      if (!validUsername(username)) return show('Da 3 a 20 caratteri, lettere e numeri.');
      busy(btn, true, 'Salvo…');
      try { await saveProfile({ username }); closeModal(); toast(first ? `Ciao ${username}!` : 'Nome cambiato'); }
      catch (e) {
        busy(btn, false, 'Salva');
        show(e.status === 409 || e.code === '23505' ? 'Questo nome è già usato da un altro rider.' : authErrorText(e));
      }
    };
  });
}

function profileModal() {
  openModal(`
    <div class="profile-head">
      ${avatarHtml(84, 'big')}
      <div class="profile-id"><strong>${esc(myName())}</strong><span class="muted small">${esc(auth.user.email || '')}</span></div>
    </div>
    <div class="row gap">
      <button class="btn ghost" data-x="photo">Cambia foto</button>
      <button class="btn ghost" data-x="name">Cambia nome</button>
    </div>
    <input type="file" id="avatarFile" accept="image/*" hidden>
    <h4 class="profile-sec">Salvataggio online</h4>
    <p class="small" id="syncLine">${esc(syncLineText())}</p>
    <p class="muted small">Le sessioni restano sempre anche sul telefono. Quando c'è rete vengono salvate online, per ora visibili solo a te.</p>
    <div class="col gap">
      <button class="btn primary" data-x="sync">Sincronizza ora</button>
      <button class="btn ghost" data-x="feedback">💬 Invia un commento</button>
      <button class="btn ghost" data-x="out">Esci</button>
      <button class="btn ghost" data-x="close">Chiudi</button>
    </div>
    <a class="link" href="privacy.html">Informativa privacy</a>
    <button class="link danger-link" data-x="delete">Elimina il mio account</button>`, body => {
    body.querySelector('[data-x=close]').onclick = closeModal;
    body.querySelector('[data-x=feedback]').onclick = () => feedbackModal();
    body.querySelector('[data-x=delete]').onclick = () => deleteAccountFlow();
    body.querySelector('[data-x=name]').onclick = () => usernameModal(false);
    const file = body.querySelector('#avatarFile');
    body.querySelector('[data-x=photo]').onclick = () => file.click();
    file.onchange = async () => {
      if (!file.files[0]) return;
      toast('Carico la foto…');
      try { await uploadAvatar(file.files[0]); toast('Foto aggiornata'); if (body.isConnected) profileModal(); }
      catch (e) { toast(navigator.onLine ? 'Foto non caricata, riprova' : 'Serve la connessione a internet'); }
    };
    body.querySelector('[data-x=sync]').onclick = () => {
      syncNow().then(() => toast('Tutto salvato online'), e => toast(e.message === 'offline' ? 'Senza rete: riprovo appena torna' : 'Invio non riuscito, riprovo più tardi'));
    };
    body.querySelector('[data-x=out]').onclick = () => {
      closeModal();
      const n = pendingCount();
      confirmBox(n ? `Ci sono ${n} sessioni non ancora inviate: restano sul telefono ma non online. Uscire lo stesso?` :
        'Uscire? Le sessioni restano sul telefono.', 'Esci', () => { logout(); toast('Sei uscito'); }, false);
    };
  });
}

/* --- commenti dei tester: salvati in coda sul telefono, inviati appena c'è rete --- */

const APP_VERSION = 'ec-v15';   // uguale a CACHE in sw.js
const FEEDBACK_KEY = 'ec.feedback';

function feedbackQueue() { try { return JSON.parse(localStorage.getItem(FEEDBACK_KEY)) || []; } catch (_) { return []; } }
function setFeedbackQueue(q) { try { q.length ? localStorage.setItem(FEEDBACK_KEY, JSON.stringify(q)) : localStorage.removeItem(FEEDBACK_KEY); } catch (_) {} }

let flushingFeedback = false;
async function flushFeedback() {
  if (flushingFeedback || !navigator.onLine) return;
  flushingFeedback = true;
  try {
    let q = feedbackQueue();
    while (q.length) {
      if (auth) await ensureToken().catch(() => {});
      await sbFetch('/rest/v1/feedback', { method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ message: q[0].message, app_version: q[0].version, device: q[0].device, page: q[0].page }) }, !!auth);
      q = feedbackQueue().slice(1); setFeedbackQueue(q);
    }
  } catch (_) { /* riprovo più tardi */ }
  finally { flushingFeedback = false; }
}

function feedbackModal() {
  openModal(`
    <h3>Invia un commento</h3>
    <p class="muted">Un problema, un'idea, una cosa che non capisci? Scrivila qui: la leggo io. Se sei in pista senza rete, parte appena torna.</p>
    <textarea class="input textarea" id="fbText" rows="5" maxlength="4000" placeholder="Es. in motocross il pulsante GIRO è troppo piccolo coi guanti"></textarea>
    <p class="form-err" id="fbErr" hidden></p>
    <div class="row gap">
      <button class="btn ghost" data-x="no">Annulla</button>
      <button class="btn primary" data-x="ok">Invia</button>
    </div>`, body => {
    const show = fieldErr(body, '#fbErr'), text = body.querySelector('#fbText');
    text.addEventListener('input', () => { body.querySelector('#fbErr').hidden = true; });
    body.querySelector('[data-x=no]').onclick = closeModal;
    body.querySelector('[data-x=ok]').onclick = () => {
      const message = text.value.trim();
      if (!message) return show('Scrivi qualcosa prima di inviare.');
      setFeedbackQueue([...feedbackQueue(), { message, version: APP_VERSION, page: location.hash || '#home',
        device: `${navigator.userAgent.slice(0, 180)} · ${screen.width}x${screen.height}` }]);
      closeModal();
      toast(navigator.onLine ? 'Grazie! Commento inviato' : 'Grazie! Lo invio appena torna la rete');
      flushFeedback();
    };
  });
}

/* --- elimina account (GDPR): foto, poi utente online (profilo e sessioni a cascata); il telefono resta com'è --- */

function deleteAccountFlow() {
  closeModal();
  confirmBox('Eliminare il tuo account? Spariscono per sempre il profilo, la foto e le sessioni salvate online. Le sessioni sul telefono restano.',
    'Continua', () => {
      openModal(`
        <h3>Conferma eliminazione</h3>
        <p>Per sicurezza scrivi <strong>ELIMINA</strong> qui sotto.</p>
        <input class="input" id="delWord" autocomplete="off" autocapitalize="characters">
        <p class="form-err" id="delErr" hidden></p>
        <div class="row gap">
          <button class="btn ghost" data-x="no">Annulla</button>
          <button class="btn danger" data-x="ok">Elimina account</button>
        </div>`, body => {
        const show = fieldErr(body, '#delErr'), btn = body.querySelector('[data-x=ok]');
        body.querySelector('[data-x=no]').onclick = closeModal;
        btn.onclick = async () => {
          if (body.querySelector('#delWord').value.trim().toUpperCase() !== 'ELIMINA') return show('Scrivi ELIMINA per confermare.');
          if (!navigator.onLine) return show('Serve la connessione a internet.');
          busy(btn, true, 'Elimino…');
          try {
            await ensureToken();
            await sbFetch(`/storage/v1/object/avatars/${auth.user.id}/avatar.jpg`, { method: 'DELETE' }).catch(() => {});
            await sbFetch('/rest/v1/rpc/delete_my_account', { method: 'POST', body: '{}' });
            saveAuth(null);
            db.sync = null; saveLocal();
            try { window.google && google.accounts && google.accounts.id.disableAutoSelect(); } catch (_) {}
            closeModal(); route();
            toast('Account eliminato. Le sessioni sul telefono restano.');
          } catch (e) { busy(btn, false, 'Elimina account'); show('Eliminazione non riuscita, riprova.'); }
        };
      });
    });
}

window.addEventListener('online', () => { scheduleSync(500); flushFeedback(); });
window.addEventListener('offline', refreshAccountUI);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(1000); });

/* ---------- avvio ---------- */

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
  });
}

const authRedirect = takeAuthRedirect();   // prima di route(): l'indirizzo contiene i dati del link
route();
resolvePending();
flushFeedback();
if (authRedirect) finishAuthRedirect(authRedirect);
else {
  scheduleSync(1500);
  if (auth && !(auth.profile && auth.profile.username) && navigator.onLine) setTimeout(() => ensureProfile().catch(() => {}), 1200);
}
// tornando indietro il browser può rimostrare una pagina vecchia (es. schermata di accesso): la ridisegno
window.addEventListener('pageshow', e => { if (e.persisted) { auth = loadAuth(); route(); } });
