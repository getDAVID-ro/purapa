// Imaginile din data/media, păstrate și în Vercel Blob (public, media/<nume>), ca proiectul să poată fi refăcut
// pe alt calculator sau la alt proprietar (npm run setup). Blob-ul ține doar imagini, deci cota lui nu mai blochează panoul.
// Lista celor urcate stă în Neon (brain_media), ca să nu listăm Blob-ul: o verificare costă o interogare Neon,
// iar în Blob se fac operații doar pentru imaginile noi.
import {put, get} from '@vercel/blob';
import {readdir, readFile, writeFile, mkdir, access} from 'node:fs/promises';
import {join} from 'node:path';

const TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif'};
const type = name => TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
const exists = p => access(p).then(() => true, () => false);

export function createMediaSync({remote, dir = 'data/media', token = process.env.BLOB_READ_WRITE_TOKEN, log = console.log} = {}) {
  const opts = {access: 'public', token};

  // Urcă imaginile locale care nu sunt încă în Blob.
  async function upload() {
    await remote.init();
    const known = new Set((await remote.sql`select name from brain_media`).map(r => r.name));
    const files = (await readdir(dir).catch(() => [])).filter(f => !f.startsWith('.') && !known.has(f));
    for (const name of files) {
      const buf = await readFile(join(dir, name));
      await put(`media/${name}`, buf, {...opts, allowOverwrite: true, addRandomSuffix: false, contentType: type(name)});
      await remote.sql`insert into brain_media (name, size) values (${name}, ${buf.length}) on conflict (name) do nothing`;
    }
    if (files.length) log(`[imagini] ${files.length} imagini urcate în Blob`);
    return files.length;
  }

  // Aduce din Blob imaginile care lipsesc local.
  async function download() {
    await remote.init();
    await mkdir(dir, {recursive: true});
    let n = 0;
    for (const {name} of await remote.sql`select name from brain_media order by name`) {
      if (await exists(join(dir, name))) continue;
      const r = await get(`media/${name}`, {...opts, useCache: false});
      if (!r) { log(`[imagini] lipsește din Blob: ${name}`); continue; }
      await writeFile(join(dir, name), Buffer.from(await new Response(r.stream).arrayBuffer()));
      n++;
    }
    if (n) log(`[imagini] ${n} imagini aduse din Blob`);
    return n;
  }

  return {upload, download};
}
