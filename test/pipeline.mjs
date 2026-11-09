// Provkör kedjan utan riktigt samtal: syntetisk "klient" (macOS say, Alva) varvad med "agent" (annan röst).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractSpeech, duration } from '../lib/audio.mjs';
import { analyze } from '../lib/analyze.mjs';
import { createClone, deleteVoice } from '../lib/eleven.mjs';
import { buildPrompt, progress } from '../lib/persona.mjs';

const T = process.argv[2]; fs.mkdirSync(T, { recursive: true });
const turns = [
  ['agent', 'Hej! Vad roligt att du ringde. Vem pratar jag med?'],
  ['user', 'Ja hej, alltså, jag heter Kim. Jag ringer från Kalmar, typ.'],
  ['agent', 'Nej, va? Jag heter också Kim! Vad gör du om dagarna?'],
  ['user', 'Haha, men vad kul. Nä men jag jobbar med ljud, alltså, poddar och sånt. Och så seglar jag när jag hinner, det är min grej liksom.'],
];
const parts = []; const speaking = []; let t = 0;
turns.forEach(([who, text], i) => {
  const f = path.join(T, `t${i}.wav`);
  execFileSync('say', ['-v', who === 'user' ? 'Alva' : 'Oskar', '-o', f, '--data-format=LEI16@44100', text]);
  const d = parseFloat(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', f]).toString());
  if (who === 'agent') speaking.push([t, t + d]);
  parts.push(f); t += d + 0.8;
});
// sätt ihop med 0,8 s tystnad emellan → webm/opus som från webbläsaren
const inputs = parts.flatMap((f) => ['-i', f]);
const fc = parts.map((_, i) => `[${i}:a]apad=pad_dur=0.8[a${i}]`).join(';') + ';' + parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1[o]`;
execFileSync('ffmpeg', ['-y','-v','error',...inputs,'-filter_complex',fc,'-map','[o]','-c:a','libopus', path.join(T,'raw.webm')]);
const got = await extractSpeech(path.join(T, 'raw.webm'), speaking, path.join(T, 'speech.mp3'));
console.log(`rå ${(await duration(path.join(T,'raw.webm'))).toFixed(1)} s, agenten ${speaking.map(([a,b])=>(b-a).toFixed(1)).join('+')} s, kvar efter utplock ${got.toFixed(1)} s`);

const transcript = turns.map(([role, message]) => ({ role, message }));
const profile = await analyze({ prevProfile: null, transcript, likeness: 0.35, phase: 'likheterna' });
console.log('namn:', profile.facts.name, '| intressen:', profile.facts.interests.join(', '), '| småord:', profile.idiolect.fillers.join(', '));
console.log('nästa öppning:', profile.next_first_message);
fs.writeFileSync(path.join(T, 'profile.json'), JSON.stringify(profile, null, 2));
fs.writeFileSync(path.join(T, 'prompt_r2.txt'), buildPrompt(progress(60), profile));

if (process.argv.includes('--clone')) {
  const id = await createClone('clone-me · test', [path.join(T, 'speech.mp3')], 'clone-me pipeline-test, raderas direkt');
  console.log('klon skapad', id, '→ raderad:', await deleteVoice(id));
}
