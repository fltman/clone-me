// Språklig analys + faktautdrag ur ett samtal. Bygger vidare på föregående profil.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

const client = new Anthropic();

export const Profile = z.object({
  facts: z.object({
    name: z.string().describe('Klientens förnamn som hen själv säger det, tom sträng om okänt'),
    full_name: z.string(),
    hometown: z.string(),
    occupation: z.string(),
    age_hint: z.string(),
    interests: z.array(z.string()).describe('Konkreta intressen, med klientens egna ord'),
    people: z.array(z.string()).describe('Personer hen nämnt, med relation: "Lisa (dotter)"'),
    memories: z.array(z.string()).describe('Minnen/anekdoter hen berättat, i första person som hen sa dem'),
    opinions: z.array(z.string()).describe('Åsikter och smak, i första person'),
    other: z.array(z.string()),
  }),
  idiolect: z.object({
    fillers: z.array(z.string()).describe('Utfyllnadsord och småord hen faktiskt använder: "alltså", "typ", "liksom"'),
    signature_phrases: z.array(z.string()).describe('Återkommande uttryck och favoritord, ordagrant'),
    greeting_style: z.string(),
    agreeing_style: z.string().describe('Hur hen håller med / bekräftar ("precis", "ja, absolut")'),
    disagreeing_style: z.string(),
    question_style: z.string(),
    sentence_shape: z.string().describe('Längd, rytm, avbrutna meningar, självrättelser'),
    formality: z.string(),
    humor: z.string(),
    dialect_and_pronunciation_words: z.array(z.string()).describe('Dialektala ord eller former som syns i transkriptet'),
    swearing_and_intensifiers: z.array(z.string()),
    english_loanwords: z.array(z.string()),
    example_utterances: z.array(z.string()).describe('8–15 korta, typiska repliker ordagrant ur transkripten'),
  }),
  observations: z.string().describe('Kort fritext: vad som är mest utmärkande för hur hen pratar'),
  next_first_message: z.string().describe(
    'Agentens första replik i nästa samtal, skriven i den grad av likhet med klienten som anges'),
});

const SYSTEM = `Du är språkvetare och analyserar hur en svensk talare pratar, utifrån transkript av röstsamtal
(talsyntes åt ena hållet, taligenkänning åt andra). Du bygger och uppdaterar en profil över talarens idiolekt och livsfakta.

Regler:
- Analysera BARA klientens repliker (role "user"). Agentens repliker är kontext.
- Använd ENBART det som sägs i transkriptet. Ingen förkunskap, inga antaganden om vem talaren är utöver det hen själv sagt.
  Agentens påståenden om sig själv är inte fakta om klienten.
- Citera ordagrant ur transkripten där fälten ber om det. Hitta inte på uttryck klienten inte använt.
- Taligenkänningen kan ha felhört; ta inte med uppenbara igenkänningsfel som "dialekt".
- Slå ihop med föregående profil: behåll det som fortfarande stämmer, lägg till nytt, ta bort det som visat sig fel.
- Skriv på svenska med korrekta å, ä, ö.`;

export async function analyze({ prevProfile, transcript, likeness, phase, effort = 'low' }) {
  const userPrompt = `Föregående profil (null = ingen ännu):
${JSON.stringify(prevProfile, null, 2)}

Hela samtalet hittills, äldst först (role "user" = klienten, "agent" = agenten):
${JSON.stringify(transcript, null, 2)}

Agenten är nu i fasen "${phase}" med likhetsgrad ${likeness} (0 = egen personlighet, 1 = låter exakt som klienten).
Skriv next_first_message därefter: en kort, naturlig öppningsreplik (en–två meningar) om klienten ringer upp igen senare.`;

  const msg = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: betaZodOutputFormat(Profile) },
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('analysen avböjdes: ' + JSON.stringify(msg.stop_details));
  if (!msg.parsed_output) throw new Error('analysen gav ingen giltig profil (stop_reason ' + msg.stop_reason + ')');
  return msg.parsed_output;
}
