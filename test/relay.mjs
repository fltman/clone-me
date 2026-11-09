// Provkör stafettbytet i riktig Chrome (utan fönster) med en inspelad fil som mikrofon.
// Provläge: servern växlar mellan två färdiga röster i stället för att klona.
//   node test/relay.mjs [sekunder] [--clone]   (--clone = riktiga kloner i stället för provröster)
import { chromium } from 'playwright-core';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = 'http://localhost:8350';
const SECONDS = Number(process.argv[2] || 150);
const REAL = process.argv.includes('--clone');

const p = await (await fetch(`${BASE}/api/p`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ test: REAL ? null : 'relay' }),
})).json();
console.log('deltagare', p.pid);

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(ROOT, 'test/fixtures/fake_mic.wav')}`,
    '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const [vw, vh] = (process.env.VIEW || '1920x1080').split('x').map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on('console', (m) => { const s = m.text(); if (s.startsWith('[cm]') || m.type() === 'error') console.log(stamp(), s); });
page.on('pageerror', (e) => console.log(stamp(), 'SIDFEL', e.message));
await page.goto(`${BASE}/?p=${p.pid}&autocall=1`);
if (process.env.SHOT0) { await page.waitForTimeout(2600); await page.screenshot({ path: process.env.SHOT0 }); }

await page.waitForTimeout(SECONDS * 1000);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
// Kontroll: ingen text får vara klippt utan att rulla, och rullsträckan ska nå textens slut.
const mq = await page.evaluate(() => {
  const out = { clippedNoScroll: [], scrolled: [] };
  for (const el of document.querySelectorAll('#ident dd, #lang dd, #people li, #phrases li, #interests .tag, #fillers .tag, #feed .row')) {
    const span = el.querySelector(':scope > .mq');
    const cs = getComputedStyle(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!span) { if (el.scrollWidth - el.clientWidth > 1) out.clippedNoScroll.push(el.textContent.slice(0, 40)); continue; }
    const x = parseFloat(span.style.getPropertyValue('--x')) || 0;
    out.scrolled.push({ text: el.textContent.slice(0, 30), restAtEnd: Math.round(span.getBoundingClientRect().width + x - avail) });
  }
  return out;
});
console.log('klippt utan rullning:', mq.clippedNoScroll.length ? mq.clippedNoScroll : 'inga');
console.log('rullande (rest vid slutläget, bör vara ≈ -4 px):', JSON.stringify(mq.scrolled));
await page.click('#endBtn');
await page.waitForTimeout(5000);
if (process.env.SHOT2) await page.screenshot({ path: process.env.SHOT2 });
await page.waitForTimeout(15000);
const idleBack = await page.isVisible('#go');
console.log('tillbaka till knappen:', idleBack);
await browser.close();

const after = await fetch(`${BASE}/api/p/${p.pid}/live`);
console.log('deltagaren efteråt:', after.status === 404 ? 'raderad' : 'FINNS KVAR (' + after.status + ')');
