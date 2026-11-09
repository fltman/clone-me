// clone-me — analytikerns skärm. Allt som visas kommer ur riktiga data: profilen (byggd enbart ur det som
// sägs i samtalet), serverns händelser, transkriptet och mikrofonen (grundtonen mäts med autokorrelation).
const $ = (id) => document.getElementById(id);
const PHASES = ['främlingen', 'likheterna', 'spegeln', 'dubbelgångaren'];
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const up = (t) => String(t ?? '').toLocaleUpperCase('sv');

let t0 = 0, clockTimer = null, raf = 0;
let mic = null;              // { ctx, an, buf, fbuf }
let outputFn = null;         // () => Uint8Array (agentens utljud)
let who = 'idle';
let prev = null;             // föregående live
let seen = new Set();        // steg som redan visats
let heard = [];              // avlyssnade repliker (bara den här sessionen)
let pitches = [], pitchAnnounced = false, pitchTimer = null;

// ---------- vy-byte ----------
export function idle() {
  $('boot').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('hud').classList.remove('erasing');
  $('wipe').classList.remove('on');
  $('idle').classList.remove('hidden');
  $('go').classList.remove('armed', 'on');
  clearInterval(clockTimer); clearInterval(pitchTimer); cancelAnimationFrame(raf);
  if (mic) { mic.ctx.close().catch(() => {}); mic = null; }
}
let sfx = null; // ljud för brytarens klack

// ---------- uppstart (medan samtalet kopplas upp) ----------
const BOOT = [
  '> UPPKOPPLING TILL AVLYSSNINGSNÄTET ...... OK',
  '> RÖSTINSAMLING ......................... REDO',
  '> SPRÅKANALYS ........................... REDO',
  '> RÖSTSYNTES ............. VÄNTAR PÅ MATERIAL',
  '',
  '> AVLYSSNING STARTAR',
];
function clack() { // mekaniskt klack: kort brusstöt genom lågpass
  if (!sfx) return;
  const t = sfx.currentTime, len = Math.floor(sfx.sampleRate * 0.05);
  const b = sfx.createBuffer(1, len, sfx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
  const src = sfx.createBufferSource(), f = sfx.createBiquadFilter(), g = sfx.createGain();
  f.type = 'lowpass'; f.frequency.value = 2400; g.gain.value = 0.5;
  src.buffer = b; src.connect(f).connect(g).connect(sfx.destination); src.start(t);
}
export async function dialing() {
  try { sfx = sfx || new AudioContext(); } catch {}
  const go = $('go');
  go.classList.add('armed'); clack();          // skyddslocket fälls upp
  await new Promise((r) => setTimeout(r, 520));
  go.classList.add('on'); clack();             // brytaren slås om
  await new Promise((r) => setTimeout(r, 650));
  const el = $('boot');
  el.textContent = ''; el.classList.remove('hidden'); el.classList.add('cur');
  for (const line of BOOT) {
    for (const ch of line) { el.textContent += ch; await new Promise((r) => setTimeout(r, ch === '.' ? 4 : 16)); }
    el.textContent += '\n';
    await new Promise((r) => setTimeout(r, 140));
  }
}

export function start(stream, pid) {
  $('idle').classList.add('hidden');
  $('boot').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('subj').textContent = '#' + up(pid).slice(0, 6);
  t0 = performance.now();
  heard = []; pitches = []; pitchAnnounced = false; prev = null; seen = new Set();
  $('feed').innerHTML = '';
  document.querySelector('header .rec').textContent = 'AVLYSSNING AKTIV';
  for (const el of document.querySelectorAll('.erased')) el.classList.remove('erased');
  const pend = '<span class="pending">INSAMLING PÅGÅR</span>';
  $('ident').innerHTML = ['NAMN', 'ORT', 'YRKE'].map((k) => `<dt>${k}</dt><dd>${pend}</dd>`).join('');
  for (const id of ['people', 'phrases']) $(id).innerHTML = `<li>${pend}</li>`;
  for (const id of ['interests', 'fillers']) $(id).innerHTML = pend;
  $('lang').innerHTML = langRows(null);
  clockTimer = setInterval(tick, 1000); tick();
  const ctx = new AudioContext();
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(an);
  mic = { ctx, an, buf: new Float32Array(an.fftSize) };
  pitchTimer = setInterval(measurePitch, 200);
  resize(); draw();
  feed('ANSLUTNING UPPRÄTTAD · AVLYSSNING STARTAD');
  feed('RÖSTINSAMLING INITIERAD');
}
function tick() {
  const s = Math.floor((performance.now() - t0) / 1000);
  $('clock').textContent = [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, '0')).join(':');
}

export function setOutput(fn) { outputFn = fn; }
export function speaking(w) {
  if (w === who) return;
  who = w;
  $('who').textContent = w === 'synth' ? 'SYNTES TALAR' : w === 'subject' ? 'SUBJEKT TALAR' : '';
  $('who').style.color = w === 'synth' ? 'var(--amber)' : 'var(--g)';
}

// ---------- händelselogg (skrivmaskin) ----------
const queue = [];
let typing = false;
export function feed(text, cls = '') {
  let t = up(text);
  if (t.length > 110) t = t.slice(0, 108) + '…'; // längre rader rullar (scrollIfClipped)
  queue.push({ text: t, cls });
  if (!typing) typeNext();
}
function typeNext() {
  const item = queue.shift();
  if (!item) { typing = false; return; }
  typing = true;
  const el = $('feed');
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="tx cur ${item.cls}"></span>`;
  el.appendChild(row);
  while (el.children.length > 40) el.firstChild.remove();
  const tx = row.querySelector('.tx');
  let i = 0;
  const fast = queue.length > 4; // hinn ikapp om det köar
  const iv = setInterval(() => {
    i += fast ? 3 : 1;
    tx.textContent = item.text.slice(0, i);
    if (i >= item.text.length) { clearInterval(iv); tx.classList.remove('cur'); scrollIfClipped(row); setTimeout(typeNext, 60); }
  }, fast ? 8 : 24);
}

// ---------- avlyssning (räknas, visas inte — publiken hör samtalet) ----------
export function line(l) {
  heard.push(l);
  if (l.role === 'user') countFillers();
}

// ---------- serverns tillstånd ----------
export function update(live) {
  if (!live) return;
  const first = !prev;
  // händelser från servern
  for (const st of live.steps) {
    const key = st.t + st.text;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!first) stepToFeed(st);
  }
  if (first && live.profile) feed(`BEFINTLIG PROFIL LADDAD · ${Math.round(live.speechSec)} S RÖSTMATERIAL I ARKIV`);
  if (!first && live.phase !== prev.phase) {
    const n = PHASES.indexOf(live.phase) + 1;
    feed(`SYNTESNIVÅ ${5 - n} · ${live.phase}`, n >= 3 ? 'crit' : 'warn');
  }
  if (live.profile) diffProfile(first ? null : prev.profile, live.profile, first);
  renderStats(live);
  prev = live;
}

function stepToFeed(st) {
  const d = st.data || {};
  switch (st.kind) {
    case 'voice': feed(`RÖSTPROV LAGRAT · +${d.added.toFixed(1)} S · TOTALT ${Math.round(d.total)} S`); break;
    case 'analysis': feed(`PSYKOLINGVISTISK ANALYS PÅGÅR …`); break;
    case 'profile': feed(`BETEENDEPROFIL UPPDATERAD · VERSION ${d.seq}`); break;
    case 'clone': feed(`KLONING PÅGÅR · RÖSTMODELL V${d.seq} · ${Math.round(d.realSec)} S MATERIAL`, 'warn'); break;
    case 'cloned': feed(`RÖSTMODELL V${d.seq} KOMPILERAD · ${(d.ms / 1000).toFixed(1)} S`); break;
    default: break; // anteckningar och interna rader visas inte
  }
}

// Nya fynd i profilen blir rader i loggen och blinkar till i panelerna.
function diffProfile(a, b, quiet) {
  const f = b.facts, s = b.idiolect;
  const pf = a?.facts || {}, ps = a?.idiolect || {};
  const added = (x = [], y = []) => x.filter((v) => !y.map((w) => w.toLowerCase()).includes(v.toLowerCase()));
  const say = (t, cls) => { if (!quiet) feed(t, cls); };

  if (f.name && f.name !== pf.name) say(`IDENTITET FASTSTÄLLD · ${f.name}`, 'warn');
  if (f.hometown && f.hometown !== pf.hometown) say(`BOSTADSORT · ${f.hometown}`);
  if (f.occupation && f.occupation !== pf.occupation) say(`SYSSELSÄTTNING · ${f.occupation}`);
  if (f.age_hint && f.age_hint !== pf.age_hint) say(`ÅLDERSINDIKATION · ${f.age_hint}`);
  added(f.interests, pf.interests).forEach((x) => say(`INTRESSE DETEKTERAT · ${x}`));
  added(f.people, pf.people).forEach((x) => say(`RELATION KARTLAGD · ${x}`, 'warn'));
  added(f.memories, pf.memories).forEach((x) => say(`MINNE ARKIVERAT · ${x}`));
  added(f.opinions, pf.opinions).forEach((x) => say(`ÅSIKT LOGGAD · ${x}`));
  added(s.signature_phrases, ps.signature_phrases).forEach((x) => say(`TYPISK FRAS REGISTRERAD · «${x}»`));
  added(s.fillers, ps.fillers).forEach((x) => say(`UTFYLLNADSORD IDENTIFIERAT · «${x}»`));
  added(s.dialect_and_pronunciation_words, ps.dialect_and_pronunciation_words).forEach((x) => say(`DIALEKTMARKÖR · «${x}»`));

  const newSet = (x, y) => new Set(quiet ? [] : added(x, y).map((v) => v.toLowerCase()));
  const pend = '<span class="pending">INSAMLING PÅGÅR</span>';
  const dd = (k, v, old) => `<dt>${k}</dt><dd class="${!quiet && v && v !== old ? 'new' : ''}">${v ? esc(v) : pend}</dd>`;
  $('ident').innerHTML = dd('NAMN', f.name, pf.name) + dd('ORT', f.hometown, pf.hometown) + dd('YRKE', f.occupation, pf.occupation);

  const list = (el, xs, nu, fmt = esc) => {
    $(el).innerHTML = xs?.length ? xs.map((x) => `<li class="${nu.has(x.toLowerCase()) ? 'new' : ''}">${fmt(x)}</li>`).join('') : `<li>${pend}</li>`;
  };
  list('people', f.people?.slice(-5), newSet(f.people, pf.people));
  const ni = newSet(f.interests, pf.interests);
  const tag = (x) => esc(x);
  $('interests').innerHTML = f.interests?.length ? f.interests.slice(-8).map((x) => `<span class="tag ${ni.has(x.toLowerCase()) ? 'new' : ''}">${tag(x)}</span>`).join('') : pend;
  list('phrases', s.signature_phrases?.slice(0, 5), newSet(s.signature_phrases, ps.signature_phrases), (x) => `«${esc(x)}»`);

  fillerList = s.fillers || [];
  countFillers();

  $('lang').innerHTML = langRows(s);
  rescan();
}
// Första meningen räcker; blir den för lång för raden rullar den (se marquee()).
const short = (t) => { const x = String(t).split(/[.;]/)[0].trim(); return x.length > 90 ? x.slice(0, 88) + '…' : x; };

// Text som inte får plats glider långsamt fram och tillbaka i stället för att klippas.
// Mäter själva texten (inte rutan) mot det utrymme som finns innanför rutans utfyllnad.
function scrollIfClipped(el) {
  if (!el.isConnected || el.classList.contains('erased') || el.id === 'pitchRow') return;
  let span = el.querySelector(':scope > .mq');
  if (!span) {
    if (el.scrollWidth - el.clientWidth <= 1) return;
    span = document.createElement('span');
    span.className = 'mq';
    span.append(...el.childNodes);
    el.append(span);
    el.style.textOverflow = 'clip';
  }
  const cs = getComputedStyle(el);
  const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const over = span.getBoundingClientRect().width - avail;
  if (over <= 6) { span.style.animation = 'none'; return; } // några pixlar syns inte
  span.style.setProperty('--x', `${-(over + 4)}px`);
  span.style.setProperty('--d', `${Math.max(5, over / 30).toFixed(1)}s`);
  span.style.animation = '';
}
const SCROLLABLE = '#ident dd, #lang dd, #people li, #phrases li, #interests .tag, #fillers .tag, #feed .row';
function rescan() { requestAnimationFrame(() => document.querySelectorAll(SCROLLABLE).forEach(scrollIfClipped)); }
document.fonts?.ready.then(rescan);
addEventListener('resize', rescan);

function langRows(s) {
  const pend = '<span class="pending">MÄTER …</span>';
  const rows = [['FORMALITET', s?.formality], ['HUMOR', s?.humor], ['TEMPO', s?.sentence_shape]];
  return pitchRow() + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v && !/ännu|okänt|inte observerat/i.test(v) ? esc(short(v)) : pend}</dd>`).join('');
}

// Räkna hur ofta utfyllnadsorden faktiskt förekommer i det som avlyssnats.
let fillerList = [];
function countFillers() {
  const text = ' ' + heard.filter((l) => l.role === 'user').map((l) => l.message.toLowerCase()).join(' ') + ' ';
  const count = (w) => text.split(new RegExp(`(?<![\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u')).length - 1;
  const items = fillerList.map((w) => [w, count(w)]).sort((a, b) => b[1] - a[1]).slice(0, 7);
  $('fillers').innerHTML = items.length ? items.map(([w, n]) => `<span class="tag">${esc(w)}${n ? `<b>×${n}</b>` : ''}</span>`).join('') : '<span class="pending">INSAMLING PÅGÅR</span>';
}

function renderStats(l) {
  const n = PHASES.indexOf(l.phase) + 1;
  $('phase').textContent = up(l.phase);
  document.querySelectorAll('.levels b').forEach((b) => b.classList.toggle('on', b.classList.contains('l' + (5 - n))));
  $('sSec').textContent = `${Math.round(l.speechSec)} S`;
  $('bSec').style.width = Math.min(100, (l.speechSec / 140) * 100) + '%';
  $('sModel').textContent = l.voiceSeq ? `V${l.voiceSeq}` : '—';
  $('bModel').style.width = Math.min(100, ((l.voiceRealSec || 0) / 30) * 100) + '%';
  $('sLike').textContent = `${Math.round(l.likeness * 100)} %`;
  $('bLike').style.width = l.likeness * 100 + '%';
  $('voiceState').textContent = l.jobs.cloning ? 'KLONING PÅGÅR' : l.voiceSeq ? `V${l.voiceSeq} AKTIV` : 'INSAMLING';
  $('foot').textContent = l.jobs.analyzing ? 'ANALYS PÅGÅR …' : l.jobs.cloning ? 'RÖSTSYNTES TRÄNAS …' : 'ÖVERVAKNING PÅGÅR';
}

// ---------- grundton ----------
function measurePitch() {
  if (!mic) return;
  const { an, buf, ctx } = mic;
  an.getFloatTimeDomainData(buf);
  let rms = 0;
  for (const v of buf) rms += v * v;
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.02) { if (who === 'subject') speaking('idle'); return; }
  if (who !== 'synth') speaking('subject');
  // autokorrelation inom 70–350 Hz
  const sr = ctx.sampleRate, minLag = Math.floor(sr / 350), maxLag = Math.floor(sr / 70);
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < buf.length - lag; i++) c += buf[i] * buf[i + lag];
    if (c > best) { best = c; bestLag = lag; }
  }
  if (!bestLag) return;
  pitches.push(sr / bestLag);
  if (pitches.length > 150) pitches.shift();
  if (pitches.length >= 25 && !pitchAnnounced) { pitchAnnounced = true; feed(`GRUNDTON FASTSTÄLLD ≈ ${medianPitch()} HZ`); }
  const row = document.getElementById('pitchRow');
  if (row) row.textContent = pitches.length >= 10 ? `≈ ${medianPitch()} HZ` : 'MÄTER …';
}
function medianPitch() { const s = [...pitches].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); }
function pitchRow() { return `<dt>GRUNDTON</dt><dd id="pitchRow">${pitches.length >= 10 ? `≈ ${medianPitch()} HZ` : 'MÄTER …'}</dd>`; }

// ---------- röstsignatur ----------
function resize() {
  const c = $('scope'), r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
}
addEventListener('resize', () => { if (mic) resize(); });
function draw() {
  raf = requestAnimationFrame(draw);
  const c = $('scope'), g = c.getContext('2d'), W = c.width, H = c.height, mid = H / 2;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(52,210,124,.22)'; g.lineWidth = 1;
  for (let x = 0; x < W; x += W / 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
  if (!mic) return;
  // subjektet: vågform, övre halvan
  mic.an.getFloatTimeDomainData(mic.buf);
  g.strokeStyle = '#45ff96'; g.lineWidth = 1.5 * (devicePixelRatio || 1); g.shadowColor = '#45ff96'; g.shadowBlur = 8;
  g.beginPath();
  for (let i = 0; i < mic.buf.length; i += 4) {
    const x = (i / mic.buf.length) * W, y = mid * 0.5 - mic.buf[i] * mid * 1.6;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  // syntesen: spektrum, nedre halvan
  const out = outputFn?.();
  if (out?.length) {
    g.fillStyle = '#ffb340'; g.shadowColor = '#ffb340';
    const n = Math.min(96, out.length), bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = out[i] / 255;
      const h = v * mid * 0.9;
      g.fillRect(i * bw + 1, mid + (mid - h) / 2 + mid * 0.05, bw - 2, h);
    }
  }
  g.shadowBlur = 0;
}

// ---------- radering ----------
// Spelas upp när servern har bekräftat raderingen. Raderna byggs av det som faktiskt fanns och raderades.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function erase(erased = {}) {
  queue.length = 0;
  const hud = $('hud');
  hud.classList.add('erasing');
  document.querySelector('header .rec').textContent = 'RADERING PÅGÅR';
  $('foot').textContent = 'RADERING PÅGÅR';
  speaking('idle');

  const f = prev?.profile?.facts || {}, s = prev?.profile?.idiolect || {};
  const msgs = [];
  for (let v = erased.voiceVersions || 0; v >= 1; v--) msgs.push(`RÖSTMODELL V${v} RADERAD`);
  if (erased.voices) msgs.push(`KLON RADERAD HOS RÖSTLEVERANTÖR · ${erased.voices} ST`);
  if (erased.audioFiles) msgs.push(`RÖSTPROV RADERADE · ${erased.audioFiles} FILER · ${erased.speechSec} S TAL`);
  (f.memories || []).forEach((x) => msgs.push(`MINNE RADERAT · ${x}`));
  (f.people || []).forEach((x) => msgs.push(`RELATION RADERAD · ${x}`));
  (f.interests || []).forEach((x) => msgs.push(`INTRESSE RADERAT · ${x}`));
  (f.opinions || []).forEach((x) => msgs.push(`ÅSIKT RADERAD · ${x}`));
  (s.signature_phrases || []).forEach((x) => msgs.push(`FRAS RADERAD · «${x}»`));
  if (s.fillers?.length) msgs.push(`UTFYLLNADSORD RADERADE · ${s.fillers.length} ST`);
  if (erased.lines) msgs.push(`TRANSKRIPT RADERAT · ${erased.lines} REPLIKER`);
  if (f.occupation) msgs.push(`SYSSELSÄTTNING RADERAD`);
  if (f.hometown) msgs.push(`BOSTADSORT RADERAD`);
  msgs.push('SPRÅKPROFIL RADERAD');
  msgs.push('PERSONLIGHET RADERAD');
  if (f.name) msgs.push(`IDENTITET RADERAD · ${f.name}`);
  msgs.push('MINNE RADERAT');

  // panelerna: allt som visats ersätts, ett i taget
  const items = [...hud.querySelectorAll('#ident dd, #people li, #interests .tag, #phrases li, #fillers .tag, #lang dd')];
  const wipeItems = (async () => {
    for (const el of items.sort(() => Math.random() - 0.5)) {
      el.textContent = el.tagName === 'DD' ? 'RADERAD' : '██ RADERAT';
      el.classList.remove('new'); el.classList.add('erased');
      await sleep(40);
    }
  })();
  // statistiken räknas ned
  for (const id of ['bSec', 'bModel', 'bLike']) $(id).style.width = '0%';
  for (const id of ['sSec', 'sModel', 'sLike']) { $(id).textContent = '0'; $(id).classList.add('erased'); }
  $('voiceState').textContent = 'RADERAD'; $('voiceState').classList.add('erased');

  // loggen: de gröna raderna byts ut nerifrån och upp, resten läggs till
  const feedEl = $('feed');
  const rows = [...feedEl.children].reverse();
  for (let k = 0; k < msgs.length; k++) {
    let row = rows[k];
    if (!row) { row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span class="tx"></span>'; feedEl.prepend(row); }
    const tx = row.querySelector('.tx');
    tx.className = 'tx erased';
    const m = up(msgs[k]);
    tx.textContent = m;
    scrollIfClipped(row);
    await sleep(170);
  }
  for (let k = msgs.length; k < rows.length; k++) {
    const tx = rows[k].querySelector('.tx');
    tx.className = 'tx erased'; tx.textContent = 'RADERAT';
    await sleep(25);
  }
  await wipeItems;
  await sleep(600);
  $('wipeText').textContent = 'SUBJEKT RADERAT';
  $('wipe').classList.add('on');
  await sleep(3500);
}
