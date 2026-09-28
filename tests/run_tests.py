"""
Test automatici di Enduro Crono.
Avvio:  python3 -m http.server 8765  (nella cartella del progetto)
        python3 tests/run_tests.py
Usa un orologio simulato (Playwright clock) per provare manche da 1 minuto
con giri ogni 5-7 secondi in pochi istanti, più un test in tempo reale.
"""
import asyncio, json, sys, time
from playwright.async_api import async_playwright

URL = 'http://localhost:8765/'
T0 = '2026-09-27T10:00:00+02:00'
T_INSTALL = '2026-09-27T09:59:00+02:00'   # orologio simulato, lontano dall'ora reale
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('  OK   ' if cond else '  FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

async def new_page(p, clock=True, **kw):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport=kw.pop('viewport', {'width': 390, 'height': 844}),
                              device_scale_factor=2, has_touch=True, **kw)
    pg = await ctx.new_page()
    pg.errs = []
    pg.on('pageerror', lambda e: pg.errs.append(str(e)))
    await pg.route('**/api/interpreter', lambda r: r.abort())
    await pg.route('**/reverse*', lambda r: r.abort())
    if clock:
        await pg.clock.install(time=T_INSTALL)
    await pg.goto(URL)
    if clock:
        await pg.clock.pause_at(T0)   # il tempo avanza solo quando lo decide il test
    return b, ctx, pg

async def tap(pg, i):
    await pg.locator('.go').nth(i).dispatch_event('pointerdown')

async def advance(pg, ms):
    # salta avanti senza eseguire ogni fotogramma (requestAnimationFrame), poi disegna
    ms = int(ms)
    if ms > 40:
        await pg.clock.fast_forward(ms - 40)
    await pg.clock.run_for(min(ms, 40))

async def db(pg):
    return await pg.evaluate('db')

async def create(pg, riders, mode='enduro', free=False, minutes=None, extra=False):
    await pg.click('#newBtn')
    await pg.click(f'[data-mode={mode}]')
    if mode == 'mx':
        await pg.click('[data-free="1"]' if free else '[data-free="0"]')
        if not free and minutes:
            for _ in range(30):
                if (await pg.inner_text('#mxDur')) == f'{minutes} min': break
                await pg.click('[data-step=durationMin][data-d="-1"]')
        if (await pg.is_checked('#mxExtra')) != extra:
            await pg.click('#mxExtra')
    for n in riders:
        await pg.fill('#riderName', n); await pg.click('#addRider')
    await pg.click('#startSession')
    await pg.wait_for_timeout(50)


async def test_enduro(p):
    print('\nENDURO')
    b, ctx, pg = await new_page(p)
    await create(pg, ['Luca', 'Marco', 'Gio'])
    await tap(pg, 0); await advance(pg, 10000); await tap(pg, 1)
    await advance(pg, 55430); await tap(pg, 0)                 # Luca 65.430 s
    await advance(pg, 14570); await tap(pg, 1)                 # Marco 70.000 s
    d = await db(pg); r = d['sessions'][0]['riders']
    check('Tempo registrato esatto al centesimo (65.43 s)', r[0]['runs'][0]['ms'] == 65430, r[0]['runs'])
    check('Due piloti in contemporanea indipendenti (70.00 s)', r[1]['runs'][0]['ms'] == 70000, r[1]['runs'])
    # altri due giri di Luca: 60 s e 70 s -> migliore verde 60, peggiore rosso 70
    await tap(pg, 0); await advance(pg, 60000); await tap(pg, 0)
    await advance(pg, 3000)
    await tap(pg, 0); await advance(pg, 70000); await tap(pg, 0)
    card = pg.locator('.rider').nth(0)
    best = await card.locator('.run.best').inner_text()
    worst = await card.locator('.run.worst').inner_text()
    check('Migliore evidenziato in verde', '1:00.00' in best, best)
    check('Peggiore evidenziato in rosso', '1:10.00' in worst, worst)
    first_chip = await card.locator('.run').first.inner_text()
    check('Ultimo tempo mostrato per primo', first_chip.startswith('3'), first_chip)
    txt = await card.inner_text()
    check('Totale corretto (3:15.43)', '3:15.43' in txt, txt)
    # doppio tocco accidentale su STOP
    await tap(pg, 2); await advance(pg, 5000); await tap(pg, 2); await advance(pg, 150); await tap(pg, 2)
    d = await db(pg); g = d['sessions'][0]['riders'][2]
    check('Doppio tocco ignorato (nessuna ripartenza)', len(g['runs']) == 1 and g['startedAt'] is None, g)
    # X: annulla il tempo in corso, prima "No", poi "Sì"
    await tap(pg, 1); await advance(pg, 2000)
    await pg.locator('.abort').first.click(); await pg.click('[data-x=no]')
    d = await db(pg)
    check('X + "No, continua" lascia il tempo in corso', d['sessions'][0]['riders'][1]['startedAt'] is not None)
    await pg.locator('.abort').first.click(); await pg.click('[data-x=ok]')
    d = await db(pg); m = d['sessions'][0]['riders'][1]
    check('X + "Sì, interrompi" scarta il tempo senza salvarlo', m['startedAt'] is None and len(m['runs']) == 1, m)
    # ricarica a cronometro acceso: il tempo continua giusto
    await tap(pg, 0); await advance(pg, 30000)
    await pg.reload(); await advance(pg, 500)
    clock = await pg.locator('.rider').nth(0).locator('.clock').inner_text()
    check('Ricarica/chiusura app: il cronometro riprende dal punto giusto', clock.startswith('0:30'), clock)
    await advance(pg, 3600000)
    clock = await pg.locator('.rider').nth(0).locator('.clock').inner_text()
    check('Formato oltre 1 ora (1:00:30)', clock.startswith('1:00:30'), clock)
    # classifica
    await tap(pg, 0)
    await pg.locator('.tab').nth(1).click()
    await pg.wait_for_selector('.rank-row')
    rows = await pg.locator('.rank-row').all_inner_texts()
    check('Classifica ordinata per miglior tempo (Gio 5 s, Luca 1:00, Marco 1:10)',
          'Gio' in rows[0] and 'Luca' in rows[1] and '1:00.00' in rows[1] and 'Marco' in rows[2], rows)
    check('Nessun errore JavaScript', not pg.errs, pg.errs)
    await b.close()


async def test_mx_manche(p):
    print('\nMOTOCROSS · MANCHE 1 MIN, GIRI OGNI 5 s')
    b, ctx, pg = await new_page(p)
    await create(pg, ['Luca', 'Marco'], mode='mx', minutes=1)
    await tap(pg, 0)
    status = await pg.locator('.mx-status').first.inner_text()
    check('Partenza: stato "M1/1 · mancano 1:00"', 'mancano 1:00' in status, status)
    for i in range(11):
        await advance(pg, 5000); await tap(pg, 0)
    d = await db(pg); m = d['sessions'][0]['riders'][0]['manches'][0]
    check('Dopo 55 s la manche è ancora in corso', not m.get('goalReached'), m.get('goalReached'))
    await advance(pg, 5000); await tap(pg, 0)            # 60 s esatti
    d = await db(pg); m = d['sessions'][0]['riders'][0]['manches'][0]
    check('A 60 s esatti al passaggio: obiettivo raggiunto (12 giri)', m.get('goalReached') and m['goalLaps'] == 12, m.get('goalLaps'))
    btn = await pg.locator('.go').first.inner_text()
    check('Dopo l\'obiettivo il pulsante resta GIRO (si continua)', btn == 'GIRO', btn)
    for i in range(2):
        await advance(pg, 5000); await tap(pg, 0)
    status = await pg.locator('.mx-status').first.inner_text()
    check('Giri extra contati ("+2 giri")', '+2 giri' in status, status)
    await pg.locator('.abort').first.click(); await pg.click('[data-x=ok]')
    btn = await pg.locator('.go').first.inner_text()
    check('Chiusa la manche compare START M2', btn.replace('\n', ' ') == 'START M2', btn)
    # manche 2 con giri da 7 s: tempo scade durante il giro 9 -> fine a 63 s
    await advance(pg, 5000)
    await tap(pg, 0)
    for i in range(9):
        await advance(pg, 7000); await tap(pg, 0)
    d = await db(pg); m2 = d['sessions'][0]['riders'][0]['manches'][1]
    check('Giri da 7 s: obiettivo al primo passaggio dopo 60 s (9 giri, 63 s)',
          m2.get('goalReached') and m2['goalLaps'] == 9 and m2['goalAt'] - m2['startedAt'] == 63000, (m2.get('goalLaps'), m2.get('goalAt', 0) - m2['startedAt']))
    await pg.locator('.abort').first.click(); await pg.click('[data-x=ok]')
    btn = await pg.locator('.go').first.inner_text()
    check('Finite le manche: FINITO', btn == 'FINITO', btn)
    await tap(pg, 0)
    d = await db(pg)
    check('Tocchi dopo FINITO ignorati', len(d['sessions'][0]['riders'][0]['manches']) == 2)
    # doppio tocco sul GIRO (< 2 s) di Marco
    await tap(pg, 1); await advance(pg, 5000); await tap(pg, 1); await advance(pg, 400); await tap(pg, 1)
    d = await db(pg)
    check('Doppio tocco su GIRO ignorato', len(d['sessions'][0]['riders'][1]['manches'][0]['laps']) == 1)
    # eliminazione passaggio: il tempo si somma al giro dopo, totale invariato
    for i in range(3):
        await advance(pg, 5000); await tap(pg, 1)
    before = sum(l['ms'] for l in (await db(pg))['sessions'][0]['riders'][1]['manches'][0]['laps'])
    await pg.locator('.rider').nth(1).locator('.run').last.click()   # giro 1
    await pg.click('[data-x=del]'); await pg.click('[data-x=ok]')
    laps = (await db(pg))['sessions'][0]['riders'][1]['manches'][0]['laps']
    check('Elimina passaggio: giri 4 -> 3 e totale invariato', len(laps) == 3 and sum(l['ms'] for l in laps) == before, (len(laps), before))
    # ricarica a metà manche
    await pg.reload(); await advance(pg, 300)
    status = await pg.locator('.mx-status').nth(1).inner_text()
    check('Ricarica a metà manche: stato ancora corretto', 'mancano' in status, status)
    # analisi
    await pg.locator('.tab').nth(1).click(); await advance(pg, 200)
    t = await pg.locator('.mx-table').first.inner_text()
    check('Analisi: M1 = 12 giri +2, totale 1:00.00', '12 +2' in t and '1:00.00' in t, t)
    check('Analisi: M2 = 9 giri, totale 1:03.00', '1:03.00' in t, t)
    check('Grafico con assi "Tempo" e "Giri"', await pg.locator('.axis-title').count() >= 2)
    check('Nessun errore JavaScript', not pg.errs, pg.errs)
    await b.close()


async def test_mx_extra(p):
    print('\nMOTOCROSS · +2 GIRI (TABELLE COME IN GARA)')
    b, ctx, pg = await new_page(p)
    await create(pg, ['Luca'], mode='mx', minutes=1, extra=True)
    await tap(pg, 0)
    for i in range(8):
        await advance(pg, 7000); await tap(pg, 0)       # 56 s
    await advance(pg, 5000)                               # 61 s: tempo scaduto
    s = await pg.locator('.mx-status').first.inner_text()
    check('Scaduto il tempo: "+2 GIRI"', '+2 GIRI' in s, s)
    await advance(pg, 2000); await tap(pg, 0)             # 63 s
    s = await pg.locator('.mx-status').first.inner_text()
    check('Passaggio successivo: "PENULTIMO GIRO"', 'PENULTIMO' in s, s)
    await advance(pg, 7000); await tap(pg, 0)             # 70 s
    s = await pg.locator('.mx-status').first.inner_text()
    cls = await pg.locator('.rider').first.get_attribute('class')
    check('Poi "ULTIMO GIRO" con scheda rossa', 'ULTIMO GIRO' in s and 'lastlap' in cls, (s, cls))
    await advance(pg, 7000); await tap(pg, 0)             # 77 s
    m = (await db(pg))['sessions'][0]['riders'][0]['manches'][0]
    check('Manche completata a 11 giri / 77 s', m.get('goalLaps') == 11 and m['goalAt'] - m['startedAt'] == 77000, (m.get('goalLaps'),))
    check('Nessun errore JavaScript', not pg.errs, pg.errs)
    await b.close()


async def test_mx_free(p):
    print('\nMOTOCROSS · ALLENAMENTO LIBERO')
    b, ctx, pg = await new_page(p)
    await create(pg, ['Luca'], mode='mx', free=True)
    for turn, laps in enumerate([5, 3, 4]):
        await tap(pg, 0)
        for i in range(laps):
            await advance(pg, 6000 + i * 100); await tap(pg, 0)
        await advance(pg, 1000)
        await pg.locator('.abort').first.click(); await pg.click('[data-x=ok]')
        await advance(pg, 30000)
    # X premuta a metà giro, conferma dopo 20 s di "riflessione"
    await tap(pg, 0); await advance(pg, 6000); await tap(pg, 0); await advance(pg, 3000)
    await pg.locator('.abort').first.click(); await advance(pg, 20000); await pg.click('[data-x=ok]')
    last = (await db(pg))['sessions'][0]['riders'][0]['manches'][-1]
    check('X a metà giro: il giro incompleto non viene salvato', len(last['laps']) == 1, len(last['laps']))
    check('X: il turno si chiude al momento del tocco, non della conferma', last['endedAt'] - last['startedAt'] == 9000, last['endedAt'] - last['startedAt'])
    d = (await db(pg))['sessions'][0]['riders'][0]['manches'][:3]
    check('3 turni registrati (5, 3, 4 giri)', [len(m['laps']) for m in d] == [5, 3, 4], [len(m['laps']) for m in d])
    btn = await pg.locator('.go').first.inner_text()
    check('Dopo i turni si può sempre ripartire (START)', btn == 'START', btn)
    await pg.locator('.tab').nth(1).click(); await advance(pg, 200)
    t = await pg.locator('.mx-table').first.inner_text()
    check('Analisi con etichette Turno T1..T3', 'Turno' in t and 'T3' in t, t)
    check('Nessun errore JavaScript', not pg.errs, pg.errs)
    await b.close()


async def test_places(p):
    print('\nRICONOSCIMENTO PISTA (GPS)')
    async def run(routes, lat=45.699, lon=8.417, online_after=None):
        b = await p.chromium.launch()
        ctx = await b.new_context(geolocation={'latitude': lat, 'longitude': lon, 'accuracy': 10}, permissions=['geolocation'])
        pg = await ctx.new_page()
        for pat, h in routes: await pg.route(pat, h)
        await pg.goto(URL); await pg.click('#newBtn'); await pg.wait_for_timeout(1200)
        return b, pg
    ok = lambda body: (lambda r: r.fulfill(status=200, content_type='application/json', body=body))
    two = json.dumps({'elements': [
        {'type': 'way', 'center': {'lat': 45.7047, 'lon': 8.4158}, 'tags': {'name': 'Pista Lontana', 'sport': 'motocross'}},
        {'type': 'way', 'center': {'lat': 45.6995, 'lon': 8.4172}, 'tags': {'name': 'Pista Vicina', 'sport': 'motocross'}},
        {'type': 'way', 'center': {'lat': 45.699, 'lon': 8.418}, 'tags': {'sport': 'motocross'}}]})
    b, pg = await run([('**/api/interpreter', ok(two))])
    v = await pg.input_value('#trackName')
    check('Più piste vicine: sceglie la più vicina con nome', v == 'Pista Vicina', v)
    await b.close()
    far = json.dumps({'elements': [{'type': 'way', 'center': {'lat': 45.75, 'lon': 8.42}, 'tags': {'name': 'Oltre 5 km', 'sport': 'motocross'}}]})
    loc = json.dumps({'address': {'village': 'Maggiora', 'ISO3166-2-lvl6': 'IT-NO'}})
    b, pg = await run([('**/api/interpreter', ok(far)), ('**/reverse*', ok(loc))])
    v = await pg.input_value('#trackName')
    check('Pista oltre 2 km ignorata -> nome località', v == 'Maggiora (NO)', v)
    await b.close()
    b, pg = await run([('**/api/interpreter', lambda r: r.abort()), ('**/reverse*', lambda r: r.abort())])
    v = await pg.input_value('#trackName')
    check('Senza rete: coordinate come nome provvisorio', v.startswith('Posizione 45.69'), v)
    await pg.fill('#riderName', 'Luca'); await pg.click('#addRider'); await pg.click('#startSession')
    await pg.unroute('**/api/interpreter'); await pg.unroute('**/reverse*')
    await pg.route('**/api/interpreter', ok(two))
    await pg.evaluate("window.dispatchEvent(new Event('online'))"); await pg.wait_for_timeout(800)
    name = await pg.evaluate('db.sessions[0].track.name')
    check('Tornata la rete: la sessione prende il nome giusto da sola', name == 'Pista Vicina', name)
    await b.close()
    b, pg = await run([('**/api/interpreter', ok(two))])
    await pg.fill('#trackName', 'Il mio nome'); await pg.fill('#riderName', 'Luca'); await pg.click('#addRider')
    await pg.click('#startSession'); await pg.wait_for_timeout(300)
    name = await pg.evaluate('db.sessions[0].track.name')
    check('Nome scritto a mano non viene sovrascritto', name == 'Il mio nome', name)
    await b.close()


async def test_offline_and_ui(p):
    print('\nOFFLINE, HOME, SCHERMI PICCOLI, CARICO')
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': 390, 'height': 844})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.route('**/api/interpreter', lambda r: r.abort())
    await pg.goto(URL)
    await pg.evaluate('navigator.serviceWorker.ready'); await pg.reload()
    await pg.evaluate('navigator.serviceWorker.ready')
    await ctx.set_offline(True)
    await pg.reload()
    ok = await pg.locator('#newBtn').count()
    check('Senza segnale l\'app si apre lo stesso (service worker)', ok == 1)
    await pg.click('#newBtn'); await pg.fill('#riderName', 'Luca'); await pg.click('#addRider'); await pg.click('#startSession')
    await tap(pg, 0); await pg.wait_for_timeout(1200); await tap(pg, 0)
    ms = await pg.evaluate('db.sessions[0].riders[0].runs[0].ms')
    check('Offline: tempo registrato (tempo reale ~1.2 s)', 1150 <= ms <= 1400, ms)
    await ctx.set_offline(False)
    # tenere premuto sulla sessione in home
    await pg.goto(URL)
    box = await pg.locator('.session-card').first.bounding_box()
    await pg.mouse.move(box['x'] + 40, box['y'] + 30); await pg.mouse.down(); await pg.wait_for_timeout(700); await pg.mouse.up()
    check('Home: tenere premuto apre il menu della sessione', await pg.locator('#modal:not([hidden]) [data-x=share]').count() == 1)
    check('Home: il tocco lungo non apre la sessione', await pg.evaluate('location.hash') in ('', '#'))
    await pg.click('[data-x=del]'); await pg.click('[data-x=ok]'); await pg.wait_for_timeout(200)
    check('Home: elimina sessione dal menu', await pg.locator('.session-card').count() == 0)
    await b.close()

    # schermo piccolo (iPhone SE 320 px) con 8 piloti, tema scuro
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': 320, 'height': 568}, color_scheme='dark')
    pg = await ctx.new_page()
    await pg.route('**/api/interpreter', lambda r: r.abort())
    await pg.goto(URL); await create(pg, [f'Pilota {i}' for i in range(1, 9)], mode='mx', minutes=1)
    for i in range(8): await tap(pg, i)
    await pg.wait_for_timeout(300)
    over = await pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    check('Schermo 320 px: nessuno scorrimento orizzontale', over <= 0, over)
    h = await pg.evaluate("document.querySelector('.rider').getBoundingClientRect().height")
    check('Scheda pilota compatta (< 130 px)', h < 130, h)
    await pg.screenshot(path='tests/out_320_dark.png', full_page=True)
    await b.close()

    # carico: 100 sessioni da 3 piloti x 2 manche x 15 giri
    b = await p.chromium.launch(); pg = await (await b.new_context()).new_page()
    await pg.goto(URL)
    size = await pg.evaluate('''() => {
      const now = Date.now(), S = [];
      for (let k = 0; k < 100; k++) S.push({ id: 's' + k, createdAt: now - k * 86400000, mode: 'mx',
        mx: { manches: 2, durationMs: 1200000, extraLaps: 0 }, track: { name: 'Pista ' + k, lat: 45, lon: 9 },
        riders: [0,1,2].map(r => ({ id: 'r' + r, name: 'P' + r, runs: [], manches: [0,1].map(m => ({ startedAt: now, status: 'done', goalReached: true, goalLaps: 15, goalAt: now + 1800000,
          laps: Array.from({ length: 15 }, (_, i) => ({ id: 'l' + k + r + m + i, ms: 118000 + i * 300, at: now + i * 120000 })) })) })) });
      localStorage.setItem('ec.v1', JSON.stringify({ sessions: S, riderNames: [], tracks: [] }));
      return localStorage.getItem('ec.v1').length;
    }''')
    t0 = time.time(); await pg.reload(); await pg.wait_for_selector('.session-card'); dt = (time.time() - t0) * 1000
    check(f'100 sessioni (~{size // 1024} KB): home caricata in {dt:.0f} ms', dt < 1500 and size < 4_000_000, (dt, size))
    await pg.goto(URL + '#s/s0/classifica'); await pg.reload(); await pg.wait_for_selector('.mx-table')
    check('Analisi di una sessione piena si apre', True)
    await b.close()


async def test_realtime(p):
    print('\nPRECISIONE IN TEMPO REALE (orologio vero)')
    b, ctx, pg = await new_page(p, clock=False)
    await create(pg, ['Luca'])
    errs = []
    for target in (1000, 2500):
        await tap(pg, 0); await pg.wait_for_timeout(target); await tap(pg, 0); await pg.wait_for_timeout(600)
        ms = (await db(pg))['sessions'][0]['riders'][0]['runs'][-1]['ms']
        errs.append(ms - target)
    check(f'Scarto misurato vs attesa: {errs} ms (tolleranza 60 ms del test)', all(0 <= e <= 60 for e in errs), errs)
    await b.close()


class FakeSupabase:
    """Supabase finto (auth con codice + tabella sessions) per provare la sincronizzazione senza rete."""
    BASE = 'https://fhiprgjadehxtpispyvr.supabase.co'
    CODE = '123456'

    def __init__(self):
        self.rows = {}          # id -> riga
        self.calls = []
        self.down = False       # simula rete assente verso Supabase
        self.otp_redirect = None

    async def attach(self, pg):
        await pg.route(self.BASE + '/**', self.handle)

    async def handle(self, route):
        from urllib.parse import urlparse, parse_qs
        req = route.request
        u = urlparse(req.url); q = parse_qs(u.query); path = u.path
        self.calls.append((req.method, path))
        if self.down:
            return await route.abort()
        ok = lambda body, status=200: route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        body = json.loads(req.post_data) if req.post_data else None
        if path == '/auth/v1/otp':
            self.otp_redirect = q.get('redirect_to', [None])[0]
            return await ok({})
        if path == '/auth/v1/verify':
            if body.get('token') != self.CODE:
                return await ok({'code': 403, 'error_code': 'otp_expired', 'msg': 'Token has expired or is invalid'}, 403)
            return await ok({'access_token': 'tok', 'refresh_token': 'ref', 'expires_in': 3600,
                             'user': {'id': 'user-1', 'email': body['email']}})
        if path == '/auth/v1/user':
            if req.headers.get('authorization') != 'Bearer tok':
                return await ok({'msg': 'invalid JWT'}, 401)
            return await ok({'id': 'user-1', 'email': 'luca@example.com'})
        if path == '/auth/v1/logout':
            return await route.fulfill(status=204, body='')
        if path == '/rest/v1/sessions':
            if req.headers.get('authorization') != 'Bearer tok':
                return await ok({'message': 'JWT'}, 401)
            ids = q['id'][0][4:-1].split(',') if 'id' in q else None
            if req.method == 'GET':
                sel = q['select'][0].split(',')
                rows = [r for r in self.rows.values() if ids is None or r['id'] in ids]
                return await ok([{k: r.get(k) for k in sel} for r in rows])
            if req.method == 'POST':
                for r in body: self.rows[r['id']] = r
                return await route.fulfill(status=201, body='')
            if req.method == 'PATCH':
                for i in ids:
                    if i in self.rows: self.rows[i].update(body)
                return await route.fulfill(status=204, body='')
        return await ok({'message': 'non previsto'}, 404)


async def login(pg, email='luca@example.com'):
    await pg.click('#accountBtn')
    await pg.fill('#loginEmail', email); await pg.click('[data-x=send]')
    await pg.click('[data-x=havecode]')
    await pg.fill('#loginCode', FakeSupabase.CODE); await pg.click('[data-x=ok]')
    await pg.wait_for_selector('#syncLine')


async def test_sync(p):
    print('\nACCOUNT E SINCRONIZZAZIONE ONLINE')
    sb = FakeSupabase()
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': 390, 'height': 844})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.route('**/api/interpreter', lambda r: r.abort()); await pg.route('**/reverse*', lambda r: r.abort())
    await sb.attach(pg)
    await pg.goto(URL)
    await create(pg, ['Luca']); await tap(pg, 0); await pg.wait_for_timeout(400); await tap(pg, 0)
    await pg.wait_for_timeout(300)
    check('Senza accesso: nessun dato inviato online', not sb.calls, sb.calls)
    await pg.goto(URL)
    check('Home: invito ad accedere', 'Salva i tempi anche online' in await pg.inner_text('#accountBtn'))
    # email sbagliata, poi codice sbagliato, poi giusto
    await pg.click('#accountBtn'); await pg.fill('#loginEmail', 'luca@'); await pg.click('[data-x=send]')
    check('Email non valida: messaggio di errore', await pg.is_visible('#loginErr'))
    await pg.fill('#loginEmail', 'Luca@Example.com'); await pg.click('[data-x=send]')
    await pg.wait_for_selector('[data-x=havecode]')
    txt = await pg.inner_text('#modalBody')
    check("Invio email: \"Controlla l'email\", link che riporta all'app", 'tocca il link' in txt and sb.otp_redirect == URL, (txt[:60], sb.otp_redirect))
    await pg.click('[data-x=havecode]')
    await pg.fill('#loginCode', '999999'); await pg.click('[data-x=ok]'); await pg.wait_for_timeout(300)
    err = await pg.inner_text('#codeErr')
    check('Codice sbagliato: "Codice sbagliato o scaduto"', 'sbagliato' in err, err)
    await pg.fill('#loginCode', FakeSupabase.CODE); await pg.click('[data-x=ok]')
    await pg.wait_for_selector('#syncLine'); await pg.wait_for_timeout(800)
    card = await pg.inner_text('#accountBtn')
    check('Accesso fatto: la home mostra l\'email', 'luca@example.com' in card, card)
    sid = await pg.evaluate('db.sessions[0].id')
    row = sb.rows.get(sid)
    check('Dopo l\'accesso la sessione già fatta viene inviata', row and row['data']['riders'][0]['runs'][0]['ms'] > 0 and row['owner'] == 'user-1', row and row.get('owner'))
    check('Stato: "Tutto salvato online"', 'Tutto salvato online' in await pg.inner_text('#syncLine'))
    # nuovo tempo: parte da solo dopo qualche secondo
    await pg.goto(URL + '#s/' + sid); await tap(pg, 0); await pg.wait_for_timeout(600); await tap(pg, 0)
    await pg.wait_for_timeout(5000)
    check('Nuovo tempo inviato in automatico (~4 s)', len(sb.rows[sid]['data']['riders'][0]['runs']) == 2, len(sb.rows[sid]['data']['riders'][0]['runs']))
    # senza rete: resta in coda e parte al ritorno della rete
    sb.down = True
    await tap(pg, 0); await pg.wait_for_timeout(600); await tap(pg, 0); await pg.wait_for_timeout(5000)
    await pg.goto(URL); await pg.wait_for_timeout(300)
    line = await pg.inner_text('#syncLine')
    check('Senza rete: "1 da inviare", tempi al sicuro sul telefono', '1 da inviare' in line and len(sb.rows[sid]['data']['riders'][0]['runs']) == 2, line)
    sb.down = False
    await pg.evaluate("window.dispatchEvent(new Event('online'))"); await pg.wait_for_timeout(1500)
    check('Tornata la rete: inviato da solo', len(sb.rows[sid]['data']['riders'][0]['runs']) == 3)
    # motocross con manche
    await create(pg, ['Marco'], mode='mx', minutes=1); await tap(pg, 0)
    for i in range(3): await pg.wait_for_timeout(2100); await tap(pg, 0)
    await pg.evaluate('syncNow()')
    mx = [r for r in sb.rows.values() if r['mode'] == 'mx']
    check('Motocross: manche e giri salvati online', mx and len(mx[0]['data']['riders'][0]['manches'][0]['laps']) == 3, mx and mx[0]['data']['riders'][0]['manches'])
    # eliminazione
    await pg.goto(URL); box = await pg.locator('.session-card').first.bounding_box()
    await pg.mouse.move(box['x'] + 40, box['y'] + 30); await pg.mouse.down(); await pg.wait_for_timeout(700); await pg.mouse.up()
    await pg.click('[data-x=del]'); await pg.click('[data-x=ok]')
    await pg.evaluate('syncNow()')
    check('Sessione eliminata sul telefono: eliminata anche online', sb.rows[mx[0]['id']]['deleted'] is True and sb.rows[mx[0]['id']]['data'] is None)
    check('Nessun errore JavaScript', not errs, errs)
    await b.close()

    # telefono nuovo: dopo l'accesso ritrovo le sessioni
    b = await p.chromium.launch(); ctx = await b.new_context(); pg2 = await ctx.new_page()
    await pg2.route('**/api/interpreter', lambda r: r.abort()); await sb.attach(pg2)
    await pg2.goto(URL + '#access_token=tok&expires_at=1&expires_in=3600&refresh_token=ref&token_type=bearer&type=magiclink')
    await pg2.wait_for_selector('#syncLine'); await pg2.wait_for_timeout(1000)
    check("Link nell'email: l'app si apre con l'accesso fatto", 'luca@example.com' in await pg2.inner_text('#accountBtn'))
    check("Link nell'email: i dati di accesso spariscono dall'indirizzo", 'access_token' not in await pg2.evaluate('location.href'))
    n = await pg2.locator('.session-card').count()
    check('Telefono nuovo: dopo l\'accesso ritrova le sue sessioni (1, non quella eliminata)', n == 1, n)
    # eliminata da un altro telefono -> sparisce anche qui
    sb.rows[sid].update({'deleted': True, 'data': None})
    await pg2.evaluate('syncNow()'); await pg2.wait_for_timeout(300)
    n = await pg2.locator('.session-card').count()
    check('Eliminata da un altro telefono: sparisce anche qui', n == 0, n)
    # link scaduto
    b3 = await p.chromium.launch(); pg3 = await (await b3.new_context()).new_page(); await sb.attach(pg3)
    await pg3.goto(URL + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
    await pg3.wait_for_timeout(300)
    t = await pg3.inner_text('#toast')
    check('Link scaduto: messaggio chiaro, nessun accesso', 'scaduto' in t and await pg3.evaluate("localStorage.getItem('ec.auth')") is None, t)
    await b3.close()
    # uscita
    await pg2.click('#accountBtn'); await pg2.click('[data-x=out]'); await pg2.click('[data-x=ok]'); await pg2.wait_for_timeout(300)
    check('Esci: torna l\'invito ad accedere', 'Salva i tempi anche online' in await pg2.inner_text('#accountBtn'))
    check('Esci: accesso cancellato dal telefono', await pg2.evaluate("localStorage.getItem('ec.auth')") is None)
    await b.close()


async def main():
    async with async_playwright() as p:
        for t in (test_enduro, test_mx_manche, test_mx_extra, test_mx_free, test_places, test_offline_and_ui, test_realtime, test_sync):
            try:
                await t(p)
            except Exception as e:
                check(f'{t.__name__} completato senza eccezioni', False, repr(e)[:300])
    ok = sum(1 for r in results if r[1])
    print(f'\nRISULTATO: {ok}/{len(results)} test superati')
    sys.exit(0 if ok == len(results) else 1)

asyncio.run(main())
