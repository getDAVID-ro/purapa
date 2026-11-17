// Versiunea Markdown a paginilor (pagina.md lângă pagina.html), pentru asistenții AI care citesc site-ul (GEO).
// Pornește de la HTML-ul randat, ca textul să fie exact cel din pagină: doar conținutul principal (<main>), fără meniu,
// subsol, scripturi, butoane, formulare, ilustrații sau texte ascunse. Titlul și descrierea din antet sunt cele din <head>.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SKIP = new Set(['script', 'style', 'svg', 'canvas', 'button', 'form', 'template', 'noscript', 'select', 'textarea', 'input', 'label', 'video', 'iframe', 'audio']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'figure', 'figcaption', 'ul', 'ol', 'li', 'table', 'details', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dl', 'dt', 'dd', 'nav', 'fieldset', 'legend', 'hr', 'pre']);

const ENT = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»'};
export const decode = s => String(s).replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);

function parse(html) {
  const root = {tag: '#root', attrs: {}, children: []}, stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  for (const m of html.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[5] != null) { top.children.push(m[5]); continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.findLastIndex(n => n.tag === tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs = {};
    for (const a of (m[3] ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node = {tag, attrs, children: []};
    top.children.push(node);
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  return root;
}

const hiddenNode = n => SKIP.has(n.tag) || 'hidden' in n.attrs || n.attrs['aria-hidden'] === 'true'
  || /(^|\s)(sr-only|skip|crumbs|fx-progress|preview-bar|tut-over|tut-chapters|post-aside|cat-nav)(\s|$)/.test(n.attrs.class ?? '');

export function htmlToMarkdown(html, base) {
  const abs = href => { try { return new URL(href, base).href; } catch { return href; } };
  // Elementele lipite în HTML („<strong>11.000 L</strong><span>capacitate</span>”) apar separat în pagină; aici primesc un spațiu.
  const joinInline = nodes => {
    let out = '', prevEl = false;
    for (const c of nodes) {
      const t = inline(c);
      if (!t) continue;
      const el = typeof c !== 'string';
      if (el && prevEl && out && !/s$/.test(out) && !/^s/.test(t)) out += ' ';
      out += t;
      prevEl = el;
    }
    return out;
  };
  const inline = n => {
    if (typeof n === 'string') return decode(n).replace(/\s+/g, ' ');
    if (hiddenNode(n)) return '';
    const inner = () => joinInline(n.children);
    switch (n.tag) {
      case 'br': return '\n';
      case 'strong': case 'b': { const t = inner().trim(); return t ? `**${t}**` : ''; }
      case 'em': case 'i': { const t = inner().trim(); return t ? `*${t}*` : ''; }
      case 'del': case 's': { const t = inner().trim(); return t ? `~~${t}~~` : ''; }
      case 'code': return `\`${inner()}\``;
      case 'img': return n.attrs.alt != null && n.attrs.src ? `![${n.attrs.alt}](${abs(n.attrs.src)})` : '';
      case 'a': {
        const t = inner().replace(/\s+/g, ' ').trim(), href = n.attrs.href;
        if (!t) return '';
        return href && !href.startsWith('#') ? `[${t}](${href.startsWith('mailto:') || href.startsWith('tel:') ? href : abs(href)})` : t;
      }
      default: return BLOCK.has(n.tag) ? ` ${block(n).join(' ')} ` : inner();
    }
  };
  const text = n => joinInline(n.children).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  // Un bloc întoarce o listă de paragrafe Markdown.
  const block = n => {
    if (typeof n === 'string') { const t = decode(n).replace(/\s+/g, ' ').trim(); return t ? [t] : []; }
    if (hiddenNode(n)) return [];
    const h = /^h([1-6])$/.exec(n.tag);
    if (h) { const t = text(n); return t ? [`${'#'.repeat(Number(h[1]))} ${t.replace(/\n/g, ' ')}`] : []; }
    switch (n.tag) {
      case 'p': case 'figcaption': case 'dt': case 'dd': case 'legend': { const t = text(n); return t ? [t] : []; }
      case 'hr': return ['---'];
      case 'summary': { const t = text(n); return t ? [`### ${t.replace(/\n/g, ' ')}`] : []; }
      case 'blockquote': return children(n).map(p => p.split('\n').map(l => `> ${l}`).join('\n'));
      case 'ul': case 'ol': {
        const items = n.children.filter(c => typeof c !== 'string' && c.tag === 'li' && !hiddenNode(c));
        const lines = items.map((li, i) => {
          // Eticheta de la începutul unui rând („<span>Telefon</span><a>…</a>”) devine „**Telefon:** …”.
          const first = li.children.find(c => typeof c !== 'string' || c.trim());
          if (first && typeof first !== 'string' && first.tag === 'span' && !first.attrs.class && li.children.some(c => c !== first && (typeof c !== 'string' || c.trim()))) {
            const label = text(first).replace(/:$/, '');
            li = {...li, children: li.children.map(c => c === first ? {tag: 'strong', attrs: {}, children: [`${label}:`]} : c)};
            li.children.splice(li.children.indexOf(li.children.find(c => c.tag === 'strong')) + 1, 0, ' ');
          }
          const parts = children(li);
          const lead = n.tag === 'ol' ? `${i + 1}. ` : '- ';
          return parts.length ? lead + parts.join('\n').replace(/\n/g, '\n   ') : '';
        }).filter(Boolean);
        return lines.length ? [lines.join('\n')] : [];
      }
      case 'table': {
        const rows = [];
        const walk = x => { for (const c of x.children) if (typeof c !== 'string') c.tag === 'tr' ? rows.push(c) : walk(c); };
        walk(n);
        const cells = rows.map(r => r.children.filter(c => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')).map(c => text(c).replace(/\n/g, ' ').replace(/\|/g, '\\|')));
        if (!cells.length) return [];
        const w = Math.max(...cells.map(r => r.length));
        const line = r => `| ${Array.from({length: w}, (_, i) => r[i] ?? '').join(' | ')} |`;
        return [[line(cells[0]), `| ${Array(w).fill('---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n')];
      }
      default: return children(n);
    }
  };
  // Copiii unui bloc: textul și elementele inline consecutive formează un paragraf; blocurile își păstrează paragrafele.
  const children = n => {
    const out = [];
    let run = [];
    const flush = () => {
      const t = joinInline(run).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
      if (t) out.push(t);
      run = [];
    };
    for (const c of n.children) {
      if (typeof c !== 'string' && BLOCK.has(c.tag)) { flush(); out.push(...block(c)); } else run.push(c);
    }
    flush();
    return out;
  };
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
  return children(parse(main)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// Titlul și descrierea din <head>, exact ca în pagină.
export function headMeta(html) {
  const title = decode(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '').trim();
  const description = decode(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '').trim();
  return {title, description};
}

const yaml = s => JSON.stringify(String(s ?? ''));
export function pageMarkdown(html, {url, updated}) {
  const {title, description} = headMeta(html);
  return `---\ntitle: ${yaml(title)}\ndescription: ${yaml(description)}\nurl: ${url}\nlang: ro\nupdated: ${updated}\n---\n\n${htmlToMarkdown(html, url)}`;
}
