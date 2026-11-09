// Tunna omslag runt ElevenLabs REST-API. Nyckeln läses ur miljön och skrivs aldrig ut.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.elevenlabs.io';

function key() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY saknas (kör via ./start.sh som läser ~/.zprofile)');
  return k;
}

export async function el(method, url, { json, form, raw } = {}) {
  const headers = { 'xi-api-key': key() };
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(BASE + url, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs ${method} ${url} → ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

export async function tts(voiceId, text, modelId, outFile) {
  const buf = await el('POST', `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    json: { text, model_id: modelId },
    raw: true,
  });
  fs.writeFileSync(outFile, buf);
  return outFile;
}

// Instant Voice Clone av en lista ljudfiler. Returnerar nytt voice_id.
export async function createClone(name, files, description) {
  const form = new FormData();
  form.append('name', name);
  form.append('description', description || '');
  form.append('remove_background_noise', 'false');
  for (const f of files) {
    const buf = fs.readFileSync(f);
    form.append('files', new Blob([buf], { type: f.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' }), path.basename(f));
  }
  const r = await el('POST', '/v1/voices/add', { form });
  return r.voice_id;
}

export async function deleteVoice(voiceId) {
  try { await el('DELETE', `/v1/voices/${voiceId}`); return true; }
  catch (e) { if (e.status === 404) return false; throw e; }
}

export async function conversationToken(agentId) {
  const r = await el('GET', `/v1/convai/conversation/token?agent_id=${agentId}`);
  return r.token;
}

export async function getConversation(id) {
  return el('GET', `/v1/convai/conversations/${id}`);
}
