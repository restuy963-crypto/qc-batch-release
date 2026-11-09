// QC BATCH RELEASE — logika inti (deterministik, tanpa AI).
// Keputusan RELEASE/HOLD/HOLD TOTAL hanya dihitung di sini.

export const STATUS = Object.freeze({
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  NOT_READABLE: 'NOT READABLE',
  NOT_VISIBLE: 'NOT VISIBLE',
  NOT_APPLICABLE: 'NOT APPLICABLE',
});

export const DECISION = Object.freeze({
  RELEASE: 'RELEASE',
  HOLD: 'HOLD',
  HOLD_TOTAL: 'HOLD TOTAL',
});

// Batch Filling harus string tepat 8 digit angka. Jangan pernah dikonversi ke number.
export function validateBatch(value) {
  if (value === null || value === undefined || value === '') {
    return { valid: false, status: STATUS.NOT_READABLE, reason: 'Batch Filling tidak terbaca' };
  }
  if (typeof value !== 'string') {
    return { valid: false, status: STATUS.NOT_READABLE, reason: 'Batch Filling harus disimpan sebagai teks' };
  }
  if (!/^\d{8}$/.test(value)) {
    return { valid: false, status: STATUS.NOT_READABLE, reason: `Format "${value}" bukan 8 digit angka` };
  }
  return { valid: true, status: STATUS.MATCH, reason: 'Format 8 digit valid' };
}

// Bandingkan karakter demi karakter kiri→kanan.
// Karakter selain 0-9 pada nilai aktual (mis. "?") = posisi tidak terbaca.
export function compareBatch(reference, actual) {
  const ref = validateBatch(reference);
  if (!ref.valid) throw new Error('DATA ACUAN Batch Filling tidak valid: ' + ref.reason);

  if (actual === null || actual === undefined || actual === '') {
    return { status: STATUS.NOT_VISIBLE, positions: [], reason: 'Batch Filling tidak ditemukan pada foto' };
  }
  const act = String(actual);
  const positions = [];
  for (let i = 0; i < 8; i++) {
    const r = reference[i];
    const a = act[i];
    let s;
    if (a === undefined || !/\d/.test(a)) s = STATUS.NOT_READABLE;
    else s = a === r ? STATUS.MATCH : STATUS.MISMATCH;
    positions.push({ pos: i + 1, ref: r, act: a ?? '', status: s });
  }
  const lengthOk = act.length === 8;
  const anyMismatch = positions.some(p => p.status === STATUS.MISMATCH);
  const anyUnreadable = positions.some(p => p.status === STATUS.NOT_READABLE) || !lengthOk;

  let status, reason;
  if (anyMismatch && lengthOk) {
    // Mismatch hanya dianggap terbukti bila digit berbeda benar-benar terbaca.
    const bad = positions.filter(p => p.status === STATUS.MISMATCH).map(p => `posisi ${p.pos} (${p.ref}→${p.act})`);
    status = STATUS.MISMATCH;
    reason = 'Batch Filling berbeda pada ' + bad.join(', ');
  } else if (anyUnreadable) {
    status = STATUS.NOT_READABLE;
    reason = lengthOk ? 'Sebagian digit tidak terbaca' : `Panjang terbaca ${act.length} digit, bukan 8`;
  } else {
    status = STATUS.MATCH;
    reason = 'Semua 8 digit sesuai';
  }
  return { status, positions, reason };
}

// Double check: dua pembacaan independen harus identik; bila tidak → NOT READABLE.
export function reconcileReadings(first, second) {
  if (first === second) return { value: first, consistent: true, note: 'Pembacaan awal dan ulang konsisten' };
  return { value: null, consistent: false, note: `Pembacaan berbeda: "${first ?? '-'}" vs "${second ?? '-'}"` };
}

// Hitung keputusan akhir.
// elements: [{ name, status, required: bool, critical: bool, note }]
// meta: { referenceLocked, photosTotal, photosFailed, analysisComplete }
export function decide(elements, meta) {
  const reasons = [];
  const critical = [];

  if (!meta.referenceLocked) reasons.push('DATA ACUAN belum terkunci');
  if (!meta.photosTotal) reasons.push('Belum ada foto aktual');
  if (meta.photosFailed > 0) reasons.push(`${meta.photosFailed} foto gagal dianalisis`);
  if (!meta.analysisComplete) reasons.push('Analisis belum lengkap');

  for (const e of elements) {
    if (e.status === STATUS.MISMATCH && e.critical) critical.push(`${e.name}: MISMATCH${e.note ? ' — ' + e.note : ''}`);
  }
  if (critical.length) {
    return { decision: DECISION.HOLD_TOTAL, reasons: [...critical, ...reasons], criticalCount: critical.length };
  }

  for (const e of elements) {
    if (!e.required) continue;
    if (e.status === STATUS.NOT_READABLE || e.status === STATUS.NOT_VISIBLE) {
      reasons.push(`${e.name}: ${e.status}`);
    } else if (e.status === STATUS.MISMATCH) {
      reasons.push(`${e.name}: MISMATCH (perlu tinjau)`);
    } else if (![STATUS.MATCH, STATUS.NOT_APPLICABLE].includes(e.status)) {
      reasons.push(`${e.name}: status tidak dikenal`);
    }
  }
  const hasBatch = elements.some(e => e.name === 'Batch Filling' && e.status === STATUS.MATCH);
  if (!hasBatch) reasons.push('Batch Filling belum terverifikasi MATCH');

  if (reasons.length) return { decision: DECISION.HOLD, reasons: [...new Set(reasons)], criticalCount: 0 };
  return { decision: DECISION.RELEASE, reasons: ['Semua elemen wajib terbaca, terverifikasi, dan sesuai'], criticalCount: 0 };
}

// ---------- Agregasi Batch Filling dari banyak foto ----------
// perPhoto: [{ no, status, value }]  (status hasil compareBatch atau NOT_VISIBLE)
export function aggregateBatch(perPhoto) {
  const relevant = perPhoto.filter(p => p.status !== STATUS.NOT_APPLICABLE);
  if (relevant.some(p => p.status === STATUS.MISMATCH)) return STATUS.MISMATCH;
  if (relevant.some(p => p.status === STATUS.NOT_READABLE)) return STATUS.NOT_READABLE;
  if (relevant.some(p => p.status === STATUS.MATCH)) return STATUS.MATCH;
  return STATUS.NOT_VISIBLE;
}

// ---------- Bantuan OCR (hanya usulan, wajib dikonfirmasi petugas) ----------
// Cari semua urutan tepat 8 digit. TIDAK mengganti huruf O→0 dsb (zero assumption).
export function findBatchCandidates(text) {
  const out = [];
  const re = /(?<![\dA-Za-z])\d{8}(?![\dA-Za-z])/g;
  let m;
  while ((m = re.exec(text || ''))) out.push(m[0]);
  return out;
}

export function normalizeForMatch(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Apakah nilai acuan muncul di teks OCR? Hanya petunjuk, bukan keputusan.
export function textContains(haystack, needle) {
  const n = normalizeForMatch(needle);
  if (n.length < 2) return false;
  return normalizeForMatch(haystack).includes(n);
}

// Parsing teks OCR tabel DATA ACUAN. Hanya mengisi field yang polanya jelas.
export function parseReferenceText(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const cands = findBatchCandidates(flat);
  const result = { batch: '', blending: '', varian: '', apiJaso: '', volume: '', kemasan: '', catatan: '', ambiguous: [], candidates: cands };

  const hasFilling = /filling/i.test(flat);
  const hasBlending = /blending/i.test(flat);
  const uniq = [...new Set(cands)];
  if (uniq.length === 1) {
    result.batch = uniq[0];
  } else if (uniq.length === 2 && hasFilling && hasBlending && flat.search(/filling/i) < flat.search(/blending/i)) {
    // Urutan kolom: Batch Filling lalu Batch Blending.
    result.batch = cands[0];
    result.blending = cands.find(c => c !== cands[0]) || '';
  } else if (uniq.length > 1) {
    result.ambiguous.push(`Ditemukan ${uniq.length} kandidat 8 digit (${uniq.join(', ')}); pilih Batch Filling secara manual`);
  } else {
    result.ambiguous.push('Batch Filling 8 digit tidak ditemukan oleh OCR');
  }

  const grade = flat.match(/\b\d{1,2}W-?\d{2}\b/i);
  if (grade) result.varian = grade[0].toUpperCase();

  const api = flat.match(/\b(?:API\s*)?(S[A-Z]|C[A-Z])\s*\/?\s*(?=JASO|,|\s|$)/);
  const jaso = flat.match(/JASO\s*(M[AB]\d?)/i);
  const parts = [];
  if (api && jaso) parts.push('API ' + api[1]);
  if (jaso) parts.push('JASO ' + jaso[1].toUpperCase());
  result.apiJaso = parts.join(', ');

  const pack = flat.match(/\b(\d+)\s*[xX]\s*(\d+(?:[.,]\d+)?)\s*(L|ML)\b/i);
  if (pack) {
    result.kemasan = `${pack[1]} x ${pack[2]} ${pack[3].toUpperCase()}`;
    result.volume = `${pack[2]} ${pack[3].toUpperCase()}`;
  }
  const kimap = flat.match(/\bA\d{9}\b/);
  const date = flat.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  const notes = [];
  if (kimap) notes.push('Kode material: ' + kimap[0]);
  if (date) notes.push('Tanggal tabel: ' + date[0]);
  result.catatan = notes.join('; ');
  return result;
}
