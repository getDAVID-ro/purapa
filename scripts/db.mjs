// Baza online (Neon) și imaginile (Blob). Sincronizarea e automată cât rulează npm start; scriptul e pentru situații speciale:
//   npm run setup                    calculator nou / proprietar nou: aduce baza din Neon și imaginile din Blob, apoi regenerează public/
//   npm run db:sync                  o sincronizare acum, cu serverul local oprit (aceleași reguli ca serverul)
//   npm run db:upload -- --force     urcă baza locală peste cea online, oricum
//   npm run db:download -- --force   aduce baza online peste cea locală, oricum (cea locală se păstrează în data/backup/)
//   npm run media:upload             urcă în Blob imaginile din data/media care nu sunt încă acolo
// Cheile (DATABASE_URL, BLOB_READ_WRITE_TOKEN) vin în .env.local, cu: npx vercel env pull .env.local
import {readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRemote, DB_NAME, sha} from '../src/core/remote.mjs';
import {createDbSync} from '../src/core/dbsync.mjs';
import {createMediaSync} from '../src/core/mediasync.mjs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const DB = 'data/purapa.db', RECORD = 'data/.db-sync.json';
const [cmd] = process.argv.slice(2);
const FORCE = process.argv.includes('--force');
const remote = createRemote();
const record = (version, buf) => writeFileSync(RECORD, JSON.stringify({version, sha: sha(buf), at: new Date().toISOString()}, null, 2));
const replaceLocal = buf => {
  mkdirSync('data', {recursive: true});
  try { for (const f of ['-wal', '-shm']) rmSync(DB + f, {force: true}); }
  catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY') throw new Error('Baza locală e deschisă de serverul local: oprește-l și rulează din nou.'); throw e; }
  writeFileSync(DB, buf);
};
const backupLocal = () => {
  if (!existsSync(DB)) return;
  mkdirSync('data/backup', {recursive: true});
  copyFileSync(DB, `data/backup/${new Date().toISOString().replace(/[:.]/g, '-')}-local-${DB_NAME}`);
};
const download = async () => {
  const r = await remote.get();
  if (!r) throw new Error(`În Neon nu există încă ${DB_NAME}.`);
  backupLocal();
  replaceLocal(r.buf);
  record(r.version, r.buf);
  return r;
};

if (cmd === 'sync') {
  const r = await createDbSync({file: DB, record: RECORD, remote, reopen: async buf => replaceLocal(buf)}).tick();
  console.log(r ? `Sincronizat: ${r}.` : 'Nimic de sincronizat.');
} else if (cmd === 'upload' && FORCE) {
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const buf = readFileSync(DB);
  record(await remote.put(buf, {force: true}), buf);
  console.log(`Urcat peste baza online: ${DB_NAME} (${Math.round(buf.length / 1024)} KB).`);
} else if (cmd === 'download' && FORCE) {
  await download();
  console.log('Adus peste baza locală (cea veche e în data/backup/).');
} else if (cmd === 'media:upload') {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Lipsește BLOB_READ_WRITE_TOKEN în .env.local.');
  console.log(`Imagini urcate: ${await createMediaSync({remote}).upload()}.`);
} else if (cmd === 'setup') {
  if (existsSync(DB) && !FORCE) throw new Error('Există deja data/purapa.db. Ca s-o înlocuiești cu cea online: npm run setup -- --force');
  const r = await download();
  console.log(`Baza adusă din Neon (versiunea ${r.version}, ${Math.round(r.buf.length / 1024)} KB).`);
  if (process.env.BLOB_READ_WRITE_TOKEN) console.log(`Imagini aduse din Blob: ${await createMediaSync({remote}).download()}.`);
  else console.log('Fără BLOB_READ_WRITE_TOKEN: imaginile nu s-au adus din Blob.');
  console.log('Gata. Pornește cu: npm start');
} else {
  console.log('Sincronizarea e automată cât rulează npm start. Pentru situații speciale:\n  npm run setup\n  npm run db:sync\n  npm run db:upload -- --force\n  npm run db:download -- --force\n  npm run media:upload');
}
