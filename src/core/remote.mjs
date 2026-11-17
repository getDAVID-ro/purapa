// Baza panoului online (SQLite, purapa.db) ținută în Neon (Postgres), ca un singur rând: fișierul comprimat + o versiune.
// Versiunea ține locul ETag-ului din Blob: o scriere trece doar dacă nimeni n-a scris între timp (altfel ConflictError).
// O verificare e o interogare mică (versiunea), deci panoul online nu mai depinde de cota Blob.
// Tabelul brain_media ține lista imaginilor urcate în Blob (src/core/mediasync.mjs), ca să nu listăm Blob-ul.
import {neon} from '@neondatabase/serverless';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export const DB_NAME = 'purapa.db';
export class ConflictError extends Error {
  constructor() { super('Între timp baza online a fost salvată de altcineva.'); this.name = 'ConflictError'; }
}
export const sha = buf => createHash('sha1').update(buf).digest('hex');

export function createRemote(url = process.env.DATABASE_URL, {name = DB_NAME} = {}) {
  if (!url) throw new Error('Lipsește DATABASE_URL (Neon): rulează „npx vercel env pull .env.local”.');
  const sql = neon(url);
  let ready = null;
  const init = () => ready ??= (async () => {
    await sql`create table if not exists brain_snapshot (
      name text primary key, version bigint not null, sha text not null, size integer not null,
      data text not null, updated_at timestamptz not null default now())`;
    await sql`create table if not exists brain_media (
      name text primary key, size integer not null, uploaded_at timestamptz not null default now())`;
  })().catch(e => { ready = null; throw e; });
  const pack = buf => gzipSync(buf, {level: 9}).toString('base64');

  return {
    sql,
    init,
    // Versiunea și amprenta online, fără conținut; null dacă încă nu s-a urcat nimic.
    async head() {
      await init();
      const [r] = await sql`select version, sha from brain_snapshot where name = ${name}`;
      return r ? {version: Number(r.version), sha: r.sha} : null;
    },
    // Fișierul întreg; cu ifNotVersion, null dacă online e tot versiunea aceea.
    async get({ifNotVersion} = {}) {
      await init();
      const [r] = ifNotVersion == null
        ? await sql`select version, data from brain_snapshot where name = ${name}`
        : await sql`select version, data from brain_snapshot where name = ${name} and version <> ${ifNotVersion}`;
      return r ? {buf: gunzipSync(Buffer.from(r.data, 'base64')), version: Number(r.version)} : null;
    },
    // ifVersion: număr → scrie doar peste versiunea aceea; null → doar dacă online nu există nimic; force → oricum.
    async put(buf, {ifVersion = null, force = false} = {}) {
      await init();
      const data = pack(buf), s = sha(buf), size = buf.length;
      const rows = force
        ? await sql`insert into brain_snapshot (name, version, sha, size, data) values (${name}, 1, ${s}, ${size}, ${data})
            on conflict (name) do update set version = brain_snapshot.version + 1, sha = excluded.sha, size = excluded.size,
            data = excluded.data, updated_at = now() returning version`
        : ifVersion == null
          ? await sql`insert into brain_snapshot (name, version, sha, size, data) values (${name}, 1, ${s}, ${size}, ${data})
              on conflict (name) do nothing returning version`
          : await sql`update brain_snapshot set version = version + 1, sha = ${s}, size = ${size}, data = ${data}, updated_at = now()
              where name = ${name} and version = ${ifVersion} returning version`;
      if (!rows.length) throw new ConflictError();
      return Number(rows[0].version);
    }
  };
}
