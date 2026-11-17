// Aplicația: baza, store-ul, propagarea, site-ul public, /manage și /api/manage, legate într-un singur handler HTTP.
import {readFile} from 'node:fs/promises';
import {join, normalize, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {openDb, migrate} from './core/db.mjs';
import {createStore, HttpError, SYSTEM, can} from './core/store.mjs';
import {createSync} from './core/sync.mjs';
import {createGraph} from './core/graph.mjs';
import {createTodos} from './core/todos.mjs';
import {createAuth, isLocal} from './auth/auth.mjs';
import {createApi} from './manage/api.mjs';
import {renderManage, manageCounts} from './manage/pages.mjs';
import {testsList, testView, testsLocked} from './manage/views/tests.mjs';
import {createWaterTests, testsPublicRoute, TestError} from './core/watertests.mjs';
import {login as loginPage} from './manage/views/users.mjs';
import {createContext} from './site/context.mjs';
import {renderPath, publicPaths, indexable, robotsTxt} from './site/render.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'manage', 'assets');
const SITE_ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'site', 'assets');
const MIME = {'.woff2': 'font/woff2','.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};

// `syncStatus()`: starea sincronizării cu baza online (serverul local), afișată în panou la un conflict.
// `tests`: testele de apă din formularul /test-rapid/, ținute în Neon (src/core/watertests.mjs).
export function createApp({file = 'data/purapa.db', mediaDir = 'data/media', cronKey = process.env.CRON_KEY, syncStatus = () => null,
  tests = createWaterTests()} = {}) {
  const db = openDb(file);
  migrate(db);
  const store = createStore(db);
  const sync = createSync(db, store);
  const graph = createGraph(db, store);
  const todos = createTodos(db, store, graph);
  const auth = createAuth(db);
  const api = createApi({db, store, sync, graph, todos, auth});
  const env = {db, store, sync, graph, todos, auth, api, syncStatus};

  // Până la lansare (SITE_INDEX=1), niciun răspuns nu se indexează: pagini, imagini, fișiere.
  const send = (res, status, body, type = 'application/json; charset=utf-8', headers = {}) => {
    res.writeHead(status, {'content-type': type, ...(indexable() ? {} : {'x-robots-tag': 'noindex, nofollow'}), ...headers});
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  const secure = req => req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  const ipOf = req => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

  async function readBody(req) {
    // Pe Vercel, corpul cererilor publice e citit dinainte (api/index.mjs), ca cererea să poată fi reluată la un conflict.
    let raw = req.rawBody ?? '';
    if (req.rawBody == null) for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new HttpError(413, 'Cerere prea mare'); }
    if (!raw) return {};
    if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'JSON invalid'); }
  }

  // Autentificarea: login, logout și primul cont (doar local, doar cât nu există niciun cont).
  async function authRoute(req, res, path) {
    const headers = {'cache-control': 'no-store'};
    if (path === '/api/manage/auth/login') {
      const b = await readBody(req);
      const {token, expires, user} = auth.login(b.email, b.password, ipOf(req));
      return send(res, 200, {user}, undefined, {...headers, 'set-cookie': auth.cookie(token, expires, secure(req))});
    }
    if (path === '/api/manage/auth/logout') {
      auth.logout(auth.tokenOf(req));
      return send(res, 200, {ok: true}, undefined, {...headers, 'set-cookie': auth.clearCookie(secure(req))});
    }
    if (path === '/api/manage/auth/setup') {
      if (auth.hasUsers() || !isLocal(req)) throw new HttpError(403, 'Primul cont se creează doar local, cât nu există niciun cont');
      const b = await readBody(req);
      auth.createUser({email: b.email, name: b.name, password: b.password, role: 'admin'});
      const {token, expires, user} = auth.login(b.email, b.password, ipOf(req));
      return send(res, 200, {user}, undefined, {...headers, 'set-cookie': auth.cookie(token, expires, secure(req))});
    }
    return null;
  }

  // Teste apă în panou: lista, fișa, fotografia și acțiunile (stare, ștergere). Datele sunt în Neon, deci totul e asincron.
  async function testsManage(req, res, path, user, headers) {
    if (!can(user, 'content.read')) throw new HttpError(403, 'Lipsește dreptul content.read');
    const ctx = {...env, user, counts: manageCounts(env)};
    // Datele personale (nume, email, telefon, fotografii) nu se arată cât panoul e deschis oricui (MANAGE_OPEN=1).
    if (user.open) {
      if (req.method !== 'GET') throw new HttpError(403, 'Testele de apă cer autentificare.');
      return send(res, 403, testsLocked(ctx), 'text/html; charset=utf-8', headers);
    }
    const m = /^\/manage\/teste\/(?:(\d+)\/(?:(imagine|stare|sterge)\/)?)?$/.exec(path);
    if (!m) throw new HttpError(404, 'Pagina nu există');
    const [, id, action] = m;
    try {
      if (req.method === 'POST') {
        if (!id || !['stare', 'sterge'].includes(action)) throw new HttpError(405, 'Metodă nepermisă');
        if (!can(user, 'content.write')) throw new HttpError(403, 'Lipsește dreptul content.write');
        const b = await readBody(req);
        return send(res, 200, action === 'stare' ? await tests.setStatus(id, b.status) : await tests.remove(id), undefined, headers);
      }
      if (!id) return send(res, 200, testsList(ctx, tests.available() ? await tests.list() : [], {available: tests.available()}), 'text/html; charset=utf-8', headers);
      if (action === 'imagine') {
        const img = await tests.image(id);
        if (!img) throw new HttpError(404, 'Fără fotografie');
        return send(res, 200, img.data, img.type, {...headers, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff'});
      }
      if (action) throw new HttpError(405, 'Metodă nepermisă');
      const t = await tests.get(id);
      if (!t) throw new HttpError(404, 'Testul nu există');
      return send(res, 200, testView(ctx, t), 'text/html; charset=utf-8', headers);
    } catch (e) {
      if (e instanceof TestError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = decodeURIComponent(url.pathname);
    try {
      // Scrierile venite din alt site sunt refuzate (verificarea Origin).
      if (req.method !== 'GET' && req.method !== 'HEAD' && (path.startsWith('/api/manage/') || path.startsWith('/manage/'))
        && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Origine nepermisă');

      if (path.startsWith('/api/teste') && await testsPublicRoute(tests, req, res, path)) return;

      if (path.startsWith('/api/manage/auth/') && req.method === 'POST') {
        const handled = await authRoute(req, res, path);
        if (handled !== null) return handled;
      }

      if (path.startsWith('/api/manage/')) {
        const headers = {'cache-control': 'no-store'};
        if (path === '/api/manage/cron/tick' && req.method === 'POST') {
          const key = Buffer.from(String(req.headers['x-cron-key'] ?? ''));
          if (!cronKey || key.length !== Buffer.byteLength(cronKey) || !timingSafeEqual(key, Buffer.from(cronKey))) throw new HttpError(401, 'Cheie de cron invalidă');
          return send(res, 200, sync.tick(), undefined, headers);
        }
        const user = auth.userFromRequest(req);
        if (!user) throw new HttpError(401, 'Autentificare necesară');
        const body = req.method === 'GET' ? {} : await readBody(req);
        return send(res, 200, api(req.method, path.slice('/api/manage'.length), user, body, url.searchParams), undefined, headers);
      }

      // Resursele site-ului public (CSS, JS, fonturi). Cu ?v= din conținut, se pot ține în cache un an.
      if (path.startsWith('/assets/')) {
        const rel = normalize(path.slice('/assets/'.length));
        const data = rel.startsWith('..') ? null : await readFile(join(SITE_ASSETS, rel)).catch(() => null);
        if (!data) throw new HttpError(404, 'Nu există');
        const cache = url.searchParams.has('v') || rel.startsWith('fonts') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
        return send(res, 200, data, MIME[extname(rel)] ?? 'application/octet-stream', {'cache-control': cache});
      }

      if (path.startsWith('/manage/assets/')) {
        const rel = normalize(path.slice('/manage/assets/'.length));
        const data = rel.startsWith('..') ? null : await readFile(join(ASSETS, rel)).catch(() => null);
        if (!data) throw new HttpError(404, 'Nu există');
        return send(res, 200, data, MIME[extname(rel)] ?? 'application/octet-stream', {'cache-control': 'no-cache'});
      }

      if (path === '/manage' || path.startsWith('/manage/')) {
        const headers = {'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin'};
        if (path === '/manage') return send(res, 301, '', 'text/plain', {location: '/manage/'});
        if (!path.endsWith('/')) return send(res, 301, '', 'text/plain', {location: `${path}/${url.search}`});
        if (path === '/manage/login/' && process.env.MANAGE_OPEN === '1') return send(res, 302, '', 'text/plain', {location: '/manage/'});
        if (path === '/manage/login/') {
          return send(res, 200, loginPage({setup: !auth.hasUsers() && isLocal(req), next: url.searchParams.get('next')}), 'text/html; charset=utf-8', headers);
        }
        const user = auth.userFromRequest(req);
        if (!user) return send(res, 302, '', 'text/plain', {location: `/manage/login/?next=${encodeURIComponent(path + url.search)}`});
        if (path.startsWith('/manage/previzualizare/')) {
          const target = path.slice('/manage/previzualizare'.length) || '/';
          const out = renderPath(createContext(store, {preview: true}), store, target);
          return send(res, out.status, out.html, 'text/html; charset=utf-8', headers);
        }
        if (path.startsWith('/manage/teste/')) return await testsManage(req, res, path, user, headers);
        return send(res, 200, renderManage(env, path, user), 'text/html; charset=utf-8', headers);
      }

      // Formularul de contact: mesajul devine un lead în Brain (/manage/leads/). Site-ul îl trimite ca JSON; fără JavaScript,
      // browserul îl trimite ca formular și e întors pe pagina de contact. Câmpul ascuns „website” îl completează doar roboții.
      if (path === '/api/public/contact' && req.method === 'POST') {
        const b = await readBody(req);
        const done = () => (req.headers['content-type'] ?? '').includes('application/json') ? send(res, 200, {ok: true})
          : send(res, 303, '', 'text/plain', {location: '/contact/?trimis=1'});
        if (b.website) return done();
        const t = (v, max) => String(v ?? '').trim().slice(0, max);
        if (t(b.message, 5000).length < 20) throw new HttpError(400, 'Mesajul trebuie să aibă cel puțin 20 de caractere');
        store.create({...SYSTEM, name: 'Formular site'}, 'cereri', {name: t(b.name, 120), email: t(b.email, 200), phone: t(b.phone, 40),
          subject: t(b.subject, 200), message: t(b.message, 5000), source: 'Formular de contact'});
        return done();
      }

      // Înscrierea în Purapa Ambassadors (doar pe serverul local; pe site-ul static pleacă prin email): devine un mesaj în Brain.
      if (path === '/api/public/ambasador' && req.method === 'POST') {
        const b = await readBody(req);
        const list = v => (Array.isArray(v) ? v : [v]).filter(Boolean).join(', ');
        if (!b.name || !b.email || !b.phone || !b.gdpr) throw new HttpError(400, 'Completează numele, emailul, telefonul și acordul');
        const message = [`Oraș: ${b.city ?? ''}`, `Profil: ${b.profile ?? ''}`, `Unde ar recomanda: ${list(b.channels) || '—'}`,
          `Profil online: ${b.link || '—'}`, '', b.motivation || '(fără mesaj)'].join('\n');
        store.create({...SYSTEM, name: 'Formular ambasadori'}, 'cereri', {name: b.name, email: b.email, phone: b.phone,
          subject: 'Înscriere Purapa Ambassadors', message, source: 'Formular ambasadori'});
        if ((req.headers['content-type'] ?? '').includes('application/json')) return send(res, 200, {ok: true});
        return send(res, 303, '', 'text/plain', {location: '/devino-ambasador/?trimis=1#inscriere'});
      }

      if (path.startsWith('/media/')) {
        const rel = normalize(path.slice('/media/'.length));
        if (rel.startsWith('..')) throw new HttpError(404, 'Nu există');
        const data = await readFile(join(mediaDir, rel)).catch(() => null);
        if (!data) throw new HttpError(404, 'Nu există');
        return send(res, 200, data, MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream', {'cache-control': 'public, max-age=31536000, immutable'});
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodă nepermisă');

      if (path === '/robots.txt') return send(res, 200, robotsTxt(), 'text/plain; charset=utf-8', {'cache-control': 'public, max-age=300'});
      if (path === '/sitemap.xml' && indexable()) {
        const site = (process.env.SITE_URL ?? 'https://purapa.ro').replace(/\/$/, '');
        return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
          publicPaths(store).map(p => `  <url><loc>${site}${p}</loc></url>`).join('\n')}\n</urlset>\n`, 'application/xml; charset=utf-8', {'cache-control': 'public, max-age=300'});
      }

      const redirect = db.prepare('SELECT to_path, code FROM redirects WHERE from_path = ?').get(path);
      if (redirect?.to_path) return send(res, redirect.code, '', 'text/plain', {location: redirect.to_path + url.search});
      // Bara de la final, ca pe site-ul vechi; adresele vechi WordPress dau 404 (§3.8).
      if (!path.endsWith('/') && !extname(path)) return send(res, 301, '', 'text/plain', {location: `${path}/${url.search}`});

      const out = sync.get(path);
      return send(res, out.status, out.html, 'text/html; charset=utf-8');
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(e);
      if (path.startsWith('/api/')) return send(res, status, {error: e.message, errors: e.errors, usedBy: e.usedBy, current: e.current});
      return send(res, status, `<!doctype html><meta charset="utf-8"><title>${status}</title><link rel="stylesheet" href="/manage/assets/manage.css">
<main class="login"><h1>${status}</h1><p>${String(e.message).replace(/</g, '&lt;')}</p><p><a href="/manage/">Înapoi la panou</a></p></main>`, 'text/html; charset=utf-8');
    }
  }

  return {...env, handle};
}
