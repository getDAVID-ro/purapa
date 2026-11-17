// Intrarea pe Vercel pentru tot ce nu e fișier static. Site-ul public e în public/ (generat local și publicat prin git),
// deci aici ajung doar /manage, /api și adresele care nu există.
// Baza (SQLite, purapa.db) stă în Neon (src/core/remote.mjs) și e citită doar pentru /manage și /api. Fiecare instanță o ține în /tmp:
//   - verifică versiunea din Neon cel mult o dată la 30 de secunde (plus înaintea fiecărei scrieri);
//   - după o cerere care scrie, rulează propagarea și urcă baza înapoi condiționat (pe versiune): dacă între timp
//     a scris altă instanță, nu se suprascrie nimic, iar panoul primește 409 („reîncarcă și salvează din nou”).
import {createRemote, ConflictError} from '../src/core/remote.mjs';
import {mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join, extname} from 'node:path';
import {createApp} from '../src/app.mjs';

const TMP = '/tmp/purapa', DB = join(TMP, 'purapa.db');
const CHECK_MS = 30e3;
let app = null, version = null, checkedAt = 0, remote = null;

// Adresele publice care n-au fișier static: fără bara finală → 301 spre varianta cu bară; altfel pagina 404.
async function publicFallback(path, res) {
  if (!path.endsWith('/') && !extname(path)) {
    res.writeHead(301, {location: `${path}/`});
    return res.end();
  }
  const html = await readFile(join(process.cwd(), 'public', '404.html')).catch(() => 'Pagina nu există.');
  res.writeHead(404, {'content-type': 'text/html; charset=utf-8'});
  return res.end(html);
}

const unavailable = res => {
  res.writeHead(503, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Panoul online e indisponibil</title>
<main style="font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>Panoul online e indisponibil momentan</h1>
<p>Baza online (Neon) nu răspunde. Site-ul public funcționează normal: e publicat din git.</p>
<p>Conținutul se poate edita în panoul local (<code>npm start</code>, apoi <code>http://localhost:3100/manage/</code>); se publică singur.</p>
<p><a href="/">Înapoi la site</a></p></main>`);
};

async function load() {
  remote ??= createRemote();
  const r = await remote.get(app && version != null ? {ifNotVersion: version} : {});
  if (!r) {
    if (app) return; // aceeași versiune
    throw new Error('purapa.db lipsește din Neon (prima urcare o face npm start, sau npm run db:upload -- --force)');
  }
  const buf = r.buf;
  app?.db.close();
  await mkdir(TMP, {recursive: true});
  for (const f of ['', '-wal', '-shm']) await rm(DB + f, {force: true});
  await writeFile(DB, buf);
  version = r.version;
  app = createApp({file: DB, mediaDir: join(process.cwd(), 'public', 'media')});
  app.db.exec('PRAGMA journal_mode = DELETE'); // un singur fișier, gata de urcat
}

async function persist() {
  version = await remote.put(await readFile(DB), {ifVersion: version});
}

export default async function purapa(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  if (path !== '/manage' && !path.startsWith('/manage/') && !path.startsWith('/api/')) return publicFallback(path, res);

  const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  try {
    if (!app || writes || Date.now() - checkedAt > CHECK_MS) {
      await load();
      checkedAt = Date.now();
    }
  } catch (e) {
    console.error(e);
    return unavailable(res);
  }
  if (!writes) return app.handle(req, res);

  // La scrieri, răspunsul (antetele și corpul) pleacă abia după ce baza a ajuns în Neon.
  const writeHead = res.writeHead.bind(res), end = res.end.bind(res);
  let head = null, finish;
  const ended = new Promise(r => { finish = r; });
  res.writeHead = (...args) => { head = args; return res; };
  res.end = (...args) => { finish(args); return res; };
  await app.handle(req, res);
  const body = await ended;
  res.writeHead = writeHead; res.end = end;
  try {
    app.sync.process();
    await persist();
  } catch (e) {
    console.error(e);
    version = null; // la următoarea cerere se reîncarcă versiunea din Neon
    const conflict = e instanceof ConflictError;
    for (const h of res.getHeaderNames()) res.removeHeader(h);
    res.writeHead(conflict ? 409 : 500, {'content-type': 'application/json; charset=utf-8'});
    return res.end(JSON.stringify({error: conflict ? 'Între timp a salvat altcineva. Reîncarcă pagina și salvează din nou.' : 'Salvarea nu a ajuns în baza online.'}));
  }
  if (head) res.writeHead(...head);
  return res.end(...body);
}
