// Testele de apă primite prin formularul /test-rapid/ (src/core/watertests.mjs): lista și fișa fiecărui test,
// cu fotografia benzii, datele de contact, acordurile și rezultatul analizei, interpretat cu aceleași praguri ca pe site.
import {esc, fmtDate, page, empty} from './ui.mjs';
import {TEST_PARAMS} from '../../site/testrapid.mjs';
import {STATUSES, OUTCOMES} from '../../core/watertests.mjs';

const BASE = '/manage/teste/';
const STATUS_CLS = {nou: 'warn', contactat: 'ok', inchis: 'muted'};
const OUTCOME_CLS = {analizat: 'ok', calitate: 'warn', asteptare: 'warn', eroare: 'bad'};
const statusBadge = s => `<span class="badge ${STATUS_CLS[s] ?? 'muted'}">${esc(STATUSES[s] ?? s)}</span>`;
const outcomeBadge = o => o ? `<span class="badge ${OUTCOME_CLS[o] ?? 'muted'}">${esc(OUTCOMES[o] ?? o)}</span>` : '<span class="badge muted">Fără rezultat</span>';
const tel = p => String(p ?? '').replace(/[^\d+]/g, '');

// Aceeași interpretare ca în site.js: pragul parametrului după valoarea estimată, altfel eticheta primită.
const details = name => TEST_PARAMS.find(p => p.name === name) ?? TEST_PARAMS.find(p => p.name.startsWith(name) || p.name.includes(`(${name})`));
export function interpret(result) {
  return (Array.isArray(result?.parameters) ? result.parameters : []).map(p => {
    const d = details(p.name), raw = p.estimated_value ?? p.value ?? '';
    const v = parseFloat(String(raw).replace(',', '.').replace('~', '').trim());
    const tier = d && !isNaN(v) ? d.tiers.find(t => t.max == null || v <= t.max) ?? d.tiers.at(-1) : null;
    return {name: (d?.name ?? p.name ?? '').replace(/\s*\((?!.*\().*\)$/, ''), unit: p.unit ?? d?.units?.replace(/\s*\(.*\)$/, '') ?? '',
      value: raw, status: tier?.label ?? p.status ?? '', color: tier?.color ?? p.statusColor ?? 'muted', text: tier?.text ?? p.interpretation ?? ''};
  });
}
const COLOR_CLS = {green: 'ok', orange: 'warn', red: 'bad'};

export function testsList(ctx, rows, {available = true} = {}) {
  const body = `<div class="head"><h1>Teste apă <span class="muted">${rows.length}</span></h1></div>
<p class="muted">Contactele și fotografiile trimise prin formularul <a href="/test-rapid/" target="_blank" rel="noopener">Trimite testul rapid</a>, cu rezultatul analizei. Cele mai noi primele.</p>
${available ? '' : '<div class="flash warn">Baza Neon nu e configurată aici (lipsește DATABASE_URL), deci testele nu se pot citi. Rulează: npx vercel env pull .env.local</div>'}
<section class="panel">
<input class="filter" type="search" placeholder="Caută după nume, email, localitate…" data-filter="#rows">
<table class="table" id="rows"><thead><tr><th>Primit</th><th>Nume</th><th>Contact</th><th>Localitate</th><th>Analiză</th><th>Stare</th></tr></thead><tbody>
${rows.map(r => `<tr${r.status === 'inchis' ? ' class="muted"' : ''}><td class="nowrap"><a href="${BASE}${r.id}/">${fmtDate(r.created_at)}</a></td>
  <td><a href="${BASE}${r.id}/"><strong>${esc(r.name)}</strong></a></td>
  <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.phone ? `<br><a href="tel:${esc(tel(r.phone))}">${esc(r.phone)}</a>` : ''}${r.consent_contact ? '' : '<br><span class="muted">fără acord de contact</span>'}</td>
  <td>${esc(r.location ?? '')}</td><td>${outcomeBadge(r.outcome)}${r.params ? ` <span class="muted">${r.params} parametri</span>` : ''}</td><td>${statusBadge(r.status)}</td></tr>`).join('')}
</tbody></table>${rows.length ? '' : empty('Nu a venit încă niciun test. Testele trimise de pe /test-rapid/ apar aici.')}</section>`;
  return page(ctx.user, {title: 'Teste apă', active: 'teste', crumbs: [['Teste apă']], body, counts: ctx.counts});
}

// Cât panoul e deschis fără parolă, testele (date personale) nu se arată.
export function testsLocked(ctx) {
  const body = `<div class="head"><h1>Teste apă</h1></div>
<div class="flash bad">Testele de apă conțin date personale (nume, email, telefon, fotografii), așa că nu se arată cât panoul e deschis oricui, fără parolă.</div>
<p>Ca să le vezi online: creează conturi în <a href="/manage/utilizatori/">Utilizatori</a>, apoi scoate variabila <code>MANAGE_OPEN</code> din proiectul Vercel (Settings → Environment Variables) și republică. Local, cu <code>npm start</code>, se văd după autentificare.</p>`;
  return page(ctx.user, {title: 'Teste apă', active: 'teste', crumbs: [['Teste apă']], body, counts: ctx.counts});
}

export function testView(ctx, t) {
  const result = typeof t.result === 'string' ? JSON.parse(t.result) : t.result;
  const params = interpret(result);
  const count = c => params.filter(p => p.color === c).length;
  const conclusion = result?.summary || result?.overall_conclusion || '';
  const reco = result?.general_recommendation || (Array.isArray(result?.recommendations) ? result.recommendations.join('\n') : '');
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : '';
  const body = `<div class="head"><h1>${esc(t.name)} ${statusBadge(t.status)}</h1>
  <div class="actions">${Object.keys(STATUSES).filter(s => s !== t.status).map(s =>
    `<button class="btn small secondary" data-action="POST ${BASE}${t.id}/stare/" data-body='${esc(JSON.stringify({status: s}))}'>Marchează: ${esc(STATUSES[s])}</button>`).join(' ')}
    <button class="btn small danger" data-action="POST ${BASE}${t.id}/sterge/" data-confirm="Ștergi definitiv testul lui ${esc(t.name)}, cu fotografia și datele de contact? Nu se poate anula." data-next="${BASE}">Șterge definitiv</button></div></div>
<div class="test-grid">
<section class="panel"><h2>Fotografia trimisă</h2>
  ${t.image_size ? `<a href="${BASE}${t.id}/imagine/" target="_blank" rel="noopener"><img class="test-photo" src="${BASE}${t.id}/imagine/" alt="Fotografia benzii de test trimisă de ${esc(t.name)}"></a>
  <p class="muted">${Math.round(t.image_size / 1024)} KB · <a href="${BASE}${t.id}/imagine/" download="test-${t.id}.${(t.image_type ?? 'image/jpeg').split('/')[1]}">Descarcă</a></p>` : empty('Fără fotografie.')}</section>
<section class="panel"><h2>Contact</h2><table class="table kv"><tbody>
  ${row('Primit', esc(fmtDate(t.created_at)))}
  ${row('Email', `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>`)}
  ${row('Telefon', t.phone ? `<a href="tel:${esc(tel(t.phone))}">${esc(t.phone)}</a>` : '')}
  ${row('Localitate', esc(t.location ?? ''))}
  ${row('Notă', esc(t.note ?? ''))}
  ${row('Acord GDPR', t.gdpr ? 'Da' : 'Nu')}
  ${row('Acord să fie contactat', t.consent_contact ? 'Da' : '<strong>Nu</strong>: nu-l contacta comercial')}
</tbody></table></section>
</div>
<section class="panel"><h2>Rezultatul analizei ${outcomeBadge(t.outcome)}</h2>
  ${t.error ? `<p class="flash bad">${esc(t.error)}</p>` : ''}
  ${params.length ? `<p>${[['green', 'în limite'], ['orange', 'de urmărit'], ['red', 'peste limite']].filter(([c]) => count(c)).map(([c, l]) => `<span class="badge ${COLOR_CLS[c]}">${count(c)} ${l}</span>`).join(' ')}</p>` : ''}
  ${conclusion ? `<p><strong>Concluzie:</strong> ${esc(conclusion)}</p>` : ''}
  ${reco ? `<p><strong>Recomandare:</strong> ${esc(reco).replace(/\n/g, '<br>')}</p>` : ''}
  ${params.length ? `<table class="table"><thead><tr><th>Parametru</th><th>Valoare</th><th>Interpretare</th></tr></thead><tbody>${params.map(p =>
    `<tr><td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.unit)}</span></td><td class="nowrap">${esc(p.value)} ${p.status ? `<span class="badge ${COLOR_CLS[p.color] ?? 'muted'}">${esc(p.status)}</span>` : ''}</td><td>${esc(p.text)}</td></tr>`).join('')}</tbody></table>`
    : empty(t.outcome ? 'Analiza nu a întors valori.' : 'Rezultatul n-a ajuns (vizitatorul a închis pagina înainte de final sau analiza a eșuat).')}
</section>`;
  return page(ctx.user, {title: `Test apă: ${t.name}`, active: 'teste', crumbs: [['Teste apă', BASE], [t.name]], body, counts: ctx.counts});
}
