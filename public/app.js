// clone-me — klienten för det levande samtalet.
//
// Stafetten: ett ElevenLabs-samtal kan inte byta röst. När servern har en ny klon startar vi därför ett
// andra samtal i bakgrunden (mikrofon av, ljud av) med den nya rösten och samtalet hittills i prompten.
// Nästa gång den aktiva agenten pratat klart tar det nya samtalet över mikrofonen och det gamla läggs på.
//
// Det går inte att starta ett samtal med mikrofonen redan avstängd, så det nya samtalet kopplas upp medan
// agenten pratar (då lyssnar klienten). Säger det väntande samtalet ändå något kastas det och görs om.
import { Conversation } from 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.35.0/+esm';
import * as hud from './hud.js';

const $ = (id) => document.getElementById(id);
const CHUNK_MS = 10_000;
const POLL_MS = 2_000;
const STANDBY_MAX_MS = 45_000;
const RELAY_WAIT_MAX_MS = 20_000; // väntar vi så här länge på att agenten ska prata, kopplar vi upp ändå

const params = new URL(location.href).searchParams;
// Varje körning är ett tomt blad: ny deltagare för varje klick. ?p= används bara av provskripten.
let pid = params.get('p');
let live = null;
let call = null;
let idlePoll = null;

function log(...a) { console.log('[cm]', ...a); }
function note(text) { log(text); if (pid) api('POST', `/api/p/${pid}/note`, { text }).catch(() => {}); }

async function api(method, url, body, extra = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(extra.headers || {}) },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
const b64 = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));

// ---------- vy ----------
function render() { if (call) hud.update(live); }

async function refresh() {
  live = await api('GET', `/api/p/${pid}/live`);
  render();
  if (call) onLive();
  clearTimeout(idlePoll);
  if (!call && (live.jobs.cloning || live.jobs.analyzing)) idlePoll = setTimeout(refresh, POLL_MS);
}

// ---------- start ----------
async function boot() {
  history.replaceState(null, '', location.pathname);
  if (pid && params.get('autocall') === '1') { await refresh().catch(() => {}); startCall(); }
}

// ---------- samtalet ----------
$('go').onclick = () => { if (!call) startCall(); };
$('endBtn').onclick = () => endCall();
const t = () => (performance.now() - call.t0) / 1000;

async function startCall() {
  if (call) return;
  const booting = hud.dialing();
  try {
    if (!pid) { live = await api('POST', '/api/p', { test: params.get('test') }); pid = live.pid; }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    call = {
      stream, t0: performance.now(), speaking: [], open: null, queue: [], all: [], uploads: Promise.resolve(),
      active: null, standby: null, relaying: false, relayWanted: 0, sentContextSeq: live?.contextSeq || 0, ending: false,
    };
    const start = await api('POST', `/api/p/${pid}/start`);
    call.active = await openSession('A', start);
    await booting;
    hud.start(stream, pid);
    hud.setOutput(() => { try { return call?.active?.convo.getOutputByteFrequencyData(); } catch { return null; } });
    startRecorder();
    call.chunkTimer = setInterval(rotateRecorder, CHUNK_MS);
    call.pollTimer = setInterval(() => refresh().catch(() => {}), POLL_MS);
    refresh().catch(() => {});
  } catch (e) {
    console.error(e);
    if (call) { call.stream.getTracks().forEach((x) => x.stop()); call = null; }
    hud.idle();
  }
}

let sessCount = 0;
async function openSession(kind, start) {
  const sess = { id: ++sessCount, kind, voiceId: start.voiceId, voiceSeq: start.voiceSeq || 0, convo: null, mode: 'listening', born: performance.now() };
  sess.convo = await Conversation.startSession({
    conversationToken: start.conversationToken,
    connectionType: 'webrtc',
    overrides: start.overrides,
    onModeChange: ({ mode }) => onMode(sess, mode),
    onMessage: (m) => onMessage(sess, m),
    onDisconnect: (d) => onDisconnect(sess, d),
    onError: (e) => note(`fel i samtal ${sess.id}: ${e?.message || e}`),
  });
  return sess;
}

function onMessage(sess, m) {
  if (!m?.message) return;
  const role = m.source === 'user' ? 'user' : 'agent';
  if (sess !== call?.active) {
    if (role === 'agent' && sess === call?.standby) discardStandby(`sa "${m.message.slice(0, 50)}"`);
    return;
  }
  const line = { role, message: m.message, t: Math.round(t() * 10) / 10 };
  call.queue.push(line);
  call.all.push(line);
  hud.line(line);
}

function onMode(sess, mode) {
  if (!call) return;
  if (sess !== call.active) {
    sess.mode = mode;
    if (mode === 'speaking' && sess === call.standby) discardStandby('började prata');
    return;
  }
  const was = sess.mode;
  sess.mode = mode;
  if (mode === 'speaking' && call.open == null) call.open = t();
  if (mode !== 'speaking' && call.open != null) { call.speaking.push([call.open, t()]); call.open = null; }
  hud.speaking(mode === 'speaking' ? 'synth' : 'idle');
  // Uppkopplingen sker medan agenten pratar; bytet precis när den pratat klart.
  if (mode === 'speaking' && call.relayWanted && !call.standby && !call.relaying) prepareRelay();
  if (was === 'speaking' && mode !== 'speaking' && call.standby?.ready && call.standby.mode !== 'speaking') handoff();
}

function onDisconnect(sess, d) {
  if (!call || sess.retired) return;
  if (sess === call.standby) { note(`väntande samtal ${sess.id} kopplades ner (${d?.reason})`); call.standby = null; return; }
  if (sess === call.active && !call.ending) {
    if (d?.reason === 'user') return endCall();
    recover(`samtal ${sess.id} föll bort (${d?.reason}${d?.message ? ': ' + d.message : ''})`);
  }
}

// ---------- uppdateringar från servern ----------
function onLive() {
  const a = call.active;
  if (!a) return;
  if (live.contextSeq > call.sentContextSeq) {
    a.convo.sendContextualUpdate(live.contextText);
    call.sentContextSeq = live.contextSeq;
    note(`språkuppdatering ${live.contextSeq} skickad till samtal ${a.id}`);
    hud.feed('BETEENDEMODELL SYNKRONISERAD MED SYNTESEN');
  }
  if (live.voiceSeq > a.voiceSeq && !call.standby && !call.relaying) {
    if (!call.relayWanted) call.relayWanted = performance.now();
    // Pratar agenten redan, eller har vi väntat länge, kopplar vi upp nu. Annars i onMode().
    if (a.mode === 'speaking' || performance.now() - call.relayWanted > RELAY_WAIT_MAX_MS) prepareRelay();
  }
  if (call.standby?.ready && performance.now() - call.standby.readyAt > STANDBY_MAX_MS) {
    note(`väntande samtal ${call.standby.id} fick aldrig ta över — läggs på`);
    retire(call.standby); call.standby = null;
  }
}

async function prepareRelay() {
  call.relaying = true;
  try {
    // Skicka med transkriptraderna som inte laddats upp än, så att det nya samtalet vet allt.
    const pending = call.queue.splice(0);
    const allIdx = call.all.length;
    const start = await api('POST', `/api/p/${pid}/relay`, { transcript: pending });
    const sess = await openSession('B', start);
    sess.allIdx = allIdx;
    sess.contextSeq = start.contextSeq;
    call.relayWanted = 0;
    sess.convo.setMicMuted(true);
    sess.convo.setVolume({ volume: 0 });
    if (!call || call.ending) { retire(sess); return; }
    sess.ready = true;
    sess.readyAt = performance.now();
    sess.connectMs = Math.round(sess.readyAt - sess.born);
    call.standby = sess;
    note(`samtal ${sess.id} väntar med ny röst (uppkopplat på ${sess.connectMs} ms)`);
  } catch (e) {
    note('stafetten kunde inte förberedas: ' + e.message);
  } finally {
    if (call) call.relaying = false;
  }
}

function discardStandby(why) {
  const s = call.standby;
  note(`väntande samtal ${s.id} ${why} — kastas, görs om`);
  call.standby = null;
  retire(s);
  call.relayWanted = performance.now();
}

// Det aktiva samtalet föll bort: ta över med det väntande, eller koppla upp ett nytt direkt.
async function recover(why) {
  note(why + ' — kopplar om');
  hud.feed('SIGNALAVBROTT · ÅTERANSLUTER', 'crit');
  if (call.standby?.ready) return handoff();
  try {
    const start = await api('POST', `/api/p/${pid}/relay`, { transcript: call.queue.splice(0) });
    if (!call || call.ending) return;
    const sess = await openSession('R', start);
    sess.contextSeq = start.contextSeq;
    const dead = call.active;
    call.active = sess;
    call.sentContextSeq = start.contextSeq;
    if (dead) retire(dead);
    hud.feed('ANSLUTNING ÅTERSTÄLLD');
    note(`samtal ${sess.id} tog över efter avbrottet`);
    api('POST', `/api/p/${pid}/handoff`, { voiceId: sess.voiceId }).catch(() => {});
  } catch (e) {
    note('kunde inte koppla om: ' + e.message);
    endCall();
  }
}

function handoff() {
  const A = call.active, B = call.standby;
  const t0 = performance.now();
  try { A.convo.setMicMuted(true); } catch {}
  const heardSince = call.all.slice(B.allIdx);
  if (heardSince.length) {
    B.convo.sendContextualUpdate('Det här sades alldeles nyss, precis innan du tog över:\n'
      + heardSince.map((x) => `${x.role === 'user' ? 'Klienten' : 'Du'}: ${x.message}`).join('\n'));
  }
  call.sentContextSeq = B.contextSeq; // relä-prompten bar profilen fram till hit; nyare skickas av onLive()
  B.convo.setVolume({ volume: 1 });
  B.convo.setMicMuted(false);
  call.active = B; call.standby = null;
  retire(A);
  const ms = Math.round(performance.now() - t0);
  note(`stafettbyte: samtal ${A.id} → ${B.id}`);
  hud.feed(B.voiceSeq ? `RÖSTMODELL V${B.voiceSeq} INKOPPLAD I SYNTESEN` : 'SYNTES OMKOPPLAD', 'warn');
  api('POST', `/api/p/${pid}/handoff`, { voiceId: B.voiceId, ms }).catch(() => {});
}

function retire(sess) {
  sess.retired = true;
  try { sess.convo.setMicMuted(true); } catch {}
  sess.convo.endSession().catch(() => {});
}

// ---------- ljudbitar ----------
function startRecorder() {
  const r = new MediaRecorder(call.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
  r.parts = []; r.startAt = t();
  r.ondataavailable = (e) => e.data.size && r.parts.push(e.data);
  r.onstop = () => queueUpload(new Blob(r.parts, { type: 'audio/webm' }), r.startAt, r.stopAt);
  r.start();
  call.rec = r;
}
function rotateRecorder() {
  const old = call.rec;
  startRecorder();       // ny först, så att inget tal tappas mellan bitarna
  old.stopAt = t();
  old.stop();
}
function queueUpload(blob, a, b) {
  const intervals = [...call.speaking, ...(call.open != null ? [[call.open, b]] : [])]
    .map(([x, y]) => [Math.max(x, a) - a, Math.min(y, b) - a])
    .filter(([x, y]) => y > x);
  const transcript = call.queue.splice(0);
  const c = call;
  c.uploads = c.uploads.then(() =>
    api('POST', `/api/p/${pid}/chunk`, blob, { headers: { 'content-type': 'audio/webm', 'x-meta': b64({ agentSpeaking: intervals, transcript }) } })
      .then((l) => { live = l; render(); if (call) onLive(); })
      .catch((e) => note('ljudbiten kom inte fram: ' + e.message)));
}

async function endCall() {
  if (!call || call.ending) return;
  call.ending = true;
  const c = call;
  clearInterval(c.chunkTimer); clearInterval(c.pollTimer);
  hud.feed('AVLYSSNING AVSLUTAS', 'warn');
  if (c.standby) retire(c.standby);
  if (c.active) retire(c.active);
  log('avslut: väntar på sista ljudbiten');
  await new Promise((res) => { const r = c.rec; r.stopAt = t(); const prev = r.onstop; r.onstop = () => { prev(); res(); }; r.stop(); });
  log('avslut: laddar upp');
  await c.uploads;
  log('avslut: uppladdat');
  c.stream.getTracks().forEach((x) => x.stop());
  call = null;
  // Körningen är slut: servern raderar allt, skärmen visar raderingen, nästa klick börjar med en ny deltagare.
  const erased = await api('POST', `/api/p/${pid}/end`).catch(() => null);
  if (erased) await hud.erase(erased);
  else hud.feed('RADERINGEN KUNDE INTE BEKRÄFTAS', 'crit');
  hud.idle();
  pid = null; live = null;
}

boot();
