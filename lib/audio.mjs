// ffmpeg-steg: plocka ut klientens tal ur mikrofoninspelningen och bygga träningsmaterial till klonen.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const run = promisify(execFile);

// 0 om filen saknas eller är tom (t.ex. en ljudbit där allt var tystnad).
export async function duration(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    return parseFloat(stdout.trim()) || 0;
  } catch { return 0; }
}

// Tystar intervallen där agenten pratade (med marginal) och klipper bort tystnad.
// Kvar blir bara klientens egen röst.
export async function extractSpeech(rawFile, agentSpeaking, outFile, pad = 0.3) {
  const parts = (agentSpeaking || [])
    .filter(([a, b]) => b > a)
    .map(([a, b]) => `between(t,${Math.max(0, a - pad).toFixed(2)},${(b + pad).toFixed(2)})`);
  const filters = [];
  if (parts.length) filters.push(`volume=enable='${parts.join('+')}':volume=0`);
  filters.push('highpass=f=70');
  filters.push('silenceremove=start_periods=1:start_threshold=-42dB:stop_periods=-1:stop_duration=0.6:stop_threshold=-42dB');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', rawFile, '-af', filters.join(','), '-ac', '1', '-ar', '44100', '-b:a', '160k', outFile]);
  const d = await duration(outFile);
  if (d < 0.5) fs.rmSync(outFile, { force: true });
  return d < 0.5 ? 0 : d;
}

// Träningsmaterialet skrivs som WAV: concat-filtret + libmp3lame kraschar i ffmpeg 8
// ("inadequate AVFrame plane padding") beroende på bitarnas längd.
const WAV = ['-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le'];

// Slår ihop ljudfiler (concat-filter, inte concat-demuxern) och kapar till maxSec från slutet (det senaste talet).
export async function concatTail(files, outFile, maxSec) {
  const existing = files.filter((f) => fs.existsSync(f));
  if (!existing.length) return 0;
  const args = ['-y', '-v', 'error'];
  for (const f of existing) args.push('-i', f);
  const inputs = existing.map((_, i) => `[${i}:a]`).join('');
  args.push('-filter_complex', `${inputs}concat=n=${existing.length}:v=0:a=1[a]`, '-map', '[a]',
    ...WAV, outFile + '.full.wav');
  await run('ffmpeg', args);
  const total = await duration(outFile + '.full.wav');
  const start = Math.max(0, total - maxSec);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', start.toFixed(2), '-i', outFile + '.full.wav', ...WAV, outFile]);
  fs.unlinkSync(outFile + '.full.wav');
  return duration(outFile);
}

export async function trim(inFile, outFile, sec) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', inFile, '-t', sec.toFixed(2), ...WAV, outFile]);
  return duration(outFile);
}

// Upprepar ljudet tills det är sec sekunder långt (för korta klipp till klonen).
export async function loopTo(inFile, outFile, sec) {
  await run('ffmpeg', ['-y', '-v', 'error', '-stream_loop', '-1', '-i', inFile, '-t', sec.toFixed(2), ...WAV, outFile]);
  return duration(outFile);
}
