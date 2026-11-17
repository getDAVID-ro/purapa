// npm run blob:copy — copiază imaginile Purapa în Blob-ul vostru (TRANSFER.md, README „Mutarea imaginilor în Blob-ul vostru”).
//
// Citește din .env.local (îl aduce `npx vercel env pull .env.local`):
//   DWF_BLOB_TOKEN        depozitul vechi, al DWF (din el doar citește; poate lipsi)
//   BLOB_READ_WRITE_TOKEN depozitul vostru, nou (public)
//   DATABASE_URL          baza Neon, unde se ține lista imaginilor (brain_media)
//
// Imaginile vin din Blob-ul DWF (media/…) și din copia lor din git (public/media, plus data/media dacă există).
// Se poate rula de oricâte ori: fișierele deja copiate (aceeași cale, aceeași mărime) sunt sărite.
// La final verifică fiecare fișier în Blob-ul vostru.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, extname} from 'node:path';
import {list, get, put} from '@vercel/blob';
import {createRemote} from '../src/core/remote.mjs';
import {storeId} from '../src/core/stare.mjs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const OLD = (process.env.DWF_BLOB_TOKEN ?? '').trim();
const NEW = (process.env.BLOB_READ_WRITE_TOKEN ?? '').trim();
const TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif'};
const hide = text => [OLD, NEW].filter(Boolean).reduce((t, k, i) => t.split(k).join(i ? '<BLOB_READ_WRITE_TOKEN>' : '<DWF_BLOB_TOKEN>'), String(text));
const stop = message => { console.error(`\n✗ ${hide(message)}\n`); process.exit(1); };

if (!NEW) stop('Lipsește BLOB_READ_WRITE_TOKEN în .env.local. Creați Blob-ul vostru (Storage → Create → Blob, public, Frankfurt, legat de proiect, cu Development bifat), apoi: npx vercel env pull .env.local');
if (OLD && storeId(OLD) === storeId(NEW)) stop('BLOB_READ_WRITE_TOKEN este încă tokenul depozitului DWF. Ștergeți-l din proiect (Settings → Environment Variables), creați Blob-ul vostru, apoi: npx vercel env pull .env.local');
if (!process.env.DATABASE_URL) stop('Lipsește DATABASE_URL în .env.local (baza Neon a proiectului). Rulați: npx vercel env pull .env.local');

async function listAll(token, prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({token, prefix, limit: 1000, cursor});
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function main() {
  // Sursele: întâi copia din git, apoi Blob-ul DWF (dacă răspunde) pentru ce lipsește din git.
  const files = new Map();
  for (const dir of ['public/media', 'data/media']) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (!name.startsWith('.') && !files.has(name)) files.set(name, () => readFileSync(join(dir, name)));
  }
  console.log(`În git: ${files.size} imagini.`);
  if (OLD) {
    try {
      const old = await listAll(OLD, 'media/');
      let extra = 0;
      for (const b of old) {
        const name = b.pathname.slice('media/'.length);
        if (!name || files.has(name)) continue;
        extra++;
        files.set(name, async () => {
          const r = await get(b.pathname, {access: 'private', token: OLD, useCache: false});
          if (!r) throw new Error('lipsește din Blob-ul DWF');
          return Buffer.from(await new Response(r.stream).arrayBuffer());
        });
      }
      console.log(`În Blob-ul DWF: ${old.length} imagini (${extra} care nu sunt în git).`);
    } catch (e) {
      console.log(`Blob-ul DWF nu răspunde (${hide(e.message)}); copiez din git.`);
    }
  }
  if (!files.size) return console.log('\n✓ Nu e nimic de copiat.');

  console.log('Citesc Blob-ul vostru…');
  const have = new Map((await listAll(NEW, 'media/')).map(b => [b.pathname, b.size]));
  let done = 0, failed = 0;
  const sizes = new Map();
  for (const [name, read] of files) {
    try {
      const buf = await read();
      sizes.set(name, buf.length);
      if (have.get(`media/${name}`) === buf.length) continue;
      // o singură operație pe fișier: fără multipart, care costă mai multe operații din limita lunară
      await put(`media/${name}`, buf, {access: 'public', token: NEW, allowOverwrite: true, addRandomSuffix: false,
        contentType: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'});
      console.log(`  ↑ ${++done} media/${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ media/${name}: ${hide(e.message)}`);
    }
  }
  console.log(`Copiate acum: ${done} (deja copiate: ${files.size - done - failed}).`);

  console.log('\nVerific fiecare fișier în Blob-ul vostru…');
  const now = new Map((await listAll(NEW, 'media/')).map(b => [b.pathname, b]));
  const remote = createRemote();
  await remote.init();
  let ok = 0;
  for (const [name, size] of sizes) {
    const n = now.get(`media/${name}`);
    if (n && n.size === size) {
      ok++;
      await remote.sql`insert into brain_media (name, size) values (${name}, ${size}) on conflict (name) do update set size = excluded.size`;
      console.log(`  ✓ media/${name} (${size} B)`);
    } else console.log(`  ✗ media/${name}: ${n ? `are ${n.size} B în loc de ${size} B` : 'lipsește'}`);
  }
  if (ok !== files.size) stop(`${files.size - ok} din ${files.size} fișiere nu s-au copiat. Rulați din nou: npm run blob:copy`);
  const sample = now.values().next().value;
  console.log(`\n✓ Gata: toate cele ${ok} imagini sunt în Blob-ul vostru${sample ? ` (${new URL(sample.url).origin})` : ''}.`);
}

main().catch(e => stop(`Copierea s-a oprit: ${e?.message ?? e}`));
