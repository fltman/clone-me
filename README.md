# clone-me

Ett experiment: en röstagent i ElevenLabs som under samtalens gång blir mer och mer lik den den pratar med.
Den låter som du, heter som du, har dina intressen och använder dina ord.

## Kör

```sh
npm install
./start.sh scripts/setup.mjs   # en gång: grundröst, referensprov, agent → config.json
./start.sh                     # http://localhost:8350
```

`start.sh` läser `ELEVENLABS_API_KEY` och `ANTHROPIC_API_KEY` ur `~/.zprofile`. Använd hörlurar.

## Så funkar det

Ett enda långt samtal. Förvandlingen styrs av hur många sekunder av ditt tal agenten har samlat.

- **Ljudbitar:** sidan spelar in mikrofonen separat (med ekosläckning) och skickar en bit var 10:e sekund, tillsammans med när agenten pratade och nya transkriptrader. Servern tystar agentens intervall och klipper bort tystnad. Kvar blir ditt rena tal.
- **Språket, live:** högst var 30:e sekund läser Claude (`claude-opus-5-5`, effort low) hela samtalet och uppdaterar profilen, alltså fakta och idiolekt. Sidan skickar den till agenten med `sendContextualUpdate()`, utan att avbryta.
- **Rösten, live (stafettbyte):** ett ElevenLabs-samtal kan inte byta röst. När en ny klon är klar startar sidan ett andra samtal med mikrofon och ljud avstängda, med den nya rösten och samtalet hittills i prompten. När den aktiva agenten pratat klart nästa gång tar det nya samtalet över mikrofonen och det gamla läggs på. Uppkopplingen tar ungefär 1 s och görs medan agenten pratar, eftersom ett samtal inte kan startas med mikrofonen avstängd. Själva bytet tar under 2 ms. Säger det väntande samtalet något kastas det och görs om. Faller det aktiva samtalet bort tar ett nytt över automatiskt.
- **Kloner:** alltid 100 % ditt tal. Första klonen tränas så fort det finns 3 s tal. Under 30 s upprepas klippen tills de fyller 30 s, och en ny klon görs för varje nytt klipp. Därefter slås klippen bara ihop (högst 240 s), med en ny klon för varje 20 s nytt tal. Gamla kloner raderas, så högst tre röstplatser används per deltagare: den som hörs, den ett väntande samtal har fått och den senaste.

Grundrösten (Elin) hörs bara tills första klonen är klar, ungefär 15 s in i samtalet. Språket följer en egen kurva:

| Ditt tal | Fas | Likhet i språket |
|---|---|---|
| 0–10 s | främlingen | 0 |
| 45 s | likheterna | 0,35 |
| 90 s | spegeln | 0,7 |
| 140 s+ | dubbelgångaren | 1,0 |

Kurvorna och texterna finns i `lib/persona.mjs`, analysen i `lib/analyze.mjs` och ljudstegen i `lib/audio.mjs`. Stafetten finns i `public/app.js`.

## Prov

- `./start.sh test/relay.mjs 150` provkör stafetten och raderingen i Chrome utan fönster, med `test/fixtures/fake_mic.wav` som mikrofon. Provläget växlar mellan två färdiga röster, så inga kloner tränas.
- `./start.sh test/relay.mjs 200 --clone` gör samma sak med riktiga kloner.
- `./start.sh test/pipeline.mjs <tmpdir> [--clone]` provar ljudutplock, analys och kloning utan webbläsare.

Provdeltagarna ligger kvar i `data/p/` tills de raderas med `DELETE /api/p/<id>`.

## Gränssnittet

Byggt för att visas på en videokanon inför en stor publik. All text skalar med skärmbredden.

- **Vila:** en militär vippbrytare under ett skyddslock, utan text. Ett klick fäller upp locket, slår om brytaren och visar en kort uppstartstext medan samtalet kopplas upp.
- **Samtalet:** en analytikerskärm i stil med en gammal terminal, med identitet, familjeförhållanden, intressen, typiska fraser, utfyllnadsord, röstsignatur och en händelselogg som skriver fram vad som upptäcks. En nivåtavla 4 → 1 följer faserna. Allt som visas kommer ur samtalet, ur serverns händelser och ur mikrofonen. Grundtonen mäts med autokorrelation.
- **Avslut:** servern raderar allt. Därefter visar skärmen raderingen i pulserande rött, byggd på vad som faktiskt raderades, och sist "SUBJEKT RADERAT".

## Data

Varje körning börjar från noll: ett klick på brytaren skapar en ny deltagare. Under samtalet ligger ljud, transkript och profiler i `data/p/<id>/`. "AVSLUTA OCH RADERA" raderar deltagarens kloner hos ElevenLabs och hela mappen. Körningar som aldrig avslutades ordentligt (stängd flik, tappat nät) raderas automatiskt efter 15 minuter.
