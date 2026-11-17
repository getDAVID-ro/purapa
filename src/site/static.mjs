// Site-ul public ca fișiere statice, în public/: Vercel le servește direct, fără funcție și fără Blob,
// deci vizitatorii nu consumă nimic din cota de stocare. Panoul /manage rămâne pe funcție.
// Se scriu doar fișierele schimbate, ca git să vadă numai modificările reale.
import {mkdir, readFile, writeFile, rm, readdir, access} from 'node:fs/promises';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext} from './context.mjs';
import {renderPath, publicPaths, robotsTxt, siteUrl, mdPath} from './render.mjs';
import {pageMarkdown, headMeta} from './markdown.mjs';
import {byKey, publicPath} from '../registry/entities.mjs';

const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url));
const exists = p => access(p).then(() => true, () => false);

async function writeIfChanged(file, data) {
  const cur = await readFile(file).catch(() => null);
  if (cur && Buffer.compare(cur, Buffer.from(data)) === 0) return false;
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, data);
  return true;
}

// Întoarce lista fișierelor scrise sau șterse (relativ la `out`).
export async function buildStatic(store, {out = 'public', mediaDir = 'data/media'} = {}) {
  const changed = [];
  const put = async (rel, data) => { if (await writeIfChanged(join(out, rel), data)) changed.push(rel); };
  // Fără server în spate: formularul de contact devine un link de email (vezi `staticSite` în render).
  const render = path => renderPath(createContext(store, {staticSite: true}), store, path);

  const pages = publicPaths(store);
  // Data ultimei modificări și grupul fiecărei adrese (pentru sitemap.xml și llms.txt).
  const info = new Map(['pagini', 'articole'].flatMap(key => store.list(key).filter(p => p.status === 'published').map(p => [publicPath(byKey[key], p), {
    updated: String(p.published_at ?? p.updated_at ?? '').slice(0, 10), group: key === 'articole' ? 'Articole' : p.footer === 'legal' ? 'Legal' : 'Pagini'}])));
  const site = siteUrl(), listed = [];
  for (const path of pages) {
    const res = render(path);
    if (res.status !== 200) throw new Error(`${path} nu s-a randat (${res.status})`);
    await put(join(path, 'index.html'), res.html);
    // Versiunea Markdown, pentru asistenții AI (link rel="alternate" din <head>).
    const {updated = '', group = 'Pagini'} = info.get(path) ?? {};
    await put(mdPath(path).slice(1), pageMarkdown(res.html, {url: `${site}${path}`, updated}));
    listed.push({path, updated, group, ...headMeta(res.html)});
  }
  await put('404.html', render('/__pagina-inexistenta__/').html);
  await put('robots.txt', robotsTxt());
  await put('sitemap.xml', sitemapXml(site, listed));
  await put('llms.txt', llmsTxt(store, site, listed));

  // Paginile care nu mai există (șterse sau mutate) dispar și din public/; lista e ținută în public/.pages.json.
  const manifest = join(out, '.pages.json');
  const before = JSON.parse(await readFile(manifest, 'utf8').catch(() => '[]'));
  for (const path of before.filter(p => !pages.includes(p))) {
    for (const file of ['index.html', 'index.md']) { await rm(join(out, path, file), {force: true}); changed.push(join(path, file)); }
  }
  await put('.pages.json', JSON.stringify(pages, null, 2) + '\n');

  for (const f of await readdir(ASSETS_DIR, {recursive: true, withFileTypes: true})) {
    if (!f.isFile()) continue;
    const file = join(f.parentPath, f.name);
    await put(join('assets', relative(ASSETS_DIR, file)), await readFile(file));
  }

  // Doar imaginile folosite în Brain.
  const used = new Set(store.list('media').map(m => m.src).filter(src => src && !/^https?:/.test(src)));
  for (const src of used) {
    const from = join(mediaDir, src);
    if (await exists(from)) await put(join('media', src), await readFile(from));
  }
  for (const f of await readdir(join(out, 'media')).catch(() => [])) {
    if (!used.has(f)) { await rm(join(out, 'media', f), {force: true}); changed.push(join('media', f)); }
  }
  return {pages: pages.length, changed};
}

// Toate paginile publicate (au toate canonical spre ele însele), cu data ultimei publicări.
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function sitemapXml(site, listed) {
  const urls = listed.map(p => `  <url><loc>${xml(site + p.path)}</loc>${p.updated ? `<lastmod>${p.updated}</lastmod>` : ''}</url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

// llms.txt: cine e firma, apoi linkurile spre versiunile Markdown, pe grupuri.
function llmsTxt(store, site, listed) {
  const f = store.list('firma')[0] ?? {};
  const where = [f.city, f.county].filter(Boolean).join(', ');
  const about = [f.tagline, f.legal_name && `${f.brand} este o marcă ${f.legal_name} (CUI ${f.cui})${where ? `, ${where}` : ''}. Produsele se comandă prin retailerul partener; site-ul are ghiduri despre apa de acasă și testul rapid Purapa.`]
    .filter(Boolean).join(' ');
  const contact = [f.phone && `telefon ${f.phone}`, f.email && `email ${f.email}`, f.hours && `program ${f.hours}`].filter(Boolean).join(', ');
  const lines = [`# ${f.brand ?? 'Purapa'}`, '', `> ${about}`, ''];
  if (contact) lines.push(`Contact: ${contact}.`, '');
  for (const g of ['Pagini', 'Articole', 'Legal']) {
    const l = listed.filter(p => p.group === g);
    if (!l.length) continue;
    lines.push(`## ${g}`, '', ...l.map(p => `- [${p.title.replace(/ \| [^|]+$/, '')}](${site}${mdPath(p.path)})${p.description ? `: ${p.description}` : ''}`), '');
  }
  return lines.join('\n');
}
