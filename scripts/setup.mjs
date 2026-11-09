// Engångsuppsättning: grundröst i biblioteket, referensprov av grundrösten, och agenten.
// Idempotent — körs den igen uppdateras agenten och befintliga resurser återanvänds.
import fs from 'node:fs';
import path from 'node:path';
import { el, tts } from '../lib/eleven.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CONFIG = path.join(ROOT, 'config.json');
const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};

// Grundrösten: "Elin – Neutral and Clear" (rikssvenska) ur det delade biblioteket.
const BASE_PUBLIC_OWNER = '4706bd7d675498c6d48d84ae855818c797faf0a3dc0bbe8baabf6d4c7e01d34c';
const BASE_VOICE = '4Ct5uMEndw4cJ7q0Jx0l';

const BASE_TEXT = `Hej, vad roligt att du hörde av dig. Jag sitter här vid köksbordet med en kopp kaffe som hunnit bli lite för kall,
men det gör ingenting. Vet du, jag har tänkt på en sak hela morgonen. Varför är det så att man minns vissa dagar helt
glasklart, medan andra bara försvinner? Jag minns till exempel precis hur det luktade i farmors trädgård en sommar när jag var
liten — nyklippt gräs, rabarber och något surt från kompostlådan. Men vad jag gjorde förra tisdagen? Ingen aning.
Det är ju lite konstigt egentligen. Hur som helst, nog om mig. Jag vill hellre höra om dig. Vad har du hållit på med i dag?
Har det hänt något kul, eller har det mest varit en sådan där vanlig dag när man bara gör det man ska och sedan är det kväll?
Jag gillar de dagarna också, faktiskt. Det finns något lugnt i dem. Men berätta, jag är nyfiken på riktigt.`.replace(/\n/g, ' ');

async function ensureBaseVoice() {
  try {
    await el('GET', `/v1/voices/${BASE_VOICE}`);
    console.log('• grundrösten finns redan i biblioteket');
    return BASE_VOICE;
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  const r = await el('POST', `/v1/voices/add/${BASE_PUBLIC_OWNER}/${BASE_VOICE}`, {
    json: { new_name: 'clone-me · grundröst (Elin)' },
  });
  console.log('• grundrösten tillagd i biblioteket:', r.voice_id);
  return r.voice_id;
}

async function ensureBaseSample(voiceId) {
  const dir = path.join(ROOT, 'data', 'base');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'base_sample.mp3');
  if (fs.existsSync(out)) { console.log('• referensprovet finns redan'); return out; }
  await tts(voiceId, BASE_TEXT, 'eleven_v4', out);
  console.log(`• referensprov genererat (${BASE_TEXT.length} tecken, eleven_v4)`);
  return out;
}

function agentBody(voiceId, ttsModel) {
  return {
    name: 'clone-me',
    conversation_config: {
      agent: {
        language: 'sv',
        first_message: '', // sätts per samtal; tomt = stafettsamtalet väntar tyst
        prompt: {
          // Skrivs över per runda av servern; detta är bara en fallback.
          prompt: 'Du är en nyfiken, varm samtalspartner. Prata svenska. Korta repliker.',
          llm: 'claude-sonnet-5-5',
          reasoning_effort: 'none',
          temperature: 0.7,
        },
      },
      tts: { voice_id: voiceId, model_id: ttsModel, stability: 0.45, similarity_boost: 0.9 },
      conversation: { max_duration_seconds: 1800 },
      turn: { turn_timeout: 30 },
    },
    platform_settings: {
      auth: { enable_auth: true }, // privat — servern delar ut samtalstoken
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true } },
          tts: { voice_id: true },
        },
      },
    },
  };
}

async function ensureAgent(voiceId) {
  for (const ttsModel of ['eleven_v4_turbo', 'eleven_flash_v2_5']) {
    const body = agentBody(voiceId, ttsModel);
    try {
      if (cfg.agentId) {
        await el('PATCH', `/v1/convai/agents/${cfg.agentId}`, { json: body });
        console.log(`• agenten uppdaterad (${cfg.agentId}, tts ${ttsModel})`);
        return { agentId: cfg.agentId, ttsModel };
      }
      const r = await el('POST', '/v1/convai/agents/create', { json: body });
      console.log(`• agenten skapad (${r.agent_id}, tts ${ttsModel})`);
      return { agentId: r.agent_id, ttsModel };
    } catch (e) {
      if (e.status === 400 || e.status === 422) {
        console.log(`  (${ttsModel} gick inte: ${e.message.slice(0, 200)})`);
        continue;
      }
      throw e;
    }
  }
  throw new Error('kunde inte skapa agenten med någon TTS-modell');
}

const baseVoiceId = await ensureBaseVoice();
const baseSample = await ensureBaseSample(baseVoiceId);
const { agentId, ttsModel } = await ensureAgent(baseVoiceId);
Object.assign(cfg, { agentId, ttsModel, baseVoiceId, baseSample: path.relative(ROOT, baseSample) });
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
console.log('klart →', CONFIG);
