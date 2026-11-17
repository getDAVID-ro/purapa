// Testele de apă trimise prin formularul /test-rapid/: contactul, fotografia benzii și rezultatul analizei.
// Stau în Neon, în tabelul lor (water_tests), nu în baza panoului (purapa.db): un vizitator care trimite un test nu
// rescrie baza editorilor și nu intră în conflict cu ei. Fotografia (JPEG micșorat în browser) stă în același rând.
//
// Fluxul: site.js trimite contactul și fotografia (POST /api/teste) în timp ce analiza rulează la serviciul extern;
// primește un id și o cheie, cu care trimite apoi rezultatul (POST /api/teste/<id>). Panoul le arată la /manage/teste/.
import {neon} from '@neondatabase/serverless';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

export const MAX_IMAGE = 3 * 1024 * 1024; // după micșorarea din browser, o fotografie are de obicei 200–600 KB
const PER_IP_HOUR = 6, PER_DAY = 400;
export const STATUSES = {nou: 'Nou', contactat: 'Contactat', inchis: 'Închis'};
export const OUTCOMES = {analizat: 'Analizat', calitate: 'Poză neclară', asteptare: 'Analiză în așteptare', eroare: 'Eroare la analiză'};

export class TestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tipul fotografiei, după primii octeți (nu după ce declară browserul).
export function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Validarea pe server a unei trimiteri (aceleași reguli ca în formular, plus limitele fotografiei).
export function validateSubmission(b) {
  if (b?.website) throw new TestError(400, 'Cerere respinsă.'); // câmpul capcană, ascuns oamenilor
  const lead = {
    name: clean(b?.name, 120), email: clean(b?.email, 160).toLowerCase(), phone: clean(b?.phone, 40),
    location: clean(b?.location, 120), note: clean(b?.note, 500), gdpr: b?.gdpr === true, consentContact: b?.consentContact === true
  };
  if (!lead.name || !lead.location) throw new TestError(400, 'Completează numele și localitatea.');
  if (!EMAIL.test(lead.email)) throw new TestError(400, 'Adresa de email nu e validă.');
  if (!lead.gdpr) throw new TestError(400, 'Fără acordul pentru prelucrarea datelor nu putem păstra testul.');
  const raw = String(b?.image ?? '').replace(/^data:[^,]*,/, '');
  if (!raw) throw new TestError(400, 'Lipsește fotografia.');
  if (raw.length > Math.ceil(MAX_IMAGE * 4 / 3) + 4) throw new TestError(413, 'Fotografia e prea mare.');
  const image = Buffer.from(raw, 'base64');
  const type = imageType(image);
  if (!type) throw new TestError(400, 'Fișierul trimis nu e o fotografie (JPEG, PNG sau WebP).');
  return {lead, image, type, analysisPath: clean(b?.analysisPath, 200) || null};
}

// Rezultatul analizei, păstrat așa cum l-a dat serviciul extern (fără câmpuri uriașe).
export function validateResult(b) {
  const outcome = OUTCOMES[b?.outcome] ? b.outcome : 'eroare';
  const result = b?.result && typeof b.result === 'object' ? b.result : null;
  const json = result ? JSON.stringify(result) : null;
  if (json && json.length > 200_000) throw new TestError(413, 'Rezultatul e prea mare.');
  return {outcome, result: json, error: clean(b?.error, 500) || null};
}

export function createWaterTests(url = process.env.DATABASE_URL, {sql = url ? neon(url) : null, salt = process.env.TESTS_SALT ?? 'purapa'} = {}) {
  let ready = null;
  const available = () => Boolean(sql);
  const need = () => { if (!sql) throw new TestError(503, 'Testele de apă au nevoie de baza Neon (DATABASE_URL).'); };
  const init = () => ready ??= (async () => {
    need();
    await sql`create table if not exists water_tests (
      id bigserial primary key, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      token text not null, name text not null, email text not null, phone text, location text, note text,
      gdpr boolean not null default false, consent_contact boolean not null default false,
      image bytea, image_type text, image_size integer, analysis_path text,
      outcome text, result jsonb, error text, status text not null default 'nou', ip_hash text, user_agent text)`;
    await sql`create index if not exists water_tests_created on water_tests (created_at desc)`;
  })().catch(e => { ready = null; throw e; });
  const ipHash = ip => createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 24);

  return {
    available,
    init,

    // O trimitere nouă, de la vizitator. Limite: câteva pe oră de la aceeași adresă, câteva sute pe zi în total.
    async submit(body, {ip = '', userAgent = ''} = {}) {
      await init();
      const {lead, image, type, analysisPath} = validateSubmission(body);
      const h = ipHash(ip);
      const [{mine, total}] = await sql`select
        count(*) filter (where ip_hash = ${h} and created_at > now() - interval '1 hour')::int as mine,
        count(*) filter (where created_at > now() - interval '1 day')::int as total from water_tests`;
      if (mine >= PER_IP_HOUR || total >= PER_DAY) throw new TestError(429, 'Prea multe teste trimise. Încearcă din nou mai târziu.');
      const token = randomBytes(18).toString('base64url');
      const [r] = await sql`insert into water_tests (token, name, email, phone, location, note, gdpr, consent_contact,
          image, image_type, image_size, analysis_path, ip_hash, user_agent)
        values (${token}, ${lead.name}, ${lead.email}, ${lead.phone || null}, ${lead.location}, ${lead.note || null}, ${lead.gdpr}, ${lead.consentContact},
          ${image}, ${type}, ${image.length}, ${analysisPath}, ${h}, ${clean(userAgent, 300)})
        returning id`;
      return {id: Number(r.id), token};
    },

    // Rezultatul analizei, trimis de același browser (cu cheia primită la trimitere), cel mult o dată, în prima oră.
    async saveResult(id, body) {
      await init();
      const [row] = await sql`select token, outcome, created_at from water_tests where id = ${Number(id)}`;
      const given = Buffer.from(String(body?.token ?? '')), real = Buffer.from(row?.token ?? '');
      if (!row || given.length !== real.length || !timingSafeEqual(given, real)) throw new TestError(404, 'Testul nu există.');
      if (row.outcome || Date.now() - new Date(row.created_at).getTime() > 3600e3) throw new TestError(409, 'Rezultatul a fost deja salvat.');
      const {outcome, result, error} = validateResult(body);
      await sql`update water_tests set outcome = ${outcome}, result = ${result}::jsonb, error = ${error}, updated_at = now() where id = ${Number(id)}`;
      return {ok: true};
    },

    // Pentru panou.
    async list({limit = 500} = {}) {
      await init();
      return sql`select id, created_at, name, email, phone, location, outcome, status, consent_contact, image_size,
        (select count(*) from jsonb_array_elements(case when jsonb_typeof(result->'parameters') = 'array' then result->'parameters' else '[]'::jsonb end))::int as params
        from water_tests order by created_at desc limit ${limit}`;
    },
    async get(id) {
      await init();
      const [r] = await sql`select id, created_at, updated_at, name, email, phone, location, note, gdpr, consent_contact, image_type, image_size,
        analysis_path, outcome, result, error, status, user_agent from water_tests where id = ${Number(id)}`;
      return r ?? null;
    },
    async image(id) {
      await init();
      const [r] = await sql`select image, image_type from water_tests where id = ${Number(id)}`;
      return r?.image ? {data: Buffer.from(r.image), type: r.image_type} : null;
    },
    async setStatus(id, status) {
      await init();
      if (!STATUSES[status]) throw new TestError(400, 'Stare necunoscută.');
      const rows = await sql`update water_tests set status = ${status}, updated_at = now() where id = ${Number(id)} returning id`;
      if (!rows.length) throw new TestError(404, 'Testul nu există.');
      return {ok: true};
    },
    // Ștergerea definitivă (de exemplu la cererea persoanei, GDPR).
    async remove(id) {
      await init();
      const rows = await sql`delete from water_tests where id = ${Number(id)} returning id`;
      if (!rows.length) throw new TestError(404, 'Testul nu există.');
      return {ok: true};
    },
    async countRecent(days = 7) {
      if (!sql) return 0;
      await init();
      const [r] = await sql`select count(*)::int as n from water_tests where created_at > now() - make_interval(days => ${days})`;
      return r.n;
    }
  };
}

// Rutele publice, aceleași pe Vercel (api/index.mjs, fără baza panoului) și pe serverul local (src/app.mjs):
//   POST /api/teste        contactul și fotografia → {id, token}
//   POST /api/teste/<id>   rezultatul analizei (cu token)
// Întoarce true dacă a răspuns el.
export async function testsPublicRoute(tests, req, res, path) {
  const m = /^\/api\/teste(?:\/(\d+))?\/?$/.exec(path);
  if (!m) return false;
  const send = (status, body) => {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex'});
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== 'POST') throw new TestError(405, 'Metodă nepermisă.');
    // Doar de pe site-ul propriu: cererile din alte site-uri sunt refuzate.
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new TestError(403, 'Origine nepermisă.');
    if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new TestError(415, 'Se acceptă doar JSON.');
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > MAX_IMAGE * 1.4 + 20000) throw new TestError(413, 'Cererea e prea mare.'); }
    let body;
    try { body = JSON.parse(raw); } catch { throw new TestError(400, 'JSON invalid.'); }
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim();
    if (!tests.available()) throw new TestError(503, 'Testele nu se pot salva acum.');
    return send(200, m[1] ? await tests.saveResult(m[1], body) : await tests.submit(body, {ip, userAgent: req.headers['user-agent']})), true;
  } catch (e) {
    if (!(e instanceof TestError)) console.error(e);
    return send(e instanceof TestError ? e.status : 500, {error: e instanceof TestError ? e.message : 'Testul nu s-a putut salva.'}), true;
  }
}
