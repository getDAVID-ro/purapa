import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {validateSubmission, validateResult, imageType, testsPublicRoute, TestError} from '../src/core/watertests.mjs';
import {interpret} from '../src/manage/views/tests.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const ok = {name: 'Ana Pop', email: 'Ana@Exemplu.ro', phone: '0722 000 000', location: 'Cluj', gdpr: true, consentContact: false,
  image: `data:image/jpeg;base64,${JPEG.toString('base64')}`};

test('teste apă: trimiterea validă își păstrează datele și fotografia', () => {
  const r = validateSubmission(ok);
  assert.equal(r.lead.email, 'ana@exemplu.ro');
  assert.equal(r.type, 'image/jpeg');
  assert.deepEqual(r.image, JPEG);
  assert.equal(r.lead.consentContact, false);
});

test('teste apă: refuză fără acord, email greșit, fișier care nu e imagine, câmpul capcană', () => {
  const fails = (b, status) => assert.throws(() => validateSubmission(b), e => e instanceof TestError && e.status === status);
  fails({...ok, gdpr: false}, 400);
  fails({...ok, email: 'nu-e-email'}, 400);
  fails({...ok, name: ' '}, 400);
  fails({...ok, image: Buffer.from('<script>alert(1)</script>').toString('base64')}, 400);
  fails({...ok, website: 'http://spam'}, 400);
  fails({...ok, image: 'A'.repeat(5 * 1024 * 1024)}, 413);
  assert.equal(imageType(Buffer.from('GIF89a')), null);
});

test('teste apă: rezultatul are o stare cunoscută și o limită de mărime', () => {
  assert.equal(validateResult({outcome: 'altceva'}).outcome, 'eroare');
  assert.equal(validateResult({outcome: 'analizat', result: {parameters: []}}).result, '{"parameters":[]}');
  assert.throws(() => validateResult({outcome: 'analizat', result: {x: 'a'.repeat(300000)}}), e => e.status === 413);
});

test('teste apă: panoul interpretează valorile cu pragurile de pe site', () => {
  const [n] = interpret({parameters: [{name: 'Nitrați (Nitrate)', estimated_value: '25', unit: 'mg/L'}]});
  assert.equal(n.name, 'Nitrați');
  assert.equal(n.color, 'orange');
  assert.deepEqual(interpret(null), []);
});

test('teste apă: ruta publică refuză alte site-uri și întoarce id-ul și cheia', async () => {
  const calls = [];
  const fake = {available: () => true, submit: async (b, meta) => (calls.push([b.name, meta.ip]), {id: 7, token: 't'}), saveResult: async () => ({ok: true})};
  const call = async (path, headers, body) => {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), {method: 'POST', headers: {host: 'purapa.ro', 'content-type': 'application/json', ...headers}, socket: {}});
    let status, out;
    const res = {writeHead: s => { status = s; }, end: b => { out = JSON.parse(b); }};
    assert.equal(await testsPublicRoute(fake, req, res, path), true);
    return {status, out};
  };
  assert.equal((await call('/api/teste', {origin: 'https://rau.example'}, ok)).status, 403);
  const r = await call('/api/teste', {origin: 'https://purapa.ro', 'x-forwarded-for': '1.2.3.4, 10.0.0.1'}, ok);
  assert.deepEqual(r, {status: 200, out: {id: 7, token: 't'}});
  assert.deepEqual(calls, [['Ana Pop', '1.2.3.4']]);
  assert.equal((await call('/api/teste/7', {}, {token: 't', outcome: 'analizat'})).status, 200);
  assert.equal(await testsPublicRoute(fake, {}, {}, '/api/altceva'), false);
});
