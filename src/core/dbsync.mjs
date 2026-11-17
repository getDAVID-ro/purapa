// Sincronizarea automată a bazei locale cu cea online (Neon, src/core/remote.mjs), ca să nu urce și să nu coboare nimeni nimic de mână.
// Rulează în serverul local, la 15 minute:
//   - baza locală s-a schimbat (amprenta fișierului) → se urcă, condiționat de versiunea online cunoscută;
//   - online s-a schimbat, iar local nu → se descarcă și serverul local o redeschide;
//   - s-au schimbat amândouă → câștigă cea locală (aici se lucrează), iar cea online se păstrează în data/backup/;
//     lead-urile primite online între timp (tabelul messages) se copiază întâi în baza locală, ca să nu se piardă.
// Starea ultimei sincronizări (versiunea online și amprenta locală) stă în data/.db-sync.json.
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createRemote, ConflictError, DB_NAME, sha} from './remote.mjs';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function createDbSync({file = 'data/purapa.db', record = 'data/.db-sync.json', remote = createRemote(), checkpoint, reopen, log = console.log, keep = ['messages']} = {}) {
  const readRecord = () => existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {version: null, sha: null};
  const writeRecord = r => writeFileSync(record, JSON.stringify({...r, at: new Date().toISOString()}, null, 2));
  let rec = readRecord(), running = false, conflict = null;

  // Jurnalul WAL golit în fișierul principal, ca fișierul urcat să conțină tot.
  const flush = () => {
    if (checkpoint) return checkpoint();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  };

  // Rândurile din tabelele `keep` care există doar în copia online (după data creării și email) se adaugă în baza locală.
  function mergeRows(saved) {
    const db = new DatabaseSync(file);
    let n = 0;
    try {
      db.exec(`ATTACH DATABASE '${saved.replace(/'/g, "''")}' AS online`);
      for (const t of keep) {
        try {
          const theirs = new Set(db.prepare(`PRAGMA online.table_info("${t}")`).all().map(c => c.name));
          const cols = db.prepare(`PRAGMA main.table_info("${t}")`).all().map(c => c.name).filter(c => c !== 'id' && theirs.has(c)).map(c => `"${c}"`).join(', ');
          if (!cols) continue;
          n += Number(db.prepare(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM online."${t}" o
            WHERE NOT EXISTS (SELECT 1 FROM main."${t}" m WHERE m.created_at = o.created_at AND m.email = o.email)`).run().changes);
        } catch (e) { log(`[sincronizare] rândurile din ${t} nu au putut fi copiate: ${e.message}`); }
      }
    } finally { db.close(); }
    return n;
  }

  async function tick() {
    if (running) return null;
    running = true;
    try {
      flush();
      let local = readFileSync(file);
      let localSha = sha(local);
      const online = await remote.head();
      const localChanged = localSha !== rec.sha;
      const remoteChanged = !!online && online.version !== rec.version;

      if (localChanged) {
        try {
          // Prima sincronizare (fără versiune cunoscută) urcă doar dacă online nu există încă nimic.
          const version = await remote.put(local, {ifVersion: rec.version});
          rec = {version, sha: localSha};
          writeRecord(rec);
          conflict = null;
          log(`[sincronizare] baza locală a fost urcată online (${Math.round(local.length / 1024)} KB)`);
          return 'upload';
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          // Ambele s-au schimbat: varianta online se păstrează întreagă, apoi câștigă cea locală.
          const {buf} = await remote.get();
          mkdirSync('data/backup', {recursive: true});
          const saved = `data/backup/${stamp()}-online-${DB_NAME}`;
          writeFileSync(saved, buf);
          const kept = mergeRows(saved);
          if (kept) {
            flush();
            local = readFileSync(file);
            localSha = sha(local);
            log(`[sincronizare] ${kept} lead-uri primite online au fost păstrate`);
          }
          const version = await remote.put(local, {force: true});
          rec = {version, sha: localSha};
          writeRecord(rec);
          conflict = {at: new Date().toISOString(), saved};
          log(`[sincronizare] CONFLICT: s-a modificat și online și local. A rămas varianta locală; cea online e în ${saved}`);
          return 'conflict';
        }
      }
      if (remoteChanged) {
        // Local nu s-a schimbat de la ultima sincronizare, deci nu se pierde nimic: baza locală e o copie deja urcată.
        const {buf, version} = await remote.get();
        await reopen(buf);
        rec = {version, sha: sha(buf)};
        writeRecord(rec);
        log('[sincronizare] modificările online au fost aduse local');
        return 'download';
      }
      return null;
    } finally {
      running = false;
    }
  }

  return {tick, get conflict() { return conflict; }, get record() { return rec; }};
}
