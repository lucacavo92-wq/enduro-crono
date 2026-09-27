# Enduro Crono (beta)

Cronometro per allenamenti enduro. Web app installabile (PWA), funziona anche senza segnale.

- Più piloti in contemporanea, ognuno con START/STOP
- Ogni tempo registrato, somma, media, migliore (verde) e peggiore (rosso)
- Classifica per miglior tempo e per somma
- Modalità Motocross: manche a tempo (+2 giri opzionali), pulsante GIRO per pilota, grafico dei giri e calo di ritmo
- Posizione GPS della pista, per ritrovarla nelle sessioni successive
- Dati salvati sul telefono; sincronizzazione online (Supabase) in arrivo

App: https://lucacavo92-wq.github.io/enduro-crono/

## Test

```
python3 -m http.server 8765 &
python3 tests/run_tests.py
```
55 test automatici (Chromium, orologio simulato): enduro, manche motocross da 1 minuto con giri ogni 5-7 s, +2 giri, allenamento libero, doppi tocchi, ricarica dell'app, offline, riconoscimento pista, schermo 320 px, 100 sessioni, precisione in tempo reale.
