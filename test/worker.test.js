import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

const env = { APP_PASSCODE: 'rahasia123', ANTHROPIC_API_KEY: 'sk-test', MODEL: 'claude-sonnet-5-5', ALLOWED_ORIGINS: 'https://restuy963-crypto.github.io', PRICE_IN_PER_MTOK: '2', PRICE_OUT_PER_MTOK: '10' };
const req = (path, { method = 'POST', key = 'rahasia123', body, origin = 'https://restuy963-crypto.github.io' } = {}) =>
  new Request('https://api.example' + path, { method, headers: { 'content-type': 'application/json', 'x-app-key': key, origin }, body: body ? JSON.stringify(body) : undefined });
const img = { image: 'AAAA', mediaType: 'image/jpeg' };
let calls = [];
function mockAnthropic(responses) {
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); const r = responses.shift(); return new Response(JSON.stringify(r.body), { status: r.status || 200 }); };
}
const toolResp = (name, input) => ({ body: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name, input }], usage: { input_tokens: 3000, output_tokens: 500 } } });

test('Kode akses salah → 401, tanpa memanggil AI', async () => {
  mockAnthropic([]);
  const r = await worker.fetch(req('/api/photo', { key: 'salah', body: img }), env);
  assert.equal(r.status, 401); assert.equal(calls.length, 0);
});
test('Secret belum diisi → 503', async () => {
  const r = await worker.fetch(req('/api/health', { method: 'GET' }), { ...env, ANTHROPIC_API_KEY: '' });
  assert.equal(r.status, 503);
});
test('CORS hanya untuk origin yang diizinkan', async () => {
  const ok = await worker.fetch(req('/api/health', { method: 'GET' }), env);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://restuy963-crypto.github.io');
  const bad = await worker.fetch(req('/api/health', { method: 'GET', origin: 'https://evil.example' }), env);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
test('Baca foto: API key hanya di header ke Anthropic, batch acuan tidak dikirim ke AI, biaya dihitung', async () => {
  mockAnthropic([toolResp('laporkan_foto_qc', { kategori: 'Emboss', batch_kemunculan: [{ teks: '09173261' }] })]);
  const r = await worker.fetch(req('/api/photo', { body: { ...img, pass: 2, ref: { produk: 'ENDURO MATIC G', batch: '09173261' } } }), env);
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.pass, 2);
  assert.equal(j.data.batch_kemunculan[0].teks, '09173261');
  assert.equal(calls[0].headers['x-api-key'], 'sk-test');
  const sent = JSON.stringify(calls[0].body);
  assert.ok(!sent.includes('09173261'), 'nomor batch acuan tidak boleh dikirim ke AI');
  assert.ok(sent.includes('ENDURO MATIC G'));
  assert.equal(calls[0].body.tool_choice.name, 'laporkan_foto_qc');
  assert.equal(j.usage.cost_usd, 0.011); // 3000*2/1e6 + 500*10/1e6
  assert.ok(!JSON.stringify(j).includes('sk-test'));
});
test('tool_choice ditolak → ulang dengan auto', async () => {
  mockAnthropic([{ status: 400, body: { error: { message: 'tool_choice forced is not compatible with thinking' } } }, toolResp('laporkan_data_acuan', { produk: 'X', batch_filling: '09173261', tidak_terbaca: [], ambigu: [], jumlah_baris_data: 1 })]);
  const r = await worker.fetch(req('/api/reference', { body: img }), env);
  assert.equal(r.status, 200); assert.equal(calls.length, 2); assert.equal(calls[1].body.tool_choice.type, 'auto');
});
test('AI error → error eksplisit, tanpa hasil palsu', async () => {
  mockAnthropic([{ status: 529, body: { error: { message: 'Overloaded' } } }]);
  const r = await worker.fetch(req('/api/photo', { body: img }), env);
  const j = await r.json();
  assert.equal(r.status, 502); assert.equal(j.ok, false); assert.match(j.error, /Overloaded/); assert.equal(j.data, undefined);
});
test('Format gambar tidak didukung ditolak', async () => {
  const r = await worker.fetch(req('/api/photo', { body: { image: 'AAAA', mediaType: 'image/heic' } }), env);
  assert.equal(r.status, 400);
});
