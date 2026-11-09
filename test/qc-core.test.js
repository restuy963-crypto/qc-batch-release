import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, compareBatch, reconcileReadings, decide, STATUS, DECISION } from '../src/qc-core.js';

const meta = { referenceLocked: true, photosTotal: 2, photosFailed: 0, analysisComplete: true };
const ok = (name, req = true) => ({ name, status: STATUS.MATCH, required: req, critical: true });

test('Acuan valid 8 digit', () => assert.equal(validateBatch('09121261').valid, true));
test('Acuan bukan 8 digit ditolak', () => {
  assert.equal(validateBatch('0912126').valid, false);
  assert.equal(validateBatch('0912126A').valid, false);
  assert.equal(validateBatch(9121261).valid, false); // number → nol depan hilang
});
test('Batch sama → semua digit MATCH', () => {
  const r = compareBatch('09121261', '09121261');
  assert.equal(r.status, STATUS.MATCH);
  assert.ok(r.positions.every(p => p.status === STATUS.MATCH));
});
test('Batch beda satu digit → MISMATCH → HOLD TOTAL', () => {
  const r = compareBatch('09121261', '09121262');
  assert.equal(r.status, STATUS.MISMATCH);
  const d = decide([{ name: 'Batch Filling', status: r.status, required: true, critical: true }, ok('Produk')], meta);
  assert.equal(d.decision, DECISION.HOLD_TOTAL);
});
test('Batch blur → NOT READABLE → HOLD, tanpa tebakan', () => {
  const r = compareBatch('01234567', '01234?67');
  assert.equal(r.status, STATUS.NOT_READABLE);
  assert.equal(r.positions[5].status, STATUS.NOT_READABLE);
  const d = decide([{ name: 'Batch Filling', status: r.status, required: true, critical: true }, ok('Produk')], meta);
  assert.equal(d.decision, DECISION.HOLD);
});
test('Batch terpotong → NOT READABLE', () => assert.equal(compareBatch('09121261', '091212').status, STATUS.NOT_READABLE));
test('Nol di depan tetap dibandingkan', () => {
  assert.equal(compareBatch('01234567', '91234567').status, STATUS.MISMATCH);
  assert.equal(compareBatch('01234567', '1234567').status, STATUS.NOT_READABLE);
});
test('Double check tidak konsisten → nilai null', () => {
  assert.equal(reconcileReadings('09173261', '09178261').value, null);
  assert.equal(reconcileReadings('09173261', '09173261').value, '09173261');
});
test('Semua MATCH → RELEASE', () => {
  const d = decide([ok('Batch Filling'), ok('Produk'), ok('Volume')], meta);
  assert.equal(d.decision, DECISION.RELEASE);
});
test('Foto gagal → tidak RELEASE', () => {
  const d = decide([ok('Batch Filling'), ok('Produk')], { ...meta, photosFailed: 1 });
  assert.equal(d.decision, DECISION.HOLD);
});
test('API gagal / analisis belum lengkap → tidak RELEASE', () => {
  const d = decide([ok('Batch Filling')], { ...meta, analysisComplete: false });
  assert.equal(d.decision, DECISION.HOLD);
});
test('Elemen wajib NOT VISIBLE → HOLD; NOT APPLICABLE tidak gagal', () => {
  assert.equal(decide([ok('Batch Filling'), { name: 'Karton', status: STATUS.NOT_VISIBLE, required: true }], meta).decision, DECISION.HOLD);
  assert.equal(decide([ok('Batch Filling'), { name: 'Sticker', status: STATUS.NOT_APPLICABLE, required: true }], meta).decision, DECISION.RELEASE);
});
test('Tanpa elemen Batch Filling → tidak RELEASE', () => {
  assert.equal(decide([ok('Produk')], meta).decision, DECISION.HOLD);
});

// Uji kering dengan foto sampel pengguna (9 Nov 2026)
test('Sampel: acuan 09121261 vs aktual 09173261 → HOLD TOTAL', () => {
  const dc = reconcileReadings('09173261', '09173261'); // cetakan tutup & leher botol
  const r = compareBatch('09121261', dc.value);
  assert.equal(r.status, STATUS.MISMATCH);
  assert.deepEqual(r.positions.filter(p => p.status === STATUS.MISMATCH).map(p => p.pos), [4, 5]);
  const d = decide([
    { name: 'Batch Filling', status: r.status, required: true, critical: true, note: r.reason },
    ok('Nama produk'), ok('Varian/Grade'), ok('Volume'),
    { name: 'Karton (6 x 0,8 L)', status: STATUS.NOT_VISIBLE, required: true },
  ], meta);
  assert.equal(d.decision, DECISION.HOLD_TOTAL);
});

import { aggregateBatch, findBatchCandidates, parseReferenceText, textContains } from '../src/qc-core.js';

test('Parser acuan dari OCR tabel sampel (tesseract 5.3.4)', () => {
  const t = `# Tol Tipe Line Kimap Produk Uk. Batch Batch Tangki Density Jumlah Kon
Filling Blending ki
37. 2026-11-06 Domestik FLO2 A070207513 ENDURO 6x 09121261 09096261 THO7 0.8700 4850 859.
MATIC 0.8 Kg
G L
20W-40
SL/
JASO
MB,
6X0,8L`;
  const r = parseReferenceText(t);
  assert.equal(r.batch, '09121261');
  assert.equal(r.blending, '09096261'); // dicatat tapi tidak dipakai
  assert.equal(r.varian, '20W-40');
  assert.equal(r.apiJaso, 'API SL, JASO MB');
  assert.equal(r.volume, '0,8 L');
  assert.equal(r.kemasan, '6 x 0,8 L');
  assert.match(r.catatan, /A070207513/);
});
test('Batch Blending saja / kandidat ganda tanpa header → ambigu, tidak menebak', () => {
  const r = parseReferenceText('12345678 87654321');
  assert.equal(r.batch, '');
  assert.equal(r.ambiguous.length, 1);
});
test('Kandidat 8 digit tidak mengambil bagian angka lebih panjang', () => {
  assert.deepEqual(findBatchCandidates('A070207513 123456789 09121261 x'), ['09121261']);
});
test('Agregasi batch multi-foto', () => {
  assert.equal(aggregateBatch([{ status: 'MATCH' }, { status: 'NOT VISIBLE' }]), 'MATCH');
  assert.equal(aggregateBatch([{ status: 'MATCH' }, { status: 'NOT READABLE' }]), 'NOT READABLE');
  assert.equal(aggregateBatch([{ status: 'MATCH' }, { status: 'MISMATCH' }]), 'MISMATCH');
  assert.equal(aggregateBatch([{ status: 'NOT VISIBLE' }]), 'NOT VISIBLE');
});
test('Petunjuk teks label', () => {
  assert.equal(textContains('PERTAMINA Enduro MATIC-G 20W-40', 'ENDURO MATIC G'), true);
  assert.equal(textContains('Fastron', 'ENDURO'), false);
});
