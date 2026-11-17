// Transferul proiectului la alt proprietar (cont GitHub + echipă Vercel noi). Pașii compleți sunt în TRANSFER.md.
//
//   npm run transfer:pack
//     la noi, înainte de transfer: urcă ultima variantă a bazei (Neon) și a imaginilor (Blob), apoi scrie în
//     data/transfer-mesaj.txt mesajul de trimis noului proprietar (cu cheile temporare de citire ale bazei noastre).
//
//   npm run transfer:setup -- --from-db "<DATABASE_URL vechi>" [--from-blob "<BLOB_READ_WRITE_TOKEN vechi>"] [--accept-neon-terms]
//     la noul proprietar, după ce proiectul Vercel e la el și e legat (npx vercel link):
//     creează în echipa lui Neon (purapa-db) și Blob public (purapa-media), aduce cheile în .env.local, copiază baza și imaginile
//     din resursele noastre, refăcând și copia locală, apoi republică și verifică panoul online.
//     Neon cere acceptarea termenilor: --accept-neon-terms se pune doar după ce omul a spus explicit „da”.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {get} from '@vercel/blob';
import {createRemote, DB_NAME, sha} from '../src/core/remote.mjs';
import {createMediaSync} from '../src/core/mediasync.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = name => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : undefined; };
const flag = name => args.includes(`--${name}`);
const loadEnv = () => { if (existsSync('.env.local')) process.loadEnvFile('.env.local'); };
const step = msg => console.log(`\n▸ ${msg}`);
const vercel = (cliArgs, {capture = false, allowFail = false} = {}) => {
  const r = spawnSync('npx', ['vercel', ...cliArgs], {shell: process.platform === 'win32', encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit'});
  if (r.status !== 0 && !allowFail) throw new Error(`vercel ${cliArgs.join(' ')} a eșuat${capture ? `:\n${r.stderr || r.stdout}` : ''}`);
  return r;
};
const json = out => JSON.parse(out.slice(out.search(/[[{]/)));
const host = url => { try { return new URL(url).host; } catch { return null; } };

if (cmd === 'pack') {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error('Lipsește DATABASE_URL în .env.local.');
  const remote = createRemote();
  step('Urc ultima variantă a bazei în Neon');
  const {createDbSync} = await import('../src/core/dbsync.mjs');
  const r = await createDbSync({remote, reopen: async buf => writeFileSync('data/purapa.db', buf)}).tick();
  console.log(r ? `  sincronizat: ${r}` : '  baza online e deja la zi');
  if (r === 'download') console.log('  (online era mai nouă și a fost adusă local)');
  let mediaNote = '';
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    step('Urc imaginile lipsă în Blob');
    try { console.log(`  imagini urcate: ${await createMediaSync({remote}).upload()}`); }
    catch (e) { mediaNote = ' (Blob-ul nostru nu răspunde; imaginile se iau din public/media, din git)'; console.log(`  Blob indisponibil: ${e.message}`); }
  }
  const head = await remote.head();
  const blobArg = process.env.BLOB_READ_WRITE_TOKEN && !mediaNote ? ` --from-blob "${process.env.BLOB_READ_WRITE_TOKEN}"` : '';
  const msg = `Copiază mesajul de mai jos în Claude Code (într-un folder gol) după ce ai acceptat transferul proiectului Vercel și al repo-ului GitHub:

---
Preiau proiectul Purapa. Te rog:
1. Clonează repo-ul GitHub purapa din contul meu (întreabă-mă adresa exactă dacă nu o găsești cu gh) și rulează npm install.
2. Asigură-te că sunt logat în Vercel (npx vercel login, dacă e nevoie) și leagă folderul de proiectul purapa din echipa mea (npx vercel link).
3. Citește TRANSFER.md și urmează secțiunea „La noul proprietar”. Întreabă-mă înainte să accepți termenii Neon.
4. Comanda de rulat la final este:
   npm run transfer:setup -- --from-db "${process.env.DATABASE_URL}"${blobArg}
5. Spune-mi la final adresa panoului online și dacă verificarea a trecut.
---

Cheile din comandă dau acces la baza veche (versiunea ${head?.version}, ${new Date().toLocaleString('ro-RO')})${mediaNote}.
Le ștergem după ce noul proprietar confirmă că totul merge.
`;
  mkdirSync('data', {recursive: true});
  writeFileSync('data/transfer-mesaj.txt', msg);
  step('Mesajul pentru noul proprietar e în data/transfer-mesaj.txt (nu intră în git: conține chei).');
} else if (cmd === 'setup') {
  const fromDb = opt('from-db'), fromBlob = opt('from-blob');
  if (!fromDb) throw new Error('Lipsește --from-db "<DATABASE_URL vechi>" (e în mesajul primit).');
  if (!existsSync('.vercel/project.json')) throw new Error('Folderul nu e legat de proiectul Vercel: rulează întâi „npx vercel link”.');

  step('Verific variabilele proiectului Vercel');
  const envs = json(vercel(['env', 'ls', '--json'], {capture: true}).stdout);
  const names = new Set((envs.envs ?? envs).map(e => e.key));

  if (!names.has('DATABASE_URL')) {
    if (!flag('accept-neon-terms')) {
      console.log('\nNeon nu e încă creat. Crearea cere acceptarea termenilor Neon (planul gratuit):\n  https://neon.com/platform-terms\n  https://vercel.com/legal/integration-marketplace-end-users-addendum\nDupă acordul explicit al omului, rulează din nou comanda cu --accept-neon-terms.');
      process.exit(2);
    }
    step('Creez baza Neon (purapa-db, Frankfurt, plan gratuit)');
    vercel(['integration', 'accept-terms', 'neon', '--yes']);
    vercel(['integration', 'add', 'neon', '--name', 'purapa-db', '--billing-plan', 'free_v3', '--meta', 'region=fra1', '--no-env-pull']);
  } else console.log('  DATABASE_URL există deja: Neon e creat.');

  if (!names.has('BLOB_READ_WRITE_TOKEN')) {
    step('Creez Blob-ul pentru imagini (purapa-media, public, Frankfurt)');
    vercel(['blob', 'create-store', 'purapa-media', '--access', 'public', '--region', 'fra1', '--yes']);
  } else console.log('  BLOB_READ_WRITE_TOKEN există deja: Blob-ul e creat.');

  step('Aduc cheile în .env.local');
  vercel(['env', 'pull', '.env.local', '--yes']);
  loadEnv();
  if (host(process.env.DATABASE_URL) === host(fromDb)) throw new Error('Proiectul are încă cheile bazei vechi. Vechiul proprietar trebuie să deconecteze Neon-ul și Blob-ul lui de proiect (TRANSFER.md, pasul 3), apoi rulează din nou.');

  step('Copiez baza din Neon-ul vechi');
  const from = createRemote(fromDb), to = createRemote(process.env.DATABASE_URL);
  const snap = await from.get();
  if (!snap) throw new Error('Baza veche nu are purapa.db.');
  const version = await to.put(snap.buf, {force: true});
  mkdirSync('data', {recursive: true});
  writeFileSync('data/purapa.db', snap.buf);
  writeFileSync('data/.db-sync.json', JSON.stringify({version, sha: sha(snap.buf), at: new Date().toISOString()}, null, 2));
  console.log(`  ${DB_NAME}: ${Math.round(snap.buf.length / 1024)} KB, copiată în Neon-ul nou și local`);

  step('Copiez imaginile');
  mkdirSync('data/media', {recursive: true});
  const listed = (await from.sql`select name from brain_media`.catch(() => [])).map(r => r.name);
  const inGit = existsSync('public/media') ? readdirSync('public/media') : [];
  let copied = 0, fromGit = 0, missing = [];
  for (const name of new Set([...listed, ...inGit])) {
    let buf = null;
    if (fromBlob && listed.includes(name)) {
      const r = await get(`media/${name}`, {access: 'private', token: fromBlob, useCache: false}).catch(() => null);
      if (r) { buf = Buffer.from(await new Response(r.stream).arrayBuffer()); copied++; }
    }
    if (!buf && inGit.includes(name)) { buf = readFileSync(join('public/media', name)); fromGit++; }
    if (!buf) { missing.push(name); continue; }
    writeFileSync(join('data/media', name), buf);
  }
  const uploaded = await createMediaSync({remote: to}).upload();
  console.log(`  din Blob-ul vechi: ${copied}, din git: ${fromGit}, urcate în Blob-ul nou: ${uploaded}${missing.length ? `, lipsă: ${missing.join(', ')}` : ''}`);

  step('Republic proiectul cu noile chei');
  const dep = vercel(['deploy', '--prod', '--yes'], {capture: true});
  const url = (dep.stdout.match(/https:\/\/\S+\.vercel\.app/g) ?? []).pop();
  console.log(`  ${url ?? dep.stdout.trim()}`);

  step('Verific panoul online');
  const base = opt('url') ?? url;
  if (base) {
    const r = await fetch(new URL('/manage/', base), {redirect: 'manual'});
    console.log(`  ${base}/manage/ → ${r.status}${r.status === 200 ? ' (merge)' : ' (de verificat: poate cere login Vercel pe adresa de deployment)'}`);
  }
  console.log('\nGata. Spune-i vechiului proprietar că poate șterge Neon-ul și Blob-ul lui (TRANSFER.md, pasul 6).\nLocal: npm start (site + panou, publicare automată pe GitHub-ul tău).');
} else {
  console.log('Folosire: npm run transfer:pack   |   npm run transfer:setup -- --from-db "<url>" [--from-blob "<token>"] [--accept-neon-terms]\nVezi TRANSFER.md.');
}
