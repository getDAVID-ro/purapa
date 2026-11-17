// Serverul local: site-ul și /manage pe http://localhost:3100. Cât rulează, publică singur:
//   - site-ul public: paginile statice din public/ se regenerează la orice schimbare de conținut și pleacă pe GitHub,
//     iar Vercel le publică (src/core/publisher.mjs). Vizitatorii nu ating nici Neon, nici Blob-ul.
//   - panoul online: baza se sincronizează cu Neon la 15 minute (SYNC_SECONDS), iar imaginile noi din data/media
//     se urcă în Blob (src/core/mediasync.mjs). Neon adoarme între verificări, deci rămâne în planul gratuit.
// Nimic nu se urcă sau se descarcă de mână.
import http from 'node:http';
import {existsSync, writeFileSync, rmSync} from 'node:fs';
import {createApp} from './app.mjs';
import {createPublisher} from './core/publisher.mjs';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const port = Number(process.env.PORT ?? 3100);
const file = process.env.DB ?? 'data/purapa.db';
const local = !process.env.DB; // cu altă bază (teste, încercări) nu se publică nimic

let app, stop, sync = null;
function open() {
  app = createApp({file, syncStatus: () => sync?.conflict ?? null});
  stop = app.sync.start();
}
open();

if (local && process.env.PUBLISH !== '0') {
  const publisher = createPublisher({getStore: () => app.store});
  await publisher.tick();
  setInterval(() => publisher.tick(), 5000).unref?.();
  console.log('purapa: publicarea automată a site-ului e pornită');
}

if (process.env.DATABASE_URL && local) {
  const {createRemote} = await import('./core/remote.mjs');
  const {createDbSync} = await import('./core/dbsync.mjs');
  const remote = createRemote();
  sync = createDbSync({
    file,
    remote,
    checkpoint: () => app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    // Baza online nouă înlocuiește fișierul local; serverul o redeschide fără repornire.
    reopen: async buf => {
      stop();
      app.db.close();
      for (const f of ['-wal', '-shm']) rmSync(file + f, {force: true});
      writeFileSync(file, buf);
      open();
    }
  });
  let media = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const {createMediaSync} = await import('./core/mediasync.mjs');
    media = createMediaSync({remote});
  }
  // Un store Blob blocat (cota depășită) răspunde 403: imaginile se reîncearcă abia peste o oră, cu un singur mesaj.
  let mediaPausedUntil = 0, warned = false;
  const run = async () => {
    try { await sync.tick(); } catch (e) { console.error('[sincronizare] eroare:', e.message); }
    if (!media || Date.now() < mediaPausedUntil) return;
    try {
      await media.upload();
      warned = false;
    } catch (e) {
      if (/403|suspend|forbidden|threshold/i.test(e.message)) {
        mediaPausedUntil = Date.now() + 3600e3;
        if (!warned) console.error('[imagini] Blob-ul e blocat; imaginile se urcă mai târziu. Reîncerc peste o oră.');
        warned = true;
      } else console.error('[imagini] eroare:', e.message);
    }
  };
  await run();
  setInterval(run, Number(process.env.SYNC_SECONDS ?? 900) * 1000).unref?.();
  console.log('purapa: sincronizarea panoului online (Neon) e pornită');
} else if (local) {
  console.log('purapa: fără DATABASE_URL în .env.local, panoul online nu se sincronizează');
}

http.createServer((req, res) => app.handle(req, res)).listen(port, () => console.log(`purapa: http://localhost:${port}/`));
