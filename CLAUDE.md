# Enduro Crono — guida per Claude Code

Web app (PWA) per cronometrare gli allenamenti di **enduro** e **motocross**, usata dal telefono a bordo pista.
Stato: **beta aperta agli amici** (dal 29/09/2026 Luca manda il link a 10–15 amici per ~2 settimane). App pubblicata: https://lucacavo92-wq.github.io/enduro-crono/

## Come lavorare con Luca
- Scrivi sempre in **italiano**, frasi semplici, niente gergo tecnico se non serve.
- Lavora in autonomia. Quando serve un'azione sua (accesso, autorizzazione, clic su "Authorize"), **mandagli una notifica** e **spiega a cosa serve** quell'autorizzazione prima di chiederla.
- Una cosa alla volta quando deve fare dei passaggi manuali; lui risponde spesso solo con **"y"** = fatto / sì.
- Prova tu l'app (test automatici) invece di chiedergli di testare; a lui restano solo le prove sul telefono vero.
- Luca preferisce che Claude faccia da sé anche le configurazioni nei pannelli web (Supabase, Google Cloud) col **browser integrato**, dove è già autenticato; a lui solo ciò che il controllo di sicurezza blocca (password/segreti, spegnere protezioni, regole di accesso).
- Promemoria richiesto da Luca: quando si torna sul riconoscimento piste, **ricordagli di valutare Google Places** al posto di OpenStreetMap (serve una chiave a pagamento).

## Struttura
Nessun build, nessuna dipendenza: HTML + CSS + JavaScript puro.
- `index.html` — guscio della pagina
- `app.js` — tutta la logica (viste, cronometri, analisi, GPS)
- `style.css` — stile (colore principale **verde ottanio** `#0d6b5e`, in tema scuro `#10806f`; stesso colore nello sfondo delle icone, tema chiaro/scuro)
- `sw.js` — service worker per l'uso **offline**. **Ad ogni modifica di file incrementa `CACHE`** (`ec-vN`) **e `APP_VERSION` in app.js allo stesso valore**, altrimenti i telefoni restano sulla versione vecchia.
- `manifest.webmanifest`, `icons/` — installazione sulla schermata home
- `privacy.html` — informativa privacy (italiano). Email di contatto dedicata: `lcr.racing.ge@gmail.com` (costante `CONTACT_EMAIL` in fondo alla pagina)
- `tests/run_tests.py` — 119 test automatici (Playwright + Chromium, orologio simulato, Supabase finto `FakeSupabase`)
- `supabase/` — SQL già eseguito sul database (tenere come storico, numerati)

## Pubblicazione
Push su `main` → GitHub Pages pubblica da sola in ~1 minuto (repo `lucacavo92-wq/enduro-crono`, sorgente: branch `main`, cartella root).
Luca aggiorna l'app chiudendola e riaprendola (a volte due volte).

PC Windows di Luca: git e python non sono nel PATH della shell di Claude, usare i percorsi completi
`C:\Program Files\Git\cmd\git.exe` e `%LOCALAPPDATA%\Programs\Python\Python312\python.exe` (Playwright + Chromium già installati).
Accesso GitHub già salvato in Git Credential Manager (metodo "device code"): `git push` funziona senza chiedere nulla.

## Test
```
"$LOCALAPPDATA/Programs/Python/Python312/python.exe" -m http.server 8765 &   # dalla cartella enduro-crono
"$LOCALAPPDATA/Programs/Python/Python312/python.exe" tests/run_tests.py      # PYTHONIOENCODING=utf-8
```
Alla fine fermare il server (porta 8765). Anteprima nel browser integrato: `.claude/launch.json` nella cartella superiore (`App_Crono`), nome `enduro-crono`.
Lanciali prima di ogni push. Il test usa `page.clock` (install + `pause_at`): il tempo avanza solo con `advance()`; non usare `run_for` su intervalli lunghi (requestAnimationFrame lo rende lentissimo).
Non coperto dai test: Safari/iPhone, vibrazione, schermo sempre acceso, GPS reale.

## Dati (tutto in `localStorage`, chiave `ec.v1`)
```
{ sessions: [...], riderNames: [...], tracks: [{name, lat, lon, lastUsed}], mxDefaults, lastMode,
  sync: { user, sent: {sessionId: hash}, deleted: [ids], lastAt } }
accesso online: chiave separata `ec.auth` = { access_token, refresh_token, expires_at, user:{id,email,name,avatar,username}, profile:{username,avatar_url} }
altre chiavi: `ec.welcome` (benvenuto già visto), `ec.feedback` (commenti in coda offline)
sessione: { id, createdAt, mode: 'enduro'|'mx', track: {name, lat, lon, acc, auto, pending, source},
            visibility: 'private', mx?: {free:true} | {manches, durationMs, extraLaps},
            riders: [{ id, name, startedAt, runs:[{id, ms, at}], manches:[...] }] }
manche/turno mx: { startedAt, laps:[{id, ms, at}], status:'running'|'done'|'stopped',
                   expired, afterExpiry, goalReached, goalAt, goalLaps, endedAt }
```
Regole importanti:
- I tempi si calcolano **sempre da timestamp** (`eventTime(e)` = istante del tocco), mai contando tick.
- Enduro: START/STOP per pilota, antirimbalzo 350 ms. La X annulla il tempo in corso (non salvato).
- Motocross manche: l'obiettivo scatta al **primo passaggio dopo lo scadere** (+N giri se `extraLaps`); dopo l'obiettivo **si continua a prendere i giri** finché non si chiude con la X. Antirimbalzo 2 s.
- Motocross allenamento libero: turni senza limiti, chiusi con la X (conta l'istante del tocco sulla X).
- Elimina passaggio: il tempo del giro eliminato si somma al giro successivo (totale invariato).
- Giri/tempi mostrati dal più recente al più vecchio.
- Durata manche minima **1 minuto solo per la beta** (`LIMITS` in `viewNew`): riportarla a 3 prima del rilascio.

## Riconoscimento pista (nuova sessione, automatico)
GPS → piste proprie entro 600 m → piste ufficiali OpenStreetMap (Overpass, raggio **2 km**, la più vicina con nome) → località (Nominatim) → senza rete coordinate, nome risolto al ritorno della rete (`resolvePending`). Un nome scritto a mano non viene mai sovrascritto.

## Supabase (collegato: accesso + sincronizzazione)
- Progetto `enduro-crono`, id **`fhiprgjadehxtpispyvr`**, regione eu-central-1, piano Free, organizzazione `tuubtxvbnqxsoulhhjql`.
- Tabelle con RLS: `profiles`, `tracks`, `sessions` (visibility `private|friends|public`), `runs` (non usata per ora), `friendships`; funzione `private.are_friends`.
- `sessions` ha in più `mode`, `data` (jsonb = sessione intera come in localStorage), `deleted` (eliminazione "morbida"). `owner` → `auth.users`, niente profilo obbligatorio. `track_name` NOT NULL.
- App: chiamate REST dirette (nessuna libreria), chiave pubblica `sb_publishable_…` in `app.js` (`SB_KEY`). Sezione "ACCOUNT E SINCRONIZZAZIONE" in `app.js`.
- Sincronizzazione: `save()` → `scheduleSync()` (4 s); invia le sessioni la cui impronta (`sessionHash`) è cambiata; scarica quelle presenti solo online; riprova a rete tornata / app riaperta. Il telefono vince sui conflitti.
- "Come funziona" (3 passi: sessione, START/STOP/GIRO/X, risultati): `howtoHtml()` dentro il benvenuto e in `howtoModal()` dal link "❓ Come funziona" in fondo alla home.
- Primo avvio: schermata di benvenuto (`viewWelcome`, chiave `ec.welcome`): **Registrati** / Ho già un account · Accedi / Usa senza account.
- Account come un social: registrazione con **Google** oppure **nome da rider + email + password**; accesso con password; "Password dimenticata?" (email di recupero → `type=recovery` → nuova password).
- Profilo: tabella `profiles` (`username` unico, `avatar_url`), leggibile da tutti. Nome scelto al primo accesso (`usernameModal`). Avatar: foto Google, oppure caricata (ritagliata 256 px) nel bucket pubblico `avatars/<user id>/avatar.jpg`; senza foto iniziali su colore.
- Barra in alto: `BETA` accanto al titolo (solo sulle schermate "Enduro Crono"); a destra "Accedi" oppure avatar + nome (dentro una sessione solo avatar). Riquadro account in fondo alla home.
- Google: pulsante ufficiale Google Identity Services (`id_token` → `/auth/v1/token?grant_type=id_token`, con nonce): niente pagine esterne nella cronologia (bug del tasto indietro). Se lo script Google non carica: riserva con redirect (`location.replace`).
- **Google**: Google Cloud progetto `my-project-1525955660843` ("My Project", account luca.cavo92@gmail.com), client OAuth web "Enduro Crono (Supabase)" `119615516276-0mte5fajfe55t5ek3gfrvqggsnmb9jfg.apps.googleusercontent.com`, redirect `https://fhiprgjadehxtpispyvr.supabase.co/auth/v1/callback`. App Google **in produzione** dal 2026-09-28 (accedono tutti). Scheda: home + link privacy compilati, **logo volutamente vuoto** (caricarlo obbliga alla verifica Google). Client secret in uso …f04Q; il vecchio …RAkQ è disattivato (non eliminato).
- Luca usa Android. Conferma email alla registrazione: da tenere **spenta** per la beta (la posta gratuita di Supabase scrive solo agli indirizzi del team); riaccenderla con SMTP proprio. Site URL in Supabase = `https://lucacavo92-wq.github.io/enduro-crono/`. Conferma email **spenta** (verificato 29/09: `mailer_autoconfirm: true` in `/auth/v1/settings`). Posta predefinita Supabase: niente modelli modificabili, poche email/ora, solo indirizzi del team → "password dimenticata" funziona solo per Luca finché non c'è SMTP proprio. Agli amici consigliare **Continua con Google**.
- Commenti dei tester: tabella `feedback` (solo inserimento, anche anonimo; si legge dal pannello o con `execute_sql`). In app: "Invia un commento" in home e nel profilo, coda offline `ec.feedback`.
- Elimina account: funzione `public.delete_my_account()` (security definer, solo sull'utente che chiama; cascata su profiles/sessions/friendships). L'app prima toglie la foto via Storage API. Avviso del linter "security definer eseguibile" = voluto.
- Da fare: "Leaked password protection" spenta (avviso linter).
- Il connettore Supabase in Claude Code: `execute_sql` funziona per leggere e per creare tabelle/funzioni/bucket; il controllo di sicurezza blocca **togliere** regole di accesso e spegnere protezioni (es. "Confirm email"), e maneggiare segreti (client secret) → li fa Luca.
- Leggere i commenti dei tester: `select created_at, message, app_version, device, page from feedback order by created_at desc`.

## Efficienza (token/sessioni) — deciso 28/09/2026
- **Una sessione, un macro-obiettivo.** Chiuso un capitolo (es. "login e sync"), se il prossimo è un progetto diverso (es. "funzioni social"), aprire una sessione nuova invece di continuare quella vecchia: ogni messaggio in una sessione lunga rilegge tutta la storia precedente.
- **Questo file è la memoria, non la chat.** Decisioni stabili (schema dati, credenziali/id di servizio, convenzioni) vanno scritte qui appena prese, non lasciate solo nella conversazione.
- **Piano prima di eseguire** per lavori con molti passaggi: proporre una lista breve e aspettare conferma prima di eseguire tutto, così Luca corregge la direzione con un messaggio invece che a lavoro fatto.
- **File pesanti fuori dalla chat**: salvare su disco e riferirsi al percorso, non incollarli/descriverli per esteso.
- Se una richiesta di Luca è in sospeso (es. un "ok" da dare), rispondere a quella prima di procedere oltre.
- **Segnalare il cambio di sessione.** Quando un capitolo/macro-obiettivo è concluso e il prossimo è chiaramente un argomento diverso, dirlo esplicitamente a Luca (e, se possibile, mandare una notifica push): spiegare che quella parte è chiusa, che lo stato è già scritto in questo file, e proporre di aprire una sessione nuova su questa stessa cartella per il prossimo pezzo. Non aprirla da soli: la crea Luca dall'app.

## Beta con gli amici (29/09/2026)
- Messaggio aggiornato (29/09, con "Come funziona"): `../messaggio_amici.txt` (fuori dal repo). Piano Play Store a fasi: `../PIANO_PLAY_STORE.md` (fuori dal repo). Luca ha altri progetti con priorità: il Play Store non è urgente.
- Nota tecnica: senza dominio proprio l'`assetlinks.json` per la TWA andrebbe nel repo `lucacavo92-wq.github.io` (radice dell'origine), non in `enduro-crono`.
- Messaggio WhatsApp già dato a Luca (link + installazione Android/iPhone + "Registrati → Continua con Google" + "Invia un commento"). Gruppo consigliato "Enduro Crono beta".
- Durante la prova: su richiesta ("leggi i commenti") riassumere la tabella `feedback` e quante sessioni fa ogni utente (`sessions` per `owner`, join `profiles`).
- Dopo ~2 settimane: preparare 5 domande per i tester. Chi partecipa può fare da tester Play Store (servono 12 tester × 14 giorni).

## Prossimi passi
1. **Parte social** (prossima sessione): amici (`friendships`, `private.are_friends`), visibilità per sessione privato/amici/tutti (`sessions.visibility`, già nelle regole `sessions_read`), tempi degli altri sulla stessa pista, elenco piste. Per provarla con più account: "telefoni virtuali" = più contesti Playwright + copia locale di Supabase (Docker Desktop, da installare) — sul database vero Claude non può creare account finti.
2. Dominio proprio (~10 €/anno) → SMTP (Resend/Brevo) per email vere + base per Play Store (assetlinks) + riaccendere conferma email.
3. Play Store: app Android (TWA, es. Bubblewrap/PWABuilder), account sviluppatore 25 $ (lo apre Luca), logo nella scheda Google (→ verifica Google), test chiuso 12 tester × 14 giorni.
4. Registrazione della **traccia GPS** del percorso e condivisione.
5. Recupero con conto alla rovescia tra le manche (proposto, non ancora chiesto).
6. Prima del rilascio: durata manche minima di nuovo a 3 minuti; "Leaked password protection" (avviso linter).
7. Guadagni (idea, molto più avanti): gratis in beta; poi abbonamento Pro e soprattutto piani per motoclub/scuole; pubblicità sconsigliata.
8. Più avanti: trasponder low cost (dispositivi radio con marcatura CE).
