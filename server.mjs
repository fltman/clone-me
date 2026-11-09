// clone-me — server för det levande samtalet.
// Webbsidan skickar en ljudbit var 20:e sekund (plus nya transkriptrader). Servern plockar ut ditt tal,
// analyserar språket och tränar nya kloner i bakgrunden. Sidan pollar /live och gör stafettbyte till nya röster.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { conversationToken, createClone, deleteVoice } from './lib/eleven.mjs';
import { extractSpeech, concatTail, loopTo, duration } from './lib/audio.mjs';
import { analyze } from './lib/analyze.mjs';
import { progress, buildPrompt, buildRelayPrompt, contextUpdate, firstMessage, FIRST_CLONE_SEC, FILL_SEC, CLONE_EVERY_SEC } from './lib/persona.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8350);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PDIR = path.join(ROOT, 'data', 'p');
fs.mkdirSync(PDIR, { recursive: true });

const MAX_USER_SEC = 240;          // mer än så hjälper inte en Instant Voice Clone
const ANALYZE_EVERY_MS = 30_000;   // språkanalys högst så här ofta
// Provläge för stafetten: växla mellan två färdiga röster i stället för att klona.
const TEST_VOICES = [cfg.baseVoiceId, 'EXAVITQu4vr4xnSDxMaL' /* Sarah, premade */];
const TEST_SWAP_SEC = 8;

// ---------- tillstånd (i minnet, speglat till disk) ----------
const cache = new Map();
const dir = (pid) => path.join(PDIR, pid);
const statePath = (pid) => path.join(dir(pid), 'state.json');
function load(pid) {
  if (!/^[a-f0-9]{12}$/.test(pid)) return null;
  if (cache.has(pid)) return cache.get(pid);
  if (!fs.existsSync(statePath(pid))) return null;
  const st = JSON.parse(fs.readFileSync(statePath(pid), 'utf8'));
  st.jobs = { analyzing: false, cloning: false };
  cache.set(pid, st);
  return st;
}
function save(st) {
  if (st.ended || !fs.existsSync(dir(st.pid))) return; // raderad körning: skriv inget mer
  const { jobs, ...rest } = st;
  fs.writeFileSync(statePath(st.pid), JSON.stringify(rest, null, 2));
}
// kind/data låter skärmen översätta raden till analytikerspråk.
function step(st, text, kind = 'info', data = null) {
  st.steps.push({ t: new Date().toISOString(), text, kind, data });
  if (st.steps.length > 200) st.steps.splice(0, st.steps.length - 200);
  save(st);
  console.log(`[${st.pid}] ${text}`);
}

function live(st) {
  const p = progress(st.speechSec);
  return {
    pid: st.pid, test: st.test || null, calls: st.calls.length,
    speechSec: Math.round(st.speechSec), phase: p.key, likeness: p.likeness,
    voiceId: st.cloneVoiceId || cfg.baseVoiceId, voiceSeq: st.voiceSeq, voiceRealSec: st.voiceRealSec,
    contextSeq: st.contextSeq, contextText: st.contextText,
    jobs: st.jobs, steps: st.steps.slice(-10), error: st.error, profile: st.profile,
  };
}

// ---------- samtal ----------
async function startCall(st) {
  const p = progress(st.speechSec);
  const voiceId = st.cloneVoiceId || cfg.baseVoiceId;
  const token = await conversationToken(cfg.agentId);
  const isFirstCall = st.calls.length === 0;
  st.calls.push({ at: new Date().toISOString(), voiceId });
  st.activeVoiceId = voiceId;
  save(st);
  await cleanupVoices(st);
  kick(st); // finns det redan tillräckligt med tal men ingen klon, börja träna direkt
  step(st, isFirstCall ? 'samtalet börjar' : `nytt samtal (nummer ${st.calls.length})`, 'call', { n: st.calls.length });
  return {
    conversationToken: token, voiceId, voiceSeq: st.voiceSeq,
    overrides: {
      agent: { language: 'sv', firstMessage: firstMessage(st.profile, isFirstCall), prompt: { prompt: buildPrompt(p, st.profile) } },
      tts: { voiceId },
    },
  };
}

async function relay(st) {
  const p = progress(st.speechSec);
  const voiceId = st.cloneVoiceId || cfg.baseVoiceId;
  st.standbyVoiceId = voiceId; // får inte raderas förrän bytet är gjort
  save(st);
  const token = await conversationToken(cfg.agentId);
  return {
    conversationToken: token, voiceId, voiceSeq: st.voiceSeq, contextSeq: st.contextSeq, // vilken profil relä-prompten bygger på
    overrides: {
      agent: { language: 'sv', firstMessage: '', prompt: { prompt: buildRelayPrompt(p, st.profile, st.transcript) } },
      tts: { voiceId },
    },
  };
}

async function handoff(st, voiceId, ms) {
  const prev = st.activeVoiceId;
  st.activeVoiceId = voiceId;
  st.standbyVoiceId = null;
  st.handoffs.push({ at: new Date().toISOString(), from: prev, to: voiceId, ms });
  save(st);
  step(st, `stafettbyte klart${ms ? ` (${ms} ms)` : ''}`, 'handoff', { voiceSeq: st.voices.indexOf(voiceId) >= 0 ? st.voiceSeq : null, ms });
  await cleanupVoices(st);
}

// Radera alla kloner utom den som hörs nu, den ett väntande samtal har fått, och den senaste.
async function cleanupVoices(st) {
  const keep = new Set([st.activeVoiceId, st.standbyVoiceId, st.cloneVoiceId]);
  const gone = [];
  for (const v of st.voices) {
    if (keep.has(v)) continue;
    await deleteVoice(v).catch((e) => console.error('kunde inte radera', v, e.message));
    gone.push(v);
  }
  if (gone.length) { st.voices = st.voices.filter((v) => !gone.includes(v)); save(st); }
}

// Körningen är slut: radera allt — klonerna hos ElevenLabs och ljud, transkript och profiler på disken.
async function endRun(st) {
  if (st.ended) { fs.rmSync(dir(st.pid), { recursive: true, force: true }); cache.delete(st.pid); return st.erased || {}; }
  st.ended = new Date().toISOString();
  let voices = 0;
  for (const v of st.voices) { if (await deleteVoice(v).catch((e) => { console.error('kunde inte radera', v, e.message); return false; })) voices++; }
  const count = (d) => { try { return fs.readdirSync(path.join(dir(st.pid), d)).length; } catch { return 0; } };
  const erased = {
    voices, voiceVersions: st.voiceSeq, audioFiles: count('raw') + count('speech') + count('train'),
    speechSec: Math.round(st.speechSec), lines: st.transcript.length, profiles: count('profiles'),
  };
  st.erased = erased;
  fs.rmSync(dir(st.pid), { recursive: true, force: true });
  cache.delete(st.pid);
  console.log(`[${st.pid}] körningen raderad: ${JSON.stringify(erased)}`);
  return erased;
}

// Städning: kloner från körningar som aldrig avslutades (fliken stängd, nätet borta) raderas efter en stund.
const STALE_MS = 15 * 60_000;
async function sweep() {
  for (const pid of fs.readdirSync(PDIR)) {
    const st = load(pid);
    if (!st) continue;
    const last = Date.parse(st.steps.at(-1)?.t || st.createdAt);
    if (Date.now() - last > STALE_MS) { console.log(`[${pid}] övergiven körning — raderas`); await endRun(st); }
  }
}
setInterval(() => sweep().catch((e) => console.error('städning', e)), 5 * 60_000);
sweep().catch((e) => console.error('städning', e));

// ---------- ljudbitar ----------
async function chunk(st, buf, meta) {
  const n = st.chunks.length + 1;
  const raw = path.join(dir(st.pid), 'raw', `chunk${String(n).padStart(4, '0')}.webm`);
  const speech = path.join(dir(st.pid), 'speech', `chunk${String(n).padStart(4, '0')}.mp3`);
  fs.writeFileSync(raw, buf);
  for (const line of meta.transcript || []) st.transcript.push(line);
  const rawSec = await duration(raw);
  const speechSec = rawSec > 0.3 ? await extractSpeech(raw, meta.agentSpeaking || [], speech) : 0;
  st.chunks.push({ n, rawSec, speechSec, agentSpeaking: meta.agentSpeaking || [] });
  st.speechSec += speechSec;
  save(st);
  if (speechSec >= 1) step(st, `+${speechSec.toFixed(0)} s av din röst (totalt ${st.speechSec.toFixed(0)} s)`, 'voice', { added: speechSec, total: st.speechSec });
  kick(st);
}

// Startar bakgrundsjobb om det är dags. Högst ett av varje sort åt gången.
function kick(st) {
  if (st.ended) return;
  const userLines = st.transcript.filter((t) => t.role === 'user').length;
  if (!st.jobs.analyzing && userLines > st.analyzedUserLines && Date.now() - st.lastAnalysisAt > ANALYZE_EVERY_MS) {
    runAnalysis(st, userLines);
  }
  const p = progress(st.speechSec);
  if (st.jobs.cloning) return;
  if (st.test === 'relay') {
    if (st.speechSec - st.lastCloneSpeech >= TEST_SWAP_SEC) runTestSwap(st);
  } else if (st.speechSec >= FIRST_CLONE_SEC) {
    const fresh = st.speechSec - st.lastCloneSpeech;
    // Under FILL_SEC: ny klon för varje nytt klipp. Därefter mer sällan.
    if (!st.cloneVoiceId || (st.lastCloneSpeech < FILL_SEC ? fresh >= FIRST_CLONE_SEC : fresh >= CLONE_EVERY_SEC)) runClone(st);
  }
}

async function runAnalysis(st, userLines) {
  st.jobs.analyzing = true;
  st.lastAnalysisAt = Date.now();
  const p = progress(st.speechSec);
  try {
    step(st, `analyserar ditt språk (${p.key}, likhet ${p.likeness})`, 'analysis', { phase: p.key, likeness: p.likeness });
    const t0 = Date.now();
    st.profile = await analyze({ prevProfile: st.profile, transcript: st.transcript, likeness: p.likeness, phase: p.key });
    st.analyzedUserLines = userLines;
    st.contextSeq += 1;
    st.contextText = contextUpdate(p, st.profile);
    fs.writeFileSync(path.join(dir(st.pid), 'profiles', `profile${String(st.contextSeq).padStart(3, '0')}.json`), JSON.stringify({ progress: p, profile: st.profile }, null, 2));
    step(st, `profilen uppdaterad på ${((Date.now() - t0) / 1000).toFixed(0)} s${st.profile.facts.name ? ` — du heter ${st.profile.facts.name}` : ''}`, 'profile', { seq: st.contextSeq });
  } catch (e) {
    console.error(e); st.error = 'analys: ' + e.message; save(st);
  } finally {
    st.jobs.analyzing = false;
    st.lastAnalysisAt = Date.now();
  }
}

async function runClone(st) {
  st.jobs.cloning = true;
  const at = st.speechSec;
  try {
    const pdir = dir(st.pid);
    const seq = st.voiceSeq + 1;
    const speechFiles = st.chunks.filter((c) => c.speechSec > 0).map((c) => path.join(pdir, 'speech', `chunk${String(c.n).padStart(4, '0')}.mp3`));
    const pool = path.join(pdir, 'train', `user_v${seq}.wav`);
    const realSec = await concatTail(speechFiles, pool, MAX_USER_SEC);
    let file = pool;
    if (realSec < FILL_SEC) {
      // För lite tal: upprepa klippen tills de fyller FILL_SEC.
      file = path.join(pdir, 'train', `user_v${seq}_fill.wav`);
      await loopTo(pool, file, FILL_SEC);
      step(st, `tränar klon ${seq}: ${realSec.toFixed(0)} s av din röst, upprepat till ${FILL_SEC} s`, 'clone', { seq, realSec });
    } else {
      step(st, `tränar klon ${seq}: ${realSec.toFixed(0)} s av din röst`, 'clone', { seq, realSec });
    }
    const t0 = Date.now();
    const id = await createClone(`clone-me · ${st.pid} · v${seq}`, [file],
      `clone-me-experiment, deltagare ${st.pid}, klon ${seq}, ${realSec.toFixed(0)} s tal`);
    st.voices.push(id);
    if (st.ended) { await deleteVoice(id).catch(() => {}); st.voices = st.voices.filter((v) => v !== id); save(st); return; }
    st.cloneVoiceId = id; st.voiceSeq = seq; st.voiceRealSec = Math.round(realSec); st.lastCloneSpeech = at; st.error = null;
    save(st);
    step(st, `klon ${seq} klar på ${((Date.now() - t0) / 1000).toFixed(1)} s`, 'cloned', { seq, ms: Date.now() - t0 });
    await cleanupVoices(st);
  } catch (e) {
    console.error(e); st.error = 'klon: ' + e.message.slice(0, 300); save(st); // försöker igen vid nästa ljudbit
  } finally {
    st.jobs.cloning = false;
  }
}

function runTestSwap(st) {
  const next = TEST_VOICES[(st.voiceSeq + 1) % TEST_VOICES.length];
  st.voiceSeq += 1; st.cloneVoiceId = next; st.voiceRealSec = null; st.lastCloneSpeech = st.speechSec;
  save(st);
  step(st, `provläge: byter till röst ${st.voiceSeq} (${next === cfg.baseVoiceId ? 'Elin' : 'Sarah'})`);
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit = 40e6) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('för stor'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const json = async (req) => JSON.parse((await readBody(req)).toString() || '{}');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/p\/([a-f0-9]{12})(\/[a-z]+)?$/);
  try {
    if (req.method === 'POST' && url.pathname === '/api/p') {
      const body = await json(req);
      const pid = crypto.randomBytes(6).toString('hex');
      for (const d of ['raw', 'speech', 'train', 'profiles']) fs.mkdirSync(path.join(dir(pid), d), { recursive: true });
      const st = {
        pid, createdAt: new Date().toISOString(), test: body.test === 'relay' ? 'relay' : null,
        calls: [], chunks: [], transcript: [], speechSec: 0, steps: [], error: null,
        profile: null, analyzedUserLines: 0, lastAnalysisAt: 0, contextSeq: 0, contextText: '',
        voices: [], cloneVoiceId: null, activeVoiceId: null, voiceSeq: 0, voiceRealSec: 0, lastCloneSpeech: 0, handoffs: [],
        jobs: { analyzing: false, cloning: false },
      };
      cache.set(pid, st); save(st);
      return send(res, 200, live(st));
    }
    if (m) {
      const st = load(m[1]);
      if (!st) return send(res, 404, { error: 'okänd deltagare' });
      const action = m[2] || '';
      if (req.method === 'GET' && (action === '' || action === '/live')) return send(res, 200, live(st));
      if (req.method === 'POST' && action === '/start') return send(res, 200, await startCall(st));
      if (req.method === 'POST' && action === '/relay') {
        const b = await json(req);
        for (const line of b.transcript || []) st.transcript.push(line);
        return send(res, 200, await relay(st));
      }
      if (req.method === 'POST' && action === '/handoff') { const b = await json(req); await handoff(st, b.voiceId, b.ms); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && action === '/end') return send(res, 200, await endRun(st));
      if (req.method === 'POST' && action === '/note') { const b = await json(req); step(st, String(b.text || '').slice(0, 200), 'note'); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && action === '/chunk') {
        const meta = JSON.parse(Buffer.from(req.headers['x-meta'] || 'e30=', 'base64').toString('utf8'));
        await chunk(st, await readBody(req), meta);
        return send(res, 200, live(st));
      }
      if (req.method === 'DELETE' && action === '') return send(res, 200, await endRun(st));
    }
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const f = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(path.join(ROOT, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    send(res, 404, { error: 'finns inte' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`clone-me → http://localhost:${PORT}`));
