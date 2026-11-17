// Aduce pe site imaginile din media care stau pe alt server (de exemplu Unsplash): le descarcă în WebP, sub 200 KB,
// în data/media/<sha1>.webp, și schimbă înregistrarea din Brain (același ID, deci paginile care le folosesc se refac singure).
// Se poate rula de mai multe ori: imaginile deja găzduite sunt sărite. Rulează-l cu serverul local oprit.
//   node scripts/host-media.mjs          baza data/purapa.db
//   DB=altă.db node scripts/host-media.mjs
import {createHash} from 'node:crypto';
import {writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {openDb, migrate} from '../src/core/db.mjs';
import {createStore, SYSTEM} from '../src/core/store.mjs';

const MAX = 200 * 1024, DIR = 'data/media';
const db = openDb(process.env.DB ?? 'data/purapa.db');
migrate(db);
const store = createStore(db);
const user = {...SYSTEM, name: 'Imagini găzduite pe site'};
mkdirSync(DIR, {recursive: true});

// Dimensiunile unui WebP (VP8, VP8L sau VP8X), din antetul fișierului.
function webpSize(b) {
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return {width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3)};
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return {width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1}; }
  return {width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff};
}

// Unsplash (imgix) dă WebP cu fm=webp; calitatea, apoi lățimea (păstrând proporția) coboară până intră sub 200 KB.
const variant = (src, q, scale = 1) => {
  const u = new URL(src);
  if (!/(^|\.)unsplash\.com$/.test(u.hostname)) return src;
  u.searchParams.delete('auto');
  u.searchParams.set('fm', 'webp');
  u.searchParams.set('q', String(q));
  for (const k of ['w', 'h']) if (u.searchParams.has(k)) u.searchParams.set(k, String(Math.round(Number(u.searchParams.get(k)) * scale)));
  return u.href;
};
const TRIES = [[80, 1], [72, 1], [64, 1], [72, .75], [64, .75], [64, .6], [56, .6], [56, .5]];

let n = 0;
for (const m of store.list('media').filter(m => /^https?:\/\//.test(m.src ?? ''))) {
  let buf = null;
  for (const [q, scale] of TRIES) {
    const r = await fetch(variant(m.src, q, scale), {headers: {accept: 'image/webp'}});
    if (!r.ok) throw new Error(`media ${m.id}: ${r.status} la ${m.src}`);
    buf = Buffer.from(await r.arrayBuffer());
    if (buf.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`media ${m.id}: serverul nu a dat WebP (${r.headers.get('content-type')})`);
    if (buf.length <= MAX) break;
  }
  if (buf.length > MAX) console.warn(`  media ${m.id}: ${Math.round(buf.length / 1024)} KB, peste 200 KB`);
  const sha1 = createHash('sha1').update(buf).digest('hex');
  writeFileSync(join(DIR, `${sha1}.webp`), buf);
  store.update(user, 'media', m.id, {src: `${sha1}.webp`, sha1, ...webpSize(buf)});
  console.log(`  media ${m.id}: ${sha1}.webp (${Math.round(buf.length / 1024)} KB), înainte ${m.src}`);
  n++;
}
db.close();
console.log(n ? `${n} imagini aduse pe site. Urmează: npm run build:public (sau npm start).` : 'Toate imaginile sunt deja pe site.');
