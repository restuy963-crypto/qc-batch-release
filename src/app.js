import { STATUS, DECISION, validateBatch, compareBatch, reconcileReadings, decide, aggregateBatch,
  findBatchCandidates, parseReferenceText, textContains } from './qc-core.js';
import { db } from './db.js';
import { recognize } from './ocr.js';

const APP_VERSION = '0.1.0';
const MAX_FILE = 15 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CATEGORIES = ['', 'Emboss', 'Label', 'Karton', 'Printer', 'Lainnya'];
const ALL_STATUS = [STATUS.MATCH, STATUS.MISMATCH, STATUS.NOT_READABLE, STATUS.NOT_VISIBLE, STATUS.NOT_APPLICABLE];
const IDENTITY = [
  { key: 'nama', name: 'Nama produk / brand', ref: r => [r.fields.brand, r.fields.produk].filter(Boolean).join(' ') },
  { key: 'varian', name: 'Varian / grade', ref: r => r.fields.varian },
  { key: 'apiJaso', name: 'API / JASO', ref: r => r.fields.apiJaso },
  { key: 'volume', name: 'Volume', ref: r => r.fields.volume },
  { key: 'kemasan', name: 'Kemasan', ref: r => r.fields.kemasan },
];
const VISUAL = [
  { key: 'label', name: 'Label' }, { key: 'emboss', name: 'Emboss' }, { key: 'tutup', name: 'Tutup' },
  { key: 'printer', name: 'Printer / marking' }, { key: 'karton', name: 'Karton' },
  { key: 'sticker', name: 'Sticker' }, { key: 'qr', name: 'QR / Barcode' },
];
const REF_FIELDS = [
  { key: 'produk', label: 'Produk', required: true },
  { key: 'brand', label: 'Brand / merek' },
  { key: 'varian', label: 'Varian / grade (viskositas)' },
  { key: 'apiJaso', label: 'API / JASO' },
  { key: 'volume', label: 'Volume isi' },
  { key: 'kemasan', label: 'Kemasan' },
  { key: 'catatan', label: 'Catatan' },
];

// ---------------- state ----------------
const S = { ref: null, draft: null, session: null, busy: false, urls: [], refOcrProgress: null };
const view = document.getElementById('view');

// ---------------- helpers ----------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = s => String(s).replace(/\s+/g, '-');
const badge = s => `<span class="badge b-${cls(s)}">${esc(s)}</span>`;
const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const fmtTime = iso => { if (!iso) return '-'; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const photoNo = n => 'Foto ' + pad(n);
function url(blob) { if (!blob) return ''; const u = URL.createObjectURL(blob); S.urls.push(u); return u; }
function freeUrls() { S.urls.forEach(u => URL.revokeObjectURL(u)); S.urls = []; }
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach(k => { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k]; }); a[ks.at(-1)] = v; }
let saveTimer = null;
function saveSoon(fn) { clearTimeout(saveTimer); saveTimer = setTimeout(fn, 400); }

function toast(msg, type = '') {
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), type === 'bad' ? 6000 : 3200);
}

function modal({ title, body = '', ok = 'Ya', cancel = 'Batal', danger = false, phrase = null }) {
  return new Promise(resolve => {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div>${body}</div>
      ${phrase ? `<label class="f">Ketik persis: <b>${esc(phrase)}</b></label><input type="text" id="mPhrase" autocomplete="off">` : ''}
      <div class="row" style="margin-top:14px">${cancel ? `<button class="sec" data-r="0">${esc(cancel)}</button>` : ''}<button class="${danger ? 'danger' : ''}" data-r="1" ${phrase ? 'disabled' : ''}>${esc(ok)}</button></div></div>`;
    document.body.appendChild(m);
    const okBtn = m.querySelector('[data-r="1"]');
    if (phrase) { const inp = m.querySelector('#mPhrase'); inp.addEventListener('input', () => { okBtn.disabled = inp.value !== phrase; }); setTimeout(() => inp.focus(), 50); }
    m.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b || b.disabled) return;
      modal.values = Object.fromEntries([...m.querySelectorAll('input[id]')].map(i => [i.id, i.value]));
      m.remove(); resolve(b.dataset.r === '1'); });
  });
}

function viewer(blob, title) {
  const v = document.createElement('div'); v.className = 'viewer';
  const u = URL.createObjectURL(blob);
  let zoom = 1, enh = false;
  v.innerHTML = `<div class="vbar"><button class="sec small" data-z="-">−</button><button class="sec small" data-z="+">＋</button><button class="sec small" data-e>Kontras</button><button class="small" data-x>Tutup</button></div>
    <div style="color:#ccc;font-size:12px;padding:0 10px 6px;background:#111">${esc(title || '')}</div><div class="vimg"><img src="${u}" alt=""></div>`;
  document.body.appendChild(v);
  const img = v.querySelector('img'); const box = v.querySelector('.vimg');
  const apply = () => { img.style.width = (box.clientWidth * zoom) + 'px'; img.style.filter = enh ? 'grayscale(1) contrast(2.2)' : ''; };
  img.onload = apply;
  v.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.x !== undefined) { URL.revokeObjectURL(u); v.remove(); return; }
    if (b.dataset.z === '+') zoom = Math.min(8, zoom * 1.5);
    if (b.dataset.z === '-') zoom = Math.max(1, zoom / 1.5);
    if (b.dataset.e !== undefined) { enh = !enh; b.textContent = enh ? 'Normal' : 'Kontras'; }
    apply();
  });
}

function pickFiles(kind) {
  const el = document.getElementById(kind === 'camera' ? 'pickCamera' : kind === 'multi' ? 'pickGalleryMulti' : 'pickGallery');
  return new Promise(resolve => {
    el.value = '';
    const onChange = () => { el.removeEventListener('change', onChange); resolve([...el.files]); };
    el.addEventListener('change', onChange);
    el.click();
  });
}

// Validasi file + kompres untuk penyimpanan lokal (maks 2400 px; foto asli tidak diubah).
async function prepareImage(file) {
  const item = { name: file.name || 'kamera.jpg', size: file.size, type: file.type, status: 'Siap', blob: null };
  if (!file.size) { item.status = 'File kosong'; return item; }
  if (!OK_TYPES.includes(file.type)) { item.status = 'Format tidak didukung'; return item; }
  if (file.size > MAX_FILE) { item.status = 'Terlalu besar'; return item; }
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    item.blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.92));
    item.width = c.width; item.height = c.height;
  } catch { item.status = 'Gagal dimuat'; item.blob = null; }
  return item;
}

// ---------------- data loading ----------------
async function loadState() {
  const refId = await db.kvGet('activeRefId');
  S.ref = refId ? (await db.get('refs', refId)) || null : null;
  S.draft = (await db.kvGet('draftRef')) || null;
  const sk = await db.kvGet('currentSessionKey');
  S.session = sk ? (await db.get('sessions', sk)) || null : null;
  if (S.session && S.session.status !== 'draft') { S.session = null; await db.kvSet('currentSessionKey', null); }
}
async function saveSession() { if (S.session) { S.session.updatedAt = new Date().toISOString(); await db.put('sessions', S.session); } }
function saveDraft() { return db.kvSet('draftRef', S.draft); }

function updateHeader() {
  const net = document.getElementById('netChip');
  net.textContent = navigator.onLine ? 'Online' : 'OFFLINE';
  net.className = 'chip ' + (navigator.onLine ? 'ok' : 'bad');
  const rc = document.getElementById('refChip');
  rc.textContent = S.ref ? `ACUAN: TERKUNCI • ${S.ref.fields.batch}` : 'ACUAN: BELUM ADA';
  rc.className = 'chip ' + (S.ref ? 'ok' : 'warn');
}
addEventListener('online', updateHeader); addEventListener('offline', updateHeader);

// ---------------- router ----------------
const routes = {};
async function render() {
  freeUrls();
  const h = location.hash.slice(1) || 'beranda';
  const [name, arg] = h.split(':');
  const navKey = { proses: 'analisis', verifikasi: 'analisis', hasil: 'analisis', laporan: 'riwayat', cetak: 'riwayat' }[name] || name;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.v === navKey));
  updateHeader();
  const fn = routes[name] || routes.beranda;
  try { await fn(arg); } catch (e) { console.error(e); view.innerHTML = `<div class="msg bad">Terjadi kesalahan: ${esc(e.message)}</div>`; }
}
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
const go = h => { if (location.hash === '#' + h) render(); else location.hash = h; };

// Delegasi aksi
const actions = {};
view.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const fn = actions[b.dataset.act]; if (!fn) return;
  e.preventDefault();
  try { await fn(b); } catch (err) { console.error(err); toast('Gagal: ' + err.message, 'bad'); }
});

// ================= BERANDA =================
routes.beranda = async () => {
  const sessions = (await db.all('sessions')).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const finals = sessions.filter(s => s.status === 'final');
  const last = finals[0];
  const r = S.ref;
  view.innerHTML = `
  <h2>Dashboard QC</h2><p class="sub">Status sistem dan ringkasan pekerjaan</p>
  <div class="card"><h3>Status DATA ACUAN</h3>
    ${r ? `<div class="big">${badge('TERKUNCI')}</div><div class="kv" style="margin-top:8px">
      <span>Produk</span><b>${esc([r.fields.brand, r.fields.produk].filter(Boolean).join(' '))}</b>
      <span>Varian</span><b>${esc(r.fields.varian || '-')}</b><span>Volume</span><b>${esc(r.fields.volume || '-')}</b>
      <span>Batch Filling</span><b style="font-family:monospace;font-size:16px">${esc(r.fields.batch)}</b>
      <span>ID acuan</span><b>${esc(r.id)}</b></div>`
    : `<div class="big">${badge('BELUM ADA')}</div><p class="hint">Unggah dan kunci DATA ACUAN sebelum pemeriksaan.</p>
       <button class="full" data-act="goto" data-h="acuan" style="margin-top:8px">BUKA DATA ACUAN</button>`}
  </div>
  <div class="card"><h3>Mulai pemeriksaan</h3>
    ${S.session ? `<div class="msg info">Ada sesi berjalan: <b>${esc(S.session.id)}</b> (${S.session.photos.length} foto).</div>
      <div class="row"><button data-act="goto" data-h="${S.session.result ? 'hasil' : 'analisis'}">LANJUTKAN SESI</button><button class="sec" data-act="newSession">PEMERIKSAAN BARU</button></div>`
    : `<button class="full" data-act="newSession">PEMERIKSAAN BARU</button>`}
    ${!r ? '<p class="hint">Butuh DATA ACUAN terkunci.</p>' : ''}
  </div>
  <div class="card"><h3>Pemeriksaan terakhir</h3>
    ${last ? `<div class="srow"><b>${esc(last.id)}${last.version > 1 ? ' (rev ' + last.version + ')' : ''}</b>${badge(last.result.decision)}</div>
      <div class="hint">${fmtTime(last.finalizedAt)} • ${esc(last.refSnapshot.fields.produk)} • Batch ${esc(last.refSnapshot.fields.batch)}</div>
      <div style="margin:6px 0;font-size:14px">${esc(last.result.reasons.slice(0, 2).join('; '))}</div>
      <button class="full sec" data-act="goto" data-h="laporan:${esc(last.key)}">BUKA LAPORAN</button>`
    : `<div class="empty">Belum ada pemeriksaan</div>`}
  </div>
  <div class="card"><h3>Aktivitas terbaru</h3>
    ${finals.length ? finals.slice(0, 5).map(s => `<div class="itm srow"><div><b>${esc(s.id)}</b><div class="hint">${fmtTime(s.finalizedAt)} • ${esc(s.refSnapshot.fields.batch)}</div></div>
      <div style="text-align:right">${badge(s.result.decision)}<br><button class="small sec" data-act="goto" data-h="laporan:${esc(s.key)}" style="margin-top:4px">BUKA</button></div></div>`).join('')
    : `<div class="empty">Belum ada pemeriksaan</div>`}
  </div>`;
};
actions.goto = b => go(b.dataset.h);
actions.newSession = async () => {
  if (!S.ref) { toast('DATA ACUAN belum terkunci. Silakan kunci acuan terlebih dahulu.'); go('acuan'); return; }
  if (S.session && S.session.photos.length) {
    if (!await modal({ title: 'Mulai pemeriksaan baru?', body: `<p>Sesi <b>${esc(S.session.id)}</b> belum diselesaikan dan akan dibatalkan (dicatat di log audit).</p>`, ok: 'Batalkan sesi lama', danger: true })) return;
    await db.del('sessions', S.session.key); await db.audit('SESI_DIBATALKAN', { id: S.session.id });
  }
  S.session = null; await db.kvSet('currentSessionKey', null);
  go('analisis');
};

// ================= DATA ACUAN =================
function emptyDraft() {
  return { image: null, imageName: '', ocrText: '', ocrDone: false, fields: Object.fromEntries([...REF_FIELDS.map(f => [f.key, '']), ['batch', '']]),
    unreadable: {}, blending: '', ambiguous: [], candidates: [], confirmed: false };
}

routes.acuan = async () => {
  if (S.ref) return renderLockedRef();
  if (!S.draft) S.draft = emptyDraft();
  const d = S.draft;
  view.innerHTML = `
  <h2>DATA ACUAN</h2><p class="sub">Tinjau isi tabel sebelum dikunci. Acuan terkunci menjadi satu-satunya sumber kebenaran.</p>
  <div class="card"><h3>Upload DATA ACUAN</h3>
    <div class="row"><button data-act="refPick" data-k="gallery">PILIH GAMBAR</button><button data-act="refPick" data-k="camera">KAMERA</button></div>
    ${d.image ? `<img class="preview" src="${url(d.image)}" alt="Preview DATA ACUAN" data-act="refView" style="margin-top:10px">
      <div class="hint">${esc(d.imageName)} • ${fmtSize(d.image.size)} • ketuk untuk memperbesar</div>
      <button class="full" style="margin-top:10px" data-act="refOcr" id="btnOcr">BACA DATA ACUAN</button>
      <div id="ocrProg" class="hidden"><div class="bar"><i></i></div><div class="hint" id="ocrMsg">Menyiapkan…</div></div>`
    : `<div class="empty">Belum ada gambar. Foto tabel referensi dengan jelas dan tidak terpotong.</div>`}
  </div>
  ${d.image ? `
  <div class="card"><h3>Hasil ekstraksi</h3>
    ${d.ocrDone ? `<div class="msg info">Isian di bawah adalah <b>usulan OCR</b>. Cocokkan setiap field dengan gambar. Koreksi bila perlu. Jangan mengisi yang tidak terbaca.</div>`
      : `<div class="msg warn">Tekan <b>BACA DATA ACUAN</b> untuk pembacaan otomatis, atau isi manual sesuai gambar.</div>`}
    <label class="f">Batch Filling (tepat 8 digit) *</label>
    <input type="text" class="mono" inputmode="numeric" maxlength="8" autocomplete="off" data-ref="batch" value="${esc(d.fields.batch)}" ${d.unreadable.batch ? 'disabled' : ''}>
    <label class="check"><input type="checkbox" data-unr="batch" ${d.unreadable.batch ? 'checked' : ''}> Tidak terbaca</label>
    ${d.candidates.length > 1 && !d.blending ? `<div class="hint">Kandidat 8 digit dari OCR: ${d.candidates.map(c => `<button class="small sec" data-act="refCand" data-v="${esc(c)}">${esc(c)}</button>`).join(' ')}</div>` : ''}
    ${d.blending ? `<div class="hint">Batch Blending terdeteksi (${esc(d.blending)}) — <b>diabaikan</b>, tidak dipakai untuk pemeriksaan.</div>` : ''}
    ${REF_FIELDS.map(f => `<label class="f">${esc(f.label)}${f.required ? ' *' : ''}</label>
      ${f.key === 'catatan' ? `<textarea data-ref="catatan" ${d.unreadable.catatan ? 'disabled' : ''}>${esc(d.fields.catatan)}</textarea>`
        : `<input type="text" data-ref="${f.key}" value="${esc(d.fields[f.key])}" ${d.unreadable[f.key] ? 'disabled' : ''}>`}
      <label class="check"><input type="checkbox" data-unr="${f.key}" ${d.unreadable[f.key] ? 'checked' : ''}> ${f.key === 'catatan' ? 'Tidak ada / tidak terbaca' : 'Tidak terbaca / tidak tercantum'}</label>`).join('')}
    ${d.ocrText ? `<details><summary>Teks mentah OCR</summary><div class="ocrtext">${esc(d.ocrText)}</div></details>` : ''}
  </div>
  <div class="card"><h3>Validasi</h3><div id="refVal"></div>
    <label class="check"><input type="checkbox" id="refConfirm" ${d.confirmed ? 'checked' : ''}> Saya sudah mencocokkan setiap field dengan gambar DATA ACUAN.</label>
  </div>
  <div class="card"><h3>Tindakan</h3>
    <button class="full" id="btnLock" data-act="refLock">SIMPAN &amp; KUNCI</button>
    <button class="full sec" style="margin-top:8px" data-act="refReset">HAPUS DRAF</button>
  </div>` : ''}
  ${await archivedRefsHtml()}`;
  bindRefInputs();
  updateRefValidation();
};

function refValidation(d) {
  const v = validateBatch(d.unreadable.batch ? '' : d.fields.batch);
  const problems = [];
  if (!d.image) problems.push('Gambar DATA ACUAN belum ada');
  if (d.unreadable.batch) problems.push('Batch Filling ditandai tidak terbaca — ambil foto acuan yang lebih jelas');
  else if (!v.valid) problems.push(v.reason);
  if (!d.fields.produk.trim() || d.unreadable.produk) problems.push('Produk wajib terbaca');
  const ambig = [...d.ambiguous];
  REF_FIELDS.forEach(f => { if (d.unreadable[f.key] && f.key !== 'catatan') ambig.push(`${f.label}: tidak terbaca`); });
  return { batchStatus: d.unreadable.batch || !d.fields.batch ? 'NOT READABLE' : v.valid ? 'VALID' : 'INVALID', problems, ambig };
}
function updateRefValidation() {
  const box = document.getElementById('refVal'); if (!box) return;
  const d = S.draft; const r = refValidation(d);
  box.innerHTML = `<div class="srow"><span>Format batch 8 digit</span>${badge(r.batchStatus)}</div>
    ${r.problems.length ? `<div class="msg bad" style="margin-top:8px">${r.problems.map(esc).join('<br>')}</div>` : ''}
    <div style="margin-top:8px"><b>Data ambigu:</b> ${r.ambig.length ? `<ul style="margin:4px 0;padding-left:18px">${r.ambig.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '<span class="hint">tidak ada</span>'}</div>`;
  const btn = document.getElementById('btnLock');
  if (btn) btn.disabled = r.problems.length > 0 || !d.confirmed;
}
function bindRefInputs() {
  view.querySelectorAll('[data-ref]').forEach(el => el.addEventListener('input', () => {
    let v = el.value;
    if (el.dataset.ref === 'batch') { v = v.replace(/\s/g, ''); if (v !== el.value) el.value = v; }
    S.draft.fields[el.dataset.ref] = v; S.draft.confirmed = false;
    const c = document.getElementById('refConfirm'); if (c) c.checked = false;
    updateRefValidation(); saveSoon(saveDraft);
  }));
  view.querySelectorAll('[data-unr]').forEach(el => el.addEventListener('change', () => {
    const k = el.dataset.unr; S.draft.unreadable[k] = el.checked;
    if (el.checked) S.draft.fields[k] = '';
    S.draft.confirmed = false; saveDraft(); render();
  }));
  const c = document.getElementById('refConfirm');
  if (c) c.addEventListener('change', () => { S.draft.confirmed = c.checked; updateRefValidation(); saveDraft(); });
}
actions.refPick = async b => {
  const [f] = await pickFiles(b.dataset.k); if (!f) return;
  const it = await prepareImage(f);
  if (it.status !== 'Siap') { toast(`${it.name}: ${it.status}. Gunakan JPG/PNG/WEBP maks ${fmtSize(MAX_FILE)}.`, 'bad'); return; }
  S.draft = emptyDraft(); S.draft.image = it.blob; S.draft.imageName = it.name;
  await saveDraft(); render();
};
actions.refView = () => viewer(S.draft.image, 'DATA ACUAN');
actions.refCand = b => { S.draft.fields.batch = b.dataset.v; S.draft.unreadable.batch = false; S.draft.confirmed = false; saveDraft(); render(); };
actions.refOcr = async b => {
  if (S.busy) return;
  if (!navigator.onLine && !window.__OCR_MOCK) toast('Offline: OCR hanya berjalan bila modulnya sudah pernah diunduh.', '');
  S.busy = true; b.disabled = true;
  const prog = document.getElementById('ocrProg'); prog.classList.remove('hidden');
  const bar = prog.querySelector('i'); const msg = document.getElementById('ocrMsg');
  msg.textContent = 'Memuat modul OCR & membaca gambar…';
  try {
    const { text } = await recognize(S.draft.image, p => { bar.style.width = Math.round(p * 100) + '%'; msg.textContent = `Membaca… ${Math.round(p * 100)}%`; });
    const p = parseReferenceText(text);
    const d = S.draft;
    d.ocrText = text; d.ocrDone = true; d.blending = p.blending; d.ambiguous = p.ambiguous; d.candidates = [...new Set(p.candidates)];
    d.unreadable = {}; d.confirmed = false;
    Object.assign(d.fields, { batch: p.batch, varian: p.varian, apiJaso: p.apiJaso, volume: p.volume, kemasan: p.kemasan, catatan: p.catatan });
    if (!d.fields.produk) d.ambiguous.push('Nama produk tidak diisi otomatis — ketik sesuai gambar');
    await saveDraft();
    toast('Pembacaan selesai. Periksa setiap field.', 'ok');
  } catch (e) {
    toast('OCR gagal: ' + e.message + ' Anda tetap bisa mengisi manual sesuai gambar.', 'bad');
  } finally { S.busy = false; render(); }
};
actions.refReset = async () => {
  if (!await modal({ title: 'Hapus draf DATA ACUAN?', body: '<p>Gambar dan isian draf akan dihapus.</p>', ok: 'Hapus', danger: true })) return;
  S.draft = emptyDraft(); await saveDraft(); render();
};
actions.refLock = async () => {
  const d = S.draft; const r = refValidation(d);
  if (r.problems.length || !d.confirmed) return;
  const f = d.fields;
  const ok = await modal({ title: 'Simpan & kunci DATA ACUAN?', ok: 'KUNCI', body: `<div class="kv"><span>Produk</span><b>${esc(f.produk)}</b><span>Batch Filling</span><b style="font-family:monospace;font-size:17px">${esc(f.batch)}</b></div>
    <p class="hint">Setelah dikunci, data tidak bisa diubah. Penggantian hanya melalui perintah DATA ACUAN BARU.</p>` });
  if (!ok) return;
  const now = new Date();
  const ref = { id: 'REF-' + stamp(now), lockedAt: now.toISOString(), status: 'locked', image: d.image, imageName: d.imageName,
    fields: { ...f }, unreadable: { ...d.unreadable }, ocrText: d.ocrText, blendingIgnored: d.blending, ambiguous: [...d.ambiguous] };
  await db.put('refs', ref); await db.kvSet('activeRefId', ref.id);
  await db.audit('ACUAN_DIKUNCI', { id: ref.id, batch: f.batch });
  S.ref = ref; S.draft = null; await db.kvSet('draftRef', null);
  toast('DATA ACUAN tersimpan & terkunci.', 'ok'); render();
};

async function archivedRefsHtml() {
  const refs = (await db.all('refs')).filter(r => r.status === 'replaced').sort((a, b) => b.lockedAt.localeCompare(a.lockedAt));
  if (!refs.length) return '';
  return `<div class="card"><details><summary>Acuan lama (${refs.length}) — jejak audit</summary>
    ${refs.map(r => `<div class="itm"><b>${esc(r.id)}</b> • Batch ${esc(r.fields.batch)}<div class="hint">Dikunci ${fmtTime(r.lockedAt)} • Diganti ${fmtTime(r.replacedAt)}</div></div>`).join('')}</details></div>`;
}

async function renderLockedRef() {
  const r = S.ref; const f = r.fields;
  view.innerHTML = `
  <h2>DATA ACUAN</h2><p class="sub">Acuan aktif bersifat read-only. Foto aktual tidak pernah mengubah data ini.</p>
  <div class="card"><h3>Status</h3><div class="srow"><span class="big">${badge('TERKUNCI')}</span><span class="hint">${fmtTime(r.lockedAt)}</span></div>
    <div class="kv" style="margin-top:8px"><span>ID acuan</span><b>${esc(r.id)}</b></div></div>
  <div class="card"><h3>Gambar referensi</h3><img class="preview" src="${url(r.image)}" data-act="lockedView" alt="DATA ACUAN"><div class="hint">${esc(r.imageName)} • ketuk untuk memperbesar</div></div>
  <div class="card"><h3>Data terkunci</h3>
    <label class="f">Batch Filling</label><input class="mono" type="text" readonly value="${esc(f.batch)}">
    <div class="srow" style="margin-top:6px"><span>Format 8 digit</span>${badge('VALID')}</div>
    ${REF_FIELDS.map(x => `<label class="f">${esc(x.label)}</label><input type="text" readonly value="${esc(r.unreadable[x.key] ? '(tidak terbaca)' : f[x.key] || '-')}">`).join('')}
    ${r.blendingIgnored ? `<p class="hint">Batch Blending ${esc(r.blendingIgnored)} diabaikan.</p>` : ''}
  </div>
  <div class="card"><h3>Tindakan</h3><button class="full danger" data-act="refNew">DATA ACUAN BARU</button>
    <p class="hint">Memulai referensi baru. Acuan lama tetap tersimpan untuk audit.</p></div>
  ${await archivedRefsHtml()}`;
}
actions.lockedView = () => viewer(S.ref.image, 'DATA ACUAN ' + S.ref.id);
actions.refNew = async () => {
  const ok = await modal({ title: 'DATA ACUAN BARU', danger: true, ok: 'Mulai acuan baru', phrase: 'DATA ACUAN BARU',
    body: `<p>Acuan <b>${esc(S.ref.id)}</b> (Batch ${esc(S.ref.fields.batch)}) akan dinonaktifkan. ${S.session ? 'Sesi pemeriksaan yang belum selesai juga dibatalkan.' : ''}</p>` });
  if (!ok) return;
  const old = S.ref; old.status = 'replaced'; old.replacedAt = new Date().toISOString();
  await db.put('refs', old); await db.kvSet('activeRefId', null);
  await db.audit('ACUAN_DIGANTI', { oldId: old.id, oldBatch: old.fields.batch, at: old.replacedAt });
  if (S.session) { await db.del('sessions', S.session.key); await db.audit('SESI_DIBATALKAN', { id: S.session.id, reason: 'DATA ACUAN BARU' }); S.session = null; await db.kvSet('currentSessionKey', null); }
  S.ref = null; S.draft = emptyDraft(); await saveDraft();
  toast('Acuan lama diarsipkan. Silakan unggah acuan baru.'); render();
};

// ================= ANALISIS (upload foto) =================
function newSession() {
  const now = new Date(); const id = 'QC-' + stamp(now);
  return { key: id + '#v1', id, version: 1, status: 'draft', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    refId: S.ref.id, refSnapshot: { id: S.ref.id, lockedAt: S.ref.lockedAt, fields: { ...S.ref.fields }, unreadable: { ...S.ref.unreadable }, image: S.ref.image, imageName: S.ref.imageName },
    photos: [], nextNo: 1, stages: null, verification: null, result: null };
}
function sessionRefMismatch() { return S.session && S.ref && S.session.refId !== S.ref.id; }
function resetAnalysis(s) { s.stages = null; s.result = null; s.photos.forEach(p => { p.ocr = null; }); }

routes.analisis = async () => {
  if (!S.ref) {
    view.innerHTML = `<h2>Upload Foto Aktual</h2><div class="msg warn">DATA ACUAN belum terkunci. Analisis dinonaktifkan sampai acuan dikunci.</div>
      <button class="full" data-act="goto" data-h="acuan">BUKA DATA ACUAN</button>`; return;
  }
  if (sessionRefMismatch()) {
    view.innerHTML = `<h2>Upload Foto Aktual</h2><div class="msg bad">Sesi ${esc(S.session.id)} dibuat dengan acuan lain. Mulai pemeriksaan baru.</div>
      <button class="full" data-act="newSession">PEMERIKSAAN BARU</button>`; return;
  }
  const s = S.session; const photos = s ? s.photos : [];
  const total = photos.reduce((a, p) => a + p.size, 0);
  const bad = photos.filter(p => p.status !== 'Siap');
  const uncategorized = photos.filter(p => p.status === 'Siap' && !p.category);
  const canRun = photos.length > 0 && !bad.length && !uncategorized.length;
  view.innerHTML = `
  <h2>Upload Foto Aktual</h2><p class="sub">Tambahkan foto untuk satu sesi QC${s ? ` • <b>${esc(s.id)}</b>` : ''}</p>
  <div class="card"><h3>Tambahkan foto</h3>
    <div class="row"><button data-act="addPhotos" data-k="multi">GALERI</button><button data-act="addPhotos" data-k="camera">KAMERA</button></div>
    <p class="hint">Pilih beberapa foto sekaligus. JPG/PNG/WEBP, maks ${fmtSize(MAX_FILE)} per foto. Untuk emboss, foto dari dekat dengan cahaya miring.</p>
  </div>
  <div class="card"><h3>Daftar foto (${photos.length})</h3>
    ${photos.length ? photos.map((p, i) => `<div class="photo">
      ${p.blob ? `<img src="${url(p.blob)}" alt="" data-act="viewPhoto" data-i="${i}">` : `<div style="width:76px;height:76px;border-radius:8px;background:var(--gray)"></div>`}
      <div><div class="srow"><b>${photoNo(p.no)}</b>${badge(p.status === 'Siap' ? 'Siap' : p.status)}</div>
        <div class="meta">${esc(p.name)} • ${fmtSize(p.size)}</div>
        <select data-cat="${i}" style="margin-top:6px" ${p.status !== 'Siap' ? 'disabled' : ''}>${CATEGORIES.map(c => `<option value="${c}" ${p.category === c ? 'selected' : ''}>${c || '— Belum diklasifikasi —'}</option>`).join('')}</select>
        <div class="row" style="margin-top:6px"><button class="small sec" data-act="viewPhoto" data-i="${i}" ${p.blob ? '' : 'disabled'}>LIHAT</button><button class="small sec" data-act="replacePhoto" data-i="${i}">GANTI</button><button class="small sec" data-act="delPhoto" data-i="${i}">HAPUS</button></div>
      </div></div>`).join('')
    : `<div class="empty">Belum ada foto aktual. Tekan GALERI atau KAMERA untuk menambahkan.</div>`}
  </div>
  <div class="card"><h3>Mulai analisis</h3>
    <div class="kv"><span>Jumlah foto</span><b>${photos.length}</b><span>Total ukuran</span><b>${fmtSize(total || 0)}</b>
      <span>DATA ACUAN</span><b>TERKUNCI • ${esc(S.ref.fields.batch)}</b></div>
    ${bad.length ? `<div class="msg bad" style="margin-top:8px">${bad.length} foto bermasalah (${[...new Set(bad.map(p => p.status))].join(', ')}). Ganti atau hapus dulu.</div>` : ''}
    ${uncategorized.length ? `<div class="msg warn" style="margin-top:8px">Pilih kategori untuk: ${uncategorized.map(p => photoNo(p.no)).join(', ')}.</div>` : ''}
    ${!photos.length ? `<div class="msg warn" style="margin-top:8px">Minimal satu foto aktual diperlukan.</div>` : ''}
    <button class="full" style="margin-top:10px" data-act="startAnalysis" ${canRun ? '' : 'disabled'}>ANALISIS FOTO AKTUAL</button>
    ${s && s.stages ? `<button class="full sec" style="margin-top:8px" data-act="goto" data-h="${s.result ? 'hasil' : 'proses'}">LIHAT PROSES / HASIL TERAKHIR</button>` : ''}
  </div>`;
  view.querySelectorAll('[data-cat]').forEach(el => el.addEventListener('change', async () => {
    const p = S.session.photos[+el.dataset.cat]; p.category = el.value; resetAnalysis(S.session); await saveSession(); render();
  }));
};
async function ensureSession() {
  if (!S.session) { S.session = newSession(); await saveSession(); await db.kvSet('currentSessionKey', S.session.key); }
  return S.session;
}
actions.addPhotos = async b => {
  const files = await pickFiles(b.dataset.k); if (!files.length) return;
  const s = await ensureSession();
  for (const f of files) {
    const it = await prepareImage(f);
    s.photos.push({ ...it, no: s.nextNo++, category: '' });
  }
  resetAnalysis(s); await saveSession();
  const badN = s.photos.filter(p => p.status !== 'Siap').length;
  toast(`${files.length} foto ditambahkan${badN ? ` (${badN} bermasalah)` : ''}.`, badN ? 'bad' : 'ok'); render();
};
actions.viewPhoto = b => { const p = S.session.photos[+b.dataset.i]; viewer(p.blob, `${photoNo(p.no)} • ${p.name}`); };
actions.replacePhoto = async b => {
  const [f] = await pickFiles('gallery'); if (!f) return;
  const i = +b.dataset.i; const old = S.session.photos[i];
  const it = await prepareImage(f);
  S.session.photos[i] = { ...it, no: old.no, category: old.category };
  resetAnalysis(S.session); await saveSession(); toast(`${photoNo(old.no)} diganti.`); render();
};
actions.delPhoto = async b => {
  const i = +b.dataset.i; const p = S.session.photos[i];
  if (!await modal({ title: `Hapus ${photoNo(p.no)}?`, body: `<p>${esc(p.name)} akan dikeluarkan dari sesi.</p>`, ok: 'Hapus', danger: true })) return;
  S.session.photos.splice(i, 1); resetAnalysis(S.session); await saveSession(); render();
};
actions.startAnalysis = async () => {
  const ok = await modal({ title: 'Pemberitahuan privasi', ok: 'Mulai analisis',
    body: `<p>Foto diproses <b>hanya di perangkat ini</b> dan <b>tidak dikirim</b> ke server atau layanan AI eksternal.</p>
      <p class="hint">Saat pertama kali, aplikasi mengunduh modul pembaca teks (OCR Tesseract, open-source) dari cdn.jsdelivr.net. Yang diunduh hanya kode program, bukan foto Anda.</p>` });
  if (!ok) return;
  const s = S.session;
  s.stages = STAGES.map(n => ({ name: n, status: 'MENUNGGU', note: '' }));
  s.photos.forEach(p => { p.ocr = { status: 'menunggu' }; });
  s.result = null; s.verification = s.verification || emptyVerification(s);
  await saveSession(); go('proses');
  runPipeline();
};

// ================= PROSES =================
const STAGES = ['Validasi referensi', 'Klasifikasi gambar', 'Pembacaan batch', 'Identitas produk', 'Pemeriksaan visual', 'Double check', 'Susun laporan'];
const ocrDone = s => !!(s && s.stages && s.photos.length && s.photos.every(p => p.ocr && p.ocr.status === 'selesai') && s.stages[0].status === 'SELESAI' && s.stages[1].status === 'SELESAI');
function setStage(i, status, note = '') { S.session.stages[i].status = status; S.session.stages[i].note = note; }

async function runPipeline(onlyFailed = false) {
  const s = S.session; if (!s || S.busy) return;
  S.busy = true;
  try {
    // 1. Validasi referensi
    const refOk = S.ref && S.ref.id === s.refId && validateBatch(S.ref.fields.batch).valid;
    setStage(0, refOk ? 'SELESAI' : 'GAGAL', refOk ? S.ref.id : 'Acuan tidak aktif / tidak valid');
    await saveSession(); refreshProses();
    if (!refOk) return;
    // 2. Klasifikasi (ditetapkan petugas)
    const unc = s.photos.filter(p => !p.category || p.status !== 'Siap');
    setStage(1, unc.length ? 'GAGAL' : 'SELESAI', unc.length ? 'Ada foto belum diklasifikasi/bermasalah' : 'Kategori ditetapkan petugas');
    await saveSession(); refreshProses();
    if (unc.length) return;
    // 3. Pembacaan batch otomatis (OCR) per foto
    setStage(2, 'PROSES', 'OCR di perangkat'); await saveSession(); refreshProses();
    for (const p of s.photos) {
      if (onlyFailed && p.ocr && p.ocr.status === 'selesai') continue;
      p.ocr = { status: 'diproses', progress: 0 }; refreshProses();
      try {
        const r = await recognize(p.blob, pr => { p.ocr.progress = pr; refreshProses(true); });
        p.ocr = { status: 'selesai', text: r.text, confidence: r.confidence, candidates: findBatchCandidates(r.text) };
      } catch (e) { p.ocr = { status: 'gagal', error: e.message }; }
      await saveSession(); refreshProses();
    }
    const failed = s.photos.filter(p => p.ocr.status === 'gagal');
    if (failed.length) {
      setStage(2, 'GAGAL', `${failed.length} foto gagal dibaca: ${failed[0].ocr.error}`);
    } else {
      setStage(2, 'PERLU VERIFIKASI', 'Menunggu pembacaan petugas');
      setStage(3, 'PERLU VERIFIKASI'); setStage(4, 'PERLU VERIFIKASI');
    }
    await saveSession(); refreshProses();
  } finally { S.busy = false; refreshProses(); }
}

routes.proses = async () => {
  const s = S.session;
  if (!s || !s.stages) { view.innerHTML = `<h2>Analisis</h2><div class="empty">Belum ada analisis berjalan.</div><button class="full" data-act="goto" data-h="analisis">KE UPLOAD FOTO</button>`; return; }
  view.innerHTML = `<h2>Proses Analisis</h2><p class="sub">${esc(s.id)} • status berdasarkan proses nyata di perangkat</p><div id="proc"></div>`;
  refreshProses();
};
function refreshProses(progressOnly = false) {
  const box = document.getElementById('proc'); const s = S.session; if (!box || !s || !s.stages) return;
  if (progressOnly) { s.photos.forEach(p => { const el = document.getElementById('pp' + p.no); if (el && p.ocr) el.style.width = Math.round((p.ocr.progress || 0) * 100) + '%'; }); return; }
  const st = s.stages; const failed = s.photos.filter(p => p.ocr && p.ocr.status === 'gagal');
  const readyVerify = ocrDone(s);
  box.innerHTML = `
  <div class="card"><h3>Tahap analisis</h3>${st.map((x, i) => `<div class="stage"><div><b>${i + 1}. ${esc(x.name)}</b>${x.note ? `<div class="hint">${esc(x.note)}</div>` : ''}</div>${badge(x.status)}</div>`).join('')}</div>
  <div class="card"><h3>Status foto</h3>${s.photos.map(p => `<div class="stage"><div style="flex:1"><b>${photoNo(p.no)}</b> <span class="hint">${esc(p.category)}</span>
     ${p.ocr && p.ocr.status === 'diproses' ? `<div class="bar"><i id="pp${p.no}" style="width:${Math.round((p.ocr.progress || 0) * 100)}%"></i></div>` : ''}
     ${p.ocr && p.ocr.status === 'gagal' ? `<div class="hint" style="color:var(--bad)">${esc(p.ocr.error)}</div>` : ''}
     ${p.ocr && p.ocr.status === 'selesai' ? `<div class="hint">OCR: ${p.ocr.candidates.length ? p.ocr.candidates.length + ' kandidat 8 digit' : 'tidak menemukan angka 8 digit'}</div>` : ''}
     </div>${badge(p.ocr ? p.ocr.status.toUpperCase() : 'MENUNGGU')}</div>`).join('')}</div>
  <div class="card"><h3>Pesan sistem</h3>
    ${s.result ? `<div class="msg info">Laporan sudah disusun.</div><button class="full" data-act="goto" data-h="hasil">LIHAT HASIL QC</button>`
      : `<div class="msg warn">Belum ada keputusan final. RELEASE tidak ditampilkan sebelum seluruh tahap selesai.</div>`}
    ${failed.length && !S.busy ? `<div class="msg bad">${failed.length} foto gagal diproses. Pemeriksaan TIDAK lengkap.${navigator.onLine ? '' : ' Perangkat offline.'}</div>
      <button class="full" data-act="retryOcr">COBA LAGI</button>` : ''}
    ${readyVerify && !S.busy && !s.result ? `<button class="full" data-act="goto" data-h="verifikasi">LANJUT: VERIFIKASI PETUGAS</button>` : ''}
    ${st[0].status === 'GAGAL' || st[1].status === 'GAGAL' ? `<button class="full sec" data-act="goto" data-h="analisis">KEMBALI KE UPLOAD</button>` : ''}
  </div>`;
}
actions.retryOcr = () => runPipeline(true);

// ================= VERIFIKASI PETUGAS =================
function emptyVerification(s) {
  return { photos: {}, identity: Object.fromEntries(IDENTITY.map(x => [x.key, { status: '', photo: '', note: '' }])),
    visual: Object.fromEntries(VISUAL.map(x => [x.key, { status: '', critical: true, photo: '', note: '' }])), officer: '', followUp: '' };
}
function pv(s, no) { const v = s.verification.photos; if (!v[no]) v[no] = { mode: '', r1: '', r2: '', occ: '', obj: '', note: '', ocrOverride: false }; return v[no]; }
const seg = (path, cur, opts) => `<div class="seg">${opts.map(([val, lab]) => `<button type="button" class="${cur === val ? 'on' : ''}" data-act="seg" data-path="${path}" data-v="${val}">${esc(lab)}</button>`).join('')}</div>`;
const statusSeg = (path, cur) => seg(path, cur, ALL_STATUS.map(x => [x, x === STATUS.NOT_APPLICABLE ? 'N/A' : x]));
const photoSelect = (path, cur, s) => `<select data-path="${path}"><option value="">— Foto bukti —</option>${s.photos.map(p => `<option value="${p.no}" ${String(cur) === String(p.no) ? 'selected' : ''}>${photoNo(p.no)} (${esc(p.category)})</option>`).join('')}</select>`;

routes.verifikasi = async () => {
  const s = S.session;
  if (!ocrDone(s)) { go('proses'); return; }
  if (!s.verification) s.verification = emptyVerification(s);
  const v = s.verification; const ref = s.refSnapshot;
  const allOcr = s.photos.map(p => (p.ocr && p.ocr.text) || '').join('\n');
  view.innerHTML = `
  <h2>Verifikasi Petugas</h2><p class="sub">Isi sesuai yang benar-benar terlihat. Jangan menebak. Gunakan <b>?</b> untuk digit yang tidak terbaca.</p>
  <div class="card"><h3>Batch Filling acuan</h3><div style="font:700 22px ui-monospace,monospace;letter-spacing:4px">${esc(ref.fields.batch)}</div></div>
  <div class="card"><h3>A. Batch Filling per foto</h3>
  ${s.photos.map(p => { const x = pv(s, p.no); const cands = (p.ocr && p.ocr.candidates) || []; return `<div class="itm">
    <div class="photo" style="padding:0;border:0"><img src="${url(p.blob)}" data-act="viewPhotoV" data-no="${p.no}" alt="">
      <div><b>${photoNo(p.no)}</b> • ${esc(p.category)}<div class="meta">${esc(p.name)}</div>
      <div class="hint">OCR: ${cands.length ? cands.map(esc).join(', ') : 'tidak menemukan angka 8 digit'}</div>
      <button class="small sec" data-act="viewPhotoV" data-no="${p.no}" style="margin-top:4px">LIHAT + ZOOM</button></div></div>
    <div class="hint" style="margin-top:6px">Apakah Batch Filling terlihat di foto ini?</div>
    ${seg(`photos.${p.no}.mode`, x.mode, [['visible', 'Terlihat'], ['notvisible', 'Tidak terlihat'], ['na', 'Tidak relevan']])}
    ${x.mode === 'visible' ? `
      <label class="f">Pembacaan 1 (8 karakter)</label><input type="text" class="mono" maxlength="8" autocomplete="off" data-path="photos.${p.no}.r1" data-batch value="${esc(x.r1)}">
      <label class="f">Pembacaan 2 — baca ulang dari foto, ketik lagi</label><input type="text" class="mono" maxlength="8" autocomplete="off" data-path="photos.${p.no}.r2" data-batch value="${esc(x.r2)}">
      <div class="row"><div><label class="f">Jumlah kemunculan batch di foto</label><input type="number" min="0" inputmode="numeric" data-path="photos.${p.no}.occ" value="${esc(x.occ)}"></div>
        <div><label class="f">Jumlah objek fisik berbeda</label><input type="number" min="0" inputmode="numeric" data-path="photos.${p.no}.obj" value="${esc(x.obj)}"></div></div>
      <p class="hint">Pantulan atau cetakan ganda pada benda yang sama tidak dihitung sebagai objek tambahan.</p>
      ${cands.length ? `<label class="check"><input type="checkbox" data-path="photos.${p.no}.ocrOverride" ${x.ocrOverride ? 'checked' : ''}> Jika OCR berbeda dari pembacaan saya: saya sudah memeriksa ulang dan OCR salah baca.</label>` : ''}` : ''}
    <label class="f">Catatan</label><input type="text" data-path="photos.${p.no}.note" value="${esc(x.note)}">
  </div>`; }).join('')}
  </div>
  <div class="card"><h3>B. Identitas produk</h3>
  ${IDENTITY.map(it => { const x = v.identity[it.key]; const rv = it.ref(ref); const hit = rv ? s.photos.filter(p => p.ocr && textContains(p.ocr.text, rv)).map(p => photoNo(p.no)) : [];
    return `<div class="itm"><b>${esc(it.name)}</b><div class="hint">Acuan: <b>${esc(rv || '(tidak tercantum di acuan)')}</b>${rv ? ` • Petunjuk OCR: ${hit.length ? 'ditemukan di ' + hit.join(', ') : 'tidak ditemukan otomatis'}` : ''}</div>
    ${statusSeg(`identity.${it.key}.status`, x.status)}
    <div class="row" style="margin-top:6px">${photoSelect(`identity.${it.key}.photo`, x.photo, s)}<input type="text" placeholder="Catatan" data-path="identity.${it.key}.note" value="${esc(x.note)}"></div></div>`; }).join('')}
  </div>
  <div class="card"><h3>C. Pemeriksaan visual</h3><p class="hint">MATCH = sesuai/baik. MISMATCH = tidak sesuai/cacat. N/A = tidak relevan.</p>
  ${VISUAL.map(it => { const x = v.visual[it.key]; return `<div class="itm"><b>${esc(it.name)}</b>
    ${statusSeg(`visual.${it.key}.status`, x.status)}
    <label class="check"><input type="checkbox" data-path="visual.${it.key}.critical" ${x.critical ? 'checked' : ''}> Elemen kritis (MISMATCH → HOLD TOTAL)</label>
    <div class="row">${photoSelect(`visual.${it.key}.photo`, x.photo, s)}<input type="text" placeholder="Catatan" data-path="visual.${it.key}.note" value="${esc(x.note)}"></div></div>`; }).join('')}
  </div>
  <div class="card"><h3>D. Petugas & tindak lanjut</h3>
    <label class="f">Nama petugas QC</label><input type="text" data-path="officer" value="${esc(v.officer)}">
    <label class="f">Temuan tambahan / tindak lanjut</label><textarea data-path="followUp">${esc(v.followUp)}</textarea>
  </div>
  <div id="verErr"></div>
  <button class="full" data-act="buildReport">SIMPAN VERIFIKASI &amp; SUSUN LAPORAN</button>
  ${allOcr.trim() ? `<details class="card" style="margin-top:12px"><summary>Teks OCR semua foto</summary><div class="ocrtext">${esc(allOcr)}</div></details>` : ''}`;
  view.querySelectorAll('[data-path]').forEach(el => {
    if (el.tagName === 'BUTTON') return;
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.batch !== undefined) { val = val.replace(/\s/g, ''); if (val !== el.value) el.value = val; }
      setPath(s.verification, el.dataset.path, val); s.result = null; saveSoon(saveSession);
    });
  });
};
actions.viewPhotoV = b => { const p = S.session.photos.find(x => x.no === +b.dataset.no); viewer(p.blob, photoNo(p.no)); };
actions.seg = async b => {
  const y = scrollY; setPath(S.session.verification, b.dataset.path, b.dataset.v); S.session.result = null;
  await saveSession(); await render(); scrollTo(0, y);
};

function verificationErrors(s) {
  const v = s.verification; const errs = [];
  s.photos.forEach(p => {
    const x = pv(s, p.no);
    if (!x.mode) errs.push(`${photoNo(p.no)}: pilih apakah batch terlihat`);
    if (x.mode === 'visible') {
      ['r1', 'r2'].forEach((k, i) => { if (!/^[0-9?]{8}$/.test(x[k] || '')) errs.push(`${photoNo(p.no)}: pembacaan ${i + 1} harus 8 karakter (angka atau ?)`); });
      if (x.occ === '' || x.obj === '') errs.push(`${photoNo(p.no)}: isi jumlah kemunculan & objek fisik`);
    }
  });
  IDENTITY.forEach(it => { if (!v.identity[it.key].status) errs.push(`Identitas "${it.name}": pilih status`); });
  VISUAL.forEach(it => { if (!v.visual[it.key].status) errs.push(`Visual "${it.name}": pilih status`); });
  return errs;
}

// ---------- susun hasil (keputusan dihitung oleh qc-core) ----------
function computeResult(s) {
  const v = s.verification; const ref = s.refSnapshot; const refBatch = ref.fields.batch;
  const perPhoto = []; const dc = []; const unresolved = [];
  for (const p of s.photos) {
    const x = pv(s, p.no); const cands = (p.ocr && p.ocr.candidates) || [];
    const row = { no: p.no, category: p.category, mode: x.mode, r1: x.r1, r2: x.r2, ocr: cands, occ: x.occ, obj: x.obj, note: x.note };
    if (x.mode === 'na') { row.status = STATUS.NOT_APPLICABLE; row.reason = 'Batch tidak relevan untuk foto ini'; }
    else if (x.mode === 'notvisible') { row.status = STATUS.NOT_VISIBLE; row.reason = 'Batch tidak terlihat'; }
    else {
      const rc = reconcileReadings(x.r1, x.r2);
      row.consistent = rc.consistent;
      if (!rc.consistent) {
        row.value = null; row.status = STATUS.NOT_READABLE; row.reason = rc.note;
        row.positions = compareBatch(refBatch, '????????').positions;
      } else {
        const cmp = compareBatch(refBatch, rc.value);
        Object.assign(row, { value: rc.value, status: cmp.status, reason: cmp.reason, positions: cmp.positions });
      }
      let ocrNote = 'OCR tidak menemukan angka 8 digit (tidak memengaruhi keputusan)';
      if (cands.length && row.value) {
        if (cands.includes(row.value)) ocrNote = 'OCR sesuai dengan pembacaan petugas';
        else if (x.ocrOverride) ocrNote = `OCR membaca ${cands.join(', ')}; petugas menyatakan OCR salah baca setelah cek ulang`;
        else { ocrNote = `OCR membaca ${cands.join(', ')} — BERBEDA dari petugas (${row.value}); perlu tinjau`; unresolved.push(`${photoNo(p.no)}: OCR berbeda dari pembacaan petugas`); }
      }
      row.ocrNote = ocrNote;
      dc.push({ no: p.no, first: x.r1, second: x.r2, consistent: rc.consistent, ocrNote });
    }
    perPhoto.push(row);
  }
  const batchStatus = aggregateBatch(perPhoto);
  const show = perPhoto.find(r => r.status === STATUS.MISMATCH) || perPhoto.find(r => r.status === STATUS.NOT_READABLE && r.positions) || perPhoto.find(r => r.status === STATUS.MATCH);
  const actualDisplay = show ? (show.value || [show.r1, show.r2].join(' / ')) : '-';
  const batchReason = show ? show.reason : 'Batch Filling tidak terlihat pada foto mana pun';

  const identity = IDENTITY.map(it => { const x = v.identity[it.key]; const rv = it.ref(ref);
    return { key: it.key, name: it.name, ref: rv || '', status: x.status, photo: x.photo, note: x.note, required: true, critical: true }; });
  const visual = VISUAL.map(it => { const x = v.visual[it.key]; return { key: it.key, name: it.name, status: x.status, photo: x.photo, note: x.note, required: true, critical: !!x.critical }; });

  const elements = [{ name: 'Batch Filling', status: batchStatus, required: true, critical: true, note: batchReason },
    ...identity.map(e => ({ ...e, name: 'Identitas: ' + e.name })), ...visual.map(e => ({ ...e, name: 'Visual: ' + e.name }))];
  const ocrFailed = s.photos.filter(p => !p.ocr || p.ocr.status !== 'selesai').length;
  const fileBad = s.photos.filter(p => p.status !== 'Siap').length;
  const meta = { referenceLocked: !!(S.ref && S.ref.id === s.refId), photosTotal: s.photos.length, photosFailed: ocrFailed + fileBad,
    analysisComplete: verificationErrors(s).length === 0 && unresolved.length === 0 };
  const d = decide(elements, meta);
  if (unresolved.length) d.reasons.push(...unresolved);

  const counts = perPhoto.map(r => ({ no: r.no, ocrCount: r.ocr.length, occ: r.occ, obj: r.obj, value: r.value || '' }));
  const findings = [];
  for (const e of elements) {
    if (e.status === STATUS.MATCH || e.status === STATUS.NOT_APPLICABLE) continue;
    if (e.status === STATUS.MISMATCH) findings.push({ sev: e.critical ? 'KRITIS' : 'NON-KRITIS', text: `${e.name}: MISMATCH${e.note ? ' — ' + e.note : ''}`, action: e.critical ? 'Tahan/karantina batch; investigasi sumber ketidaksesuaian' : 'Catat dan tinjau oleh supervisor' });
    else findings.push({ sev: 'BUKTI KURANG', text: `${e.name}: ${e.status}${e.note ? ' — ' + e.note : ''}`, action: e.status === STATUS.NOT_VISIBLE ? 'Tambahkan foto yang memperlihatkan elemen ini' : 'Ambil foto close-up ulang dengan pencahayaan lebih baik' });
  }
  unresolved.forEach(u => findings.push({ sev: 'PERLU TINJAU', text: u, action: 'Baca ulang foto; konfirmasi bila OCR salah baca' }));
  return { ...d, computedAt: new Date().toISOString(), meta,
    batch: { ref: refBatch, actual: actualDisplay, status: batchStatus, reason: batchReason, positions: show && show.positions ? show.positions : [], perPhoto },
    identity, visual, counts, doubleCheck: dc, findings,
    totals: { occ: counts.reduce((a, c) => a + (+c.occ || 0), 0), obj: counts.reduce((a, c) => a + (+c.obj || 0), 0), unique: [...new Set(perPhoto.filter(r => r.value).map(r => r.value))] } };
}

actions.buildReport = async () => {
  const s = S.session; const errs = verificationErrors(s);
  const box = document.getElementById('verErr');
  if (errs.length) { box.innerHTML = `<div class="msg bad"><b>Belum lengkap (${errs.length}):</b><br>${errs.slice(0, 12).map(esc).join('<br>')}</div>`; box.scrollIntoView({ behavior: 'smooth' }); return; }
  const r = computeResult(s);
  s.result = r;
  setStage(2, r.batch.status === STATUS.MATCH || r.batch.status === STATUS.MISMATCH ? 'TERBACA' : 'TIDAK TERBACA', r.batch.reason);
  setStage(3, 'SELESAI'); setStage(4, 'SELESAI');
  setStage(5, r.doubleCheck.every(x => x.consistent) && !r.findings.some(f => f.sev === 'PERLU TINJAU') ? 'SELESAI' : 'PERLU TINJAU');
  setStage(6, 'SELESAI', r.decision);
  await saveSession(); await db.audit('LAPORAN_DISUSUN', { id: s.id, decision: r.decision });
  go('hasil');
};

// ================= HASIL QC =================
function digitsHtml(b) {
  if (!b.positions || !b.positions.length) return '';
  return `<div class="digits" style="margin-top:8px"><div class="lab">Posisi</div>${b.positions.map(p => `<div class="lab" style="text-align:center">${p.pos}</div>`).join('')}
    <div class="lab">Acuan</div>${b.positions.map(p => `<div>${esc(p.ref)}</div>`).join('')}
    <div class="lab">Aktual</div>${b.positions.map(p => `<div class="${cls(p.status)}">${esc(p.act || '?')}</div>`).join('')}</div>`;
}
function decisionHtml(r) {
  return `<div class="decision d-${cls(r.decision)}"><div style="font-size:12px;font-weight:700;letter-spacing:.6px">KEPUTUSAN</div>
    <div class="big">${esc(r.decision)}</div>
    ${r.decision !== DECISION.RELEASE ? '<div style="font-weight:600">RELEASE tidak diizinkan</div>' : ''}
    <div style="font-size:13px;margin-top:4px">Temuan kritis: <b>${r.criticalCount}</b></div>
    <ul>${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

// Bagian A–I: dipakai untuk DETAIL HASIL dan laporan PDF.
function reportSections(s, open = false) {
  const r = s.result; const ref = s.refSnapshot; const f = ref.fields;
  const sec = (t, body) => `<details class="card" ${open ? 'open' : ''}><summary>${t}</summary><div style="margin-top:8px">${body}</div></details>`;
  const tbl = (head, rows) => `<div class="scroll"><table class="tbl"><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.join('')}</table></div>`;
  const ph = no => no ? photoNo(no) : '-';
  return [
    sec('A. Identitas sesi', `<div class="kv"><span>ID pemeriksaan</span><b>${esc(s.id)}${s.version > 1 ? ' (revisi ' + s.version + ')' : ''}</b>
      <span>Dibuat</span><b>${fmtTime(s.createdAt)}</b><span>Laporan</span><b>${fmtTime(r.computedAt)}</b>
      ${s.finalizedAt ? `<span>Diselesaikan</span><b>${fmtTime(s.finalizedAt)}</b>` : ''}
      <span>Produk</span><b>${esc([f.brand, f.produk].filter(Boolean).join(' '))}</b><span>Varian</span><b>${esc(f.varian || '-')}</b>
      <span>Volume</span><b>${esc(f.volume || '-')}</b><span>Petugas</span><b>${esc(s.verification.officer || '-')}</b>
      ${s.revisionNote ? `<span>Alasan revisi</span><b>${esc(s.revisionNote)}</b>` : ''}</div>`),
    sec('B. Referensi terkunci', `<img class="preview" src="${url(ref.image)}" alt="DATA ACUAN"><div class="kv" style="margin-top:8px">
      <span>ID acuan</span><b>${esc(ref.id)}</b><span>Waktu lock</span><b>${fmtTime(ref.lockedAt)}</b><span>Batch Filling</span><b style="font-family:monospace">${esc(f.batch)}</b>
      ${REF_FIELDS.map(x => `<span>${esc(x.label)}</span><b>${esc(ref.unreadable[x.key] ? '(tidak terbaca)' : f[x.key] || '-')}</b>`).join('')}</div>`),
    sec('C. Identitas produk', tbl(['Elemen', 'Acuan', 'Status', 'Bukti', 'Catatan'], r.identity.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.ref || '-')}</td><td>${badge(e.status)}</td><td>${ph(e.photo)}</td><td>${esc(e.note)}</td></tr>`))),
    sec('D. Batch Filling', `<div class="kv"><span>Acuan</span><b style="font-family:monospace">${esc(r.batch.ref)}</b><span>Aktual</span><b style="font-family:monospace">${esc(r.batch.actual)}</b><span>Status</span><b>${badge(r.batch.status)}</b></div>
      <div class="hint">${esc(r.batch.reason)}</div>${digitsHtml(r.batch)}
      <div style="margin-top:10px">${tbl(['Foto', 'Bacaan', 'Status', 'Keterangan'], r.batch.perPhoto.map(x => `<tr><td>${ph(x.no)}</td><td style="font-family:monospace">${esc(x.value || (x.mode === 'visible' ? x.r1 + ' / ' + x.r2 : '-'))}</td><td>${badge(x.status)}</td><td>${esc(x.reason)}</td></tr>`))}</div>`),
    sec('E. Pemeriksaan foto', `${tbl(['Foto', 'Kategori', 'File', 'OCR'], s.photos.map(p => `<tr><td>${ph(p.no)}</td><td>${esc(p.category)}</td><td>${esc(p.name)}<br><span class="hint">${fmtSize(p.size)}</span></td><td>${p.ocr ? esc(p.ocr.status) : '-'}</td></tr>`))}
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:8px">${s.photos.map(p => `<figure style="margin:0"><img src="${url(p.blob)}" style="width:100%;border-radius:6px" alt=""><figcaption class="hint">${ph(p.no)}</figcaption></figure>`).join('')}</div>
      <div style="margin-top:8px">${tbl(['Elemen visual', 'Status', 'Kritis', 'Bukti', 'Catatan'], r.visual.map(e => `<tr><td>${esc(e.name)}</td><td>${badge(e.status)}</td><td>${e.critical ? 'Ya' : 'Tidak'}</td><td>${ph(e.photo)}</td><td>${esc(e.note)}</td></tr>`))}</div>`),
    sec('F. Hitungan batch', `${tbl(['Foto', 'Kemunculan (petugas)', 'Objek fisik', 'Kandidat OCR', 'Nilai'], r.counts.map(c => `<tr><td>${ph(c.no)}</td><td>${esc(c.occ || '-')}</td><td>${esc(c.obj || '-')}</td><td>${c.ocrCount}</td><td style="font-family:monospace">${esc(c.value || '-')}</td></tr>`))}
      <div class="kv" style="margin-top:8px"><span>Total kemunculan</span><b>${r.totals.occ}</b><span>Total objek fisik</span><b>${r.totals.obj}</b><span>Nilai unik</span><b style="font-family:monospace">${esc(r.totals.unique.join(', ') || '-')}</b></div>
      <p class="hint">Keterbatasan: hitungan berdasarkan pengamatan petugas pada foto; pantulan/duplikat pada benda yang sama tidak dihitung sebagai objek tambahan. OCR tidak andal untuk angka emboss.</p>`),
    sec('G. Double check', r.doubleCheck.length ? tbl(['Foto', 'Bacaan 1', 'Bacaan 2', 'Konsisten', 'OCR'], r.doubleCheck.map(x => `<tr><td>${ph(x.no)}</td><td style="font-family:monospace">${esc(x.first)}</td><td style="font-family:monospace">${esc(x.second)}</td><td>${x.consistent ? badge('YA') : badge('TIDAK')}</td><td>${esc(x.ocrNote)}</td></tr>`)) : '<div class="hint">Tidak ada pembacaan batch.</div>'),
    sec('H. Temuan QC & tindak lanjut', `${r.findings.length ? tbl(['Tingkat', 'Temuan', 'Tindak lanjut'], r.findings.map(x => `<tr><td>${badge(x.sev)}</td><td>${esc(x.text)}</td><td>${esc(x.action)}</td></tr>`)) : '<div class="hint">Tidak ada temuan.</div>'}
      ${s.verification.followUp ? `<p><b>Catatan petugas:</b> ${esc(s.verification.followUp)}</p>` : ''}`),
    sec('I. Keputusan akhir', `${decisionHtml(r)}<div class="kv"><span>Petugas QC</span><b>${esc(s.verification.officer || '-')}</b>
      <span>Persetujuan petugas</span><b>${s.approvedBy ? `Disetujui oleh ${esc(s.approvedBy)} • ${fmtTime(s.finalizedAt)}` : 'BELUM'}</b></div>
      <p class="hint">Aplikasi adalah alat bantu inspeksi. Petugas QC memegang otoritas persetujuan akhir sesuai prosedur perusahaan.</p>`),
  ].join('');
}

routes.hasil = async () => {
  const s = S.session;
  if (!s || !s.result) { view.innerHTML = `<h2>Hasil Pemeriksaan</h2><div class="empty">Belum ada hasil. Selesaikan analisis dan verifikasi terlebih dahulu.</div><button class="full" data-act="goto" data-h="analisis">KE ANALISIS</button>`; return; }
  const r = s.result;
  view.innerHTML = `<h2>Hasil Pemeriksaan</h2><p class="sub">${esc(s.id)} • ${fmtTime(r.computedAt)} • belum diselesaikan</p>
  ${decisionHtml(r)}
  <div class="card"><h3>Batch Filling</h3><div class="kv"><span>Acuan</span><b style="font-family:monospace">${esc(r.batch.ref)}</b><span>Aktual</span><b style="font-family:monospace">${esc(r.batch.actual)}</b><span>Status</span><b>${badge(r.batch.status)}</b></div>${digitsHtml(r.batch)}</div>
  <div class="card"><h3>Identitas produk</h3>${r.identity.map(e => `<div class="srow" style="padding:3px 0"><span>${esc(e.name)}</span>${badge(e.status)}</div>`).join('')}</div>
  <div class="card"><h3>Tindakan</h3>
    <div class="row"><button class="sec" data-act="toggleDetail">DETAIL HASIL</button><button class="sec" data-act="exportPdf" data-k="${esc(s.key)}">EKSPOR PDF</button></div>
    <div class="row" style="margin-top:8px"><button class="sec" data-act="goto" data-h="verifikasi">UBAH VERIFIKASI</button><button class="sec" data-act="redo">ULANGI ANALISIS</button></div>
    <label class="f">Nama petugas QC yang menyetujui *</label><input type="text" id="approver" value="${esc(s.verification.officer || '')}">
    <label class="check"><input type="checkbox" id="approveChk"> Saya telah meninjau seluruh bukti dan menyetujui keputusan <b>${esc(r.decision)}</b>.</label>
    <button class="full" data-act="finish" id="btnFinish" disabled>SELESAI &amp; SIMPAN KE RIWAYAT</button>
  </div>
  <div id="detail" class="hidden">${reportSections(s)}</div>`;
  const chk = document.getElementById('approveChk'); const nm = document.getElementById('approver'); const btn = document.getElementById('btnFinish');
  const upd = () => { btn.disabled = !(chk.checked && nm.value.trim()); };
  chk.addEventListener('change', upd); nm.addEventListener('input', upd);
};
actions.toggleDetail = () => { const d = document.getElementById('detail'); d.classList.toggle('hidden'); if (!d.classList.contains('hidden')) { d.querySelectorAll('details').forEach(x => { x.open = true; }); d.scrollIntoView({ behavior: 'smooth' }); } };
actions.redo = async () => {
  if (!await modal({ title: 'Ulangi analisis?', body: '<p>Pembacaan OCR akan diulang dan hasil saat ini dihapus. Isian verifikasi petugas tetap disimpan. Proses berjalan di perangkat (tanpa biaya API).</p>', ok: 'Ulangi' })) return;
  await actions.startAnalysis();
};
actions.finish = async () => {
  const s = S.session; const name = document.getElementById('approver').value.trim();
  if (!await modal({ title: 'Selesaikan sesi?', body: `<p>Keputusan <b>${esc(s.result.decision)}</b> akan disimpan ke riwayat atas nama <b>${esc(name)}</b>. Setelah disimpan, laporan tidak bisa diubah; koreksi dibuat sebagai revisi baru.</p>`, ok: 'Simpan' })) return;
  s.status = 'final'; s.approvedBy = name; s.verification.officer = s.verification.officer || name; s.finalizedAt = new Date().toISOString();
  await saveSession(); await db.audit('SESI_SELESAI', { id: s.id, version: s.version, decision: s.result.decision, by: name });
  const key = s.key; S.session = null; await db.kvSet('currentSessionKey', null);
  toast('Tersimpan ke riwayat.', 'ok'); go('laporan:' + key);
};

// ================= LAPORAN (read-only) & PDF =================
routes.laporan = async key => {
  const s = await db.get('sessions', key);
  if (!s || !s.result) { view.innerHTML = `<div class="msg bad">Laporan tidak ditemukan di perangkat ini.</div><button class="full" data-act="goto" data-h="riwayat">KE RIWAYAT</button>`; return; }
  const all = (await db.all('sessions')).filter(x => x.id === s.id && x.status === 'final').sort((a, b) => a.version - b.version);
  view.innerHTML = `<h2>Laporan ${esc(s.id)}</h2><p class="sub">Versi ${s.version}${s.status === 'final' ? ' • tersimpan, read-only' : ' • draf'}</p>
    ${all.length > 1 ? `<div class="msg info">Versi tersedia: ${all.map(x => `<a href="#laporan:${esc(x.key)}">v${x.version}</a>`).join(' • ')}</div>` : ''}
    <div class="row noprint" style="margin-bottom:12px"><button data-act="exportPdf" data-k="${esc(s.key)}">UNDUH / CETAK PDF</button>${s.status === 'final' ? `<button class="sec" data-act="revise" data-k="${esc(s.key)}">BUAT REVISI</button>` : ''}</div>
    ${reportSections(s, true)}`;
};
actions.exportPdf = b => go('cetak:' + b.dataset.k);
actions.revise = async b => {
  const s = await db.get('sessions', b.dataset.k);
  if (!S.ref || S.ref.id !== s.refId) { toast('Revisi hanya bisa dibuat bila DATA ACUAN yang sama masih aktif.', 'bad'); return; }
  const ok = await modal({ title: 'Buat revisi?', body: `<p>Laporan v${s.version} tetap tersimpan tanpa perubahan. Revisi dibuat sebagai versi baru.</p><label class="f">Alasan revisi *</label><input type="text" id="revNote">`, ok: 'Buat revisi' });
  if (!ok) return;
  const note = (modal.values.revNote || '').trim();
  const versions = (await db.all('sessions')).filter(x => x.id === s.id).map(x => x.version);
  const nv = Math.max(...versions) + 1;
  const copy = structuredClone(s);
  Object.assign(copy, { key: `${s.id}#v${nv}`, version: nv, status: 'draft', revisionOf: s.key, revisionNote: note || '(tanpa alasan)', finalizedAt: null, approvedBy: null, result: null, updatedAt: new Date().toISOString() });
  await db.put('sessions', copy); await db.kvSet('currentSessionKey', copy.key); await db.audit('REVISI_DIBUAT', { from: s.key, to: copy.key });
  S.session = copy; go('verifikasi');
};

routes.cetak = async key => {
  const s = await db.get('sessions', key) || (S.session && S.session.key === key ? S.session : null);
  if (!s || !s.result) { go('riwayat'); return; }
  view.innerHTML = `<div class="noprint msg info">Pada dialog cetak, pilih <b>Simpan sebagai PDF</b>, lalu tekan tombol unduh.
    <div class="row" style="margin-top:8px"><button data-act="doPrint">CETAK / SIMPAN PDF</button><button class="sec" data-act="back">KEMBALI</button></div></div>
    <div style="font-weight:700;font-size:18px;margin:8px 0">LAPORAN QC BATCH RELEASE</div>
    <div class="hint">Dibuat ${fmtTime(new Date().toISOString())} • QC BATCH RELEASE v${APP_VERSION} • ${s.status === 'final' ? 'FINAL' : 'DRAF — belum diselesaikan'}</div>
    ${reportSections(s, true)}`;
  document.title = `QC-${s.id}-v${s.version}`;
};
actions.doPrint = async () => {
  await Promise.all([...view.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
  window.print();
};
actions.back = () => history.back();
addEventListener('afterprint', () => { document.title = 'QC BATCH RELEASE'; });

// ================= RIWAYAT =================
const filt = { q: '', dec: '', from: '', to: '' };
routes.riwayat = async () => {
  view.innerHTML = `<h2>Riwayat QC</h2><p class="sub">Cari dan buka laporan lama</p>
  <div class="msg info">Riwayat tersimpan <b>di perangkat ini</b> (browser Chrome). Riwayat hilang bila data situs/browser dihapus atau HP diganti. Buat cadangan rutin di menu Setelan.</div>
  <div class="card"><h3>Pencarian</h3>
    <input type="search" id="fq" placeholder="Cari produk / brand / varian / Batch Filling / ID" value="${esc(filt.q)}">
    <div class="row" style="margin-top:8px"><div><label class="f">Dari</label><input type="date" id="ffrom" value="${filt.from}"></div><div><label class="f">Sampai</label><input type="date" id="fto" value="${filt.to}"></div></div>
    <label class="f">Keputusan</label><select id="fdec"><option value="">Semua</option>${Object.values(DECISION).map(d => `<option ${filt.dec === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
  </div><div id="hlist"></div>`;
  const all = (await db.all('sessions')).filter(s => s.status === 'final').sort((a, b) => b.finalizedAt.localeCompare(a.finalizedAt));
  const draw = () => {
    const q = filt.q.toLowerCase();
    const list = all.filter(s => {
      const f = s.refSnapshot.fields;
      const hay = [s.id, f.produk, f.brand, f.varian, f.batch, s.result.batch.actual].join(' ').toLowerCase();
      const local = new Date(s.finalizedAt); const ld = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
      return (!q || hay.includes(q)) && (!filt.dec || s.result.decision === filt.dec) && (!filt.from || ld >= filt.from) && (!filt.to || ld <= filt.to);
    });
    document.getElementById('hlist').innerHTML = all.length === 0
      ? `<div class="card empty">Belum ada pemeriksaan tersimpan.<br><br><button data-act="newSession">MULAI PEMERIKSAAN PERTAMA</button></div>`
      : list.length === 0 ? `<div class="card empty">Tidak ada record yang cocok.</div>`
      : list.map(s => `<div class="card"><div class="srow"><b>${fmtTime(s.finalizedAt)}</b>${badge(s.result.decision)}</div>
        <div>${esc([s.refSnapshot.fields.brand, s.refSnapshot.fields.produk].filter(Boolean).join(' '))} ${esc(s.refSnapshot.fields.varian || '')}</div>
        <div class="hint">Batch: <b style="font-family:monospace">${esc(s.refSnapshot.fields.batch)}</b> • ID ${esc(s.id)}${s.version > 1 ? ' v' + s.version : ''} • ${esc(s.approvedBy || '')}</div>
        <div class="row" style="margin-top:8px"><button class="small" data-act="goto" data-h="laporan:${esc(s.key)}">BUKA LAPORAN</button><button class="small sec" data-act="exportPdf" data-k="${esc(s.key)}">UNDUH / CETAK PDF</button></div></div>`).join('');
  };
  draw();
  document.getElementById('fq').addEventListener('input', e => { filt.q = e.target.value; draw(); });
  document.getElementById('fdec').addEventListener('change', e => { filt.dec = e.target.value; draw(); });
  document.getElementById('ffrom').addEventListener('change', e => { filt.from = e.target.value; draw(); });
  document.getElementById('fto').addEventListener('change', e => { filt.to = e.target.value; draw(); });
};

// ================= SETELAN =================
routes.setelan = async () => {
  let est = null, persisted = null;
  try { est = await navigator.storage.estimate(); persisted = await navigator.storage.persisted(); } catch {}
  const sessions = await db.all('sessions'); const refs = await db.all('refs');
  const audit = (await db.all('audit')).slice(-15).reverse();
  view.innerHTML = `<h2>Pengaturan</h2><p class="sub">Informasi layanan dan privasi</p>
  <div class="card"><h3>Status aplikasi</h3><div class="kv"><span>Versi aplikasi</span><b>${APP_VERSION}</b>
    <span>Backend</span><b>Tidak digunakan (semua proses di perangkat)</b><span>Internet</span><b>${navigator.onLine ? badge('ONLINE') : badge('OFFLINE')}</b>
    <span>Modul OCR</span><b>${window.Tesseract ? 'Sudah dimuat' : 'Dimuat saat dibutuhkan'}</b></div></div>
  <div class="card"><h3>Penyimpanan</h3><div class="kv"><span>Mode</span><b>Lokal (IndexedDB di Chrome)</b>
    <span>Terpakai</span><b>${est ? fmtSize(est.usage || 0) : '-'}</b><span>Penyimpanan permanen</span><b>${persisted ? badge('AKTIF') : badge('BELUM')}</b>
    <span>Sesi tersimpan</span><b>${sessions.filter(s => s.status === 'final').length}</b><span>Acuan tersimpan</span><b>${refs.length}</b>
    <span>Sinkronisasi cloud</span><b>Tidak ada</b></div>
    <p class="hint">Data disimpan sampai Anda menghapusnya. Data hilang bila data situs Chrome dihapus, aplikasi di-uninstall, atau HP rusak/diganti. Pemulihan hanya dari file cadangan.</p>
    ${!persisted ? '<button class="full sec" data-act="persist">MINTA PENYIMPANAN PERMANEN</button>' : ''}
    <div class="row" style="margin-top:8px"><button data-act="backup">EKSPOR CADANGAN</button><button class="sec" data-act="restore">PULIHKAN CADANGAN</button></div>
    <input type="file" id="restoreFile" accept="application/json,.json" class="hidden"></div>
  <div class="card"><h3>Privasi & data</h3><div class="kv"><span>Gambar dikirim ke AI?</span><b>TIDAK</b>
    <span>Pembaca teks</span><b>Tesseract OCR (open-source), berjalan di HP</b><span>Diunduh dari internet</span><b>Kode OCR & data bahasa (cdn.jsdelivr.net), bukan foto</b>
    <span>Data dikirim</span><b>Tidak ada</b><span>Biaya</span><b>Rp0 (tanpa API berbayar)</b></div></div>
  <div class="card"><h3>Informasi API</h3><div class="kv"><span>Koneksi API</span><b>Tidak digunakan</b><span>API key</span><b>Tidak ada di aplikasi ini</b></div></div>
  <div class="card"><h3>Aturan keputusan (terkunci)</h3>
    <div class="kv"><span>${badge('RELEASE')}</span><b>Semua elemen wajib yang relevan terbaca, terverifikasi, dan sesuai.</b>
    <span>${badge('HOLD')}</span><b>Bukti kritis tidak terbaca, tidak terlihat, ambigu, atau analisis belum lengkap.</b>
    <span>${badge('HOLD TOTAL')}</span><b>Ketidaksesuaian kritis terbukti, termasuk Batch Filling berbeda.</b></div>
    <p class="hint">Aturan tertanam di kode dan tidak dapat diubah dari aplikasi.</p></div>
  <div class="card"><h3>Log audit (terbaru)</h3>${audit.length ? audit.map(a => `<div class="itm"><b>${esc(a.event)}</b> <span class="hint">${fmtTime(a.at)}</span><div class="hint">${esc(JSON.stringify(a.detail))}</div></div>`).join('') : '<div class="empty">Belum ada aktivitas.</div>'}</div>
  <div class="card"><h3>Tentang aplikasi</h3><p style="font-size:14px">QC BATCH RELEASE adalah alat bantu inspeksi. OCR membantu membaca teks cetak (tabel, label) tetapi <b>tidak andal untuk angka emboss</b>; pembacaan emboss dilakukan petugas dua kali. Aplikasi tidak menebak karakter. Petugas QC memegang otoritas persetujuan akhir.</p>
    <button class="full danger" data-act="wipe">HAPUS SEMUA DATA</button></div>`;
};
actions.persist = async () => { try { const ok = await navigator.storage.persist(); toast(ok ? 'Penyimpanan permanen aktif.' : 'Chrome menolak permintaan. Pasang aplikasi ke layar utama lalu coba lagi.', ok ? 'ok' : 'bad'); } catch { toast('Tidak didukung.', 'bad'); } render(); };
const b64 = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
const unb64 = async d => (await fetch(d)).blob();
async function deepBlobs(o, fn) { if (o instanceof Blob) return fn(o); if (Array.isArray(o)) return Promise.all(o.map(x => deepBlobs(x, fn))); if (o && typeof o === 'object') { const out = {}; for (const k of Object.keys(o)) out[k] = await deepBlobs(o[k], fn); return out; } return o; }
async function deepRestore(o) { if (typeof o === 'string' && o.startsWith('data:image/')) return unb64(o); if (Array.isArray(o)) return Promise.all(o.map(deepRestore)); if (o && typeof o === 'object') { const out = {}; for (const k of Object.keys(o)) out[k] = await deepRestore(o[k]); return out; } return o; }
actions.backup = async () => {
  const data = { app: 'qc-batch-release', version: APP_VERSION, exportedAt: new Date().toISOString(),
    refs: await deepBlobs(await db.all('refs'), b64), sessions: await deepBlobs(await db.all('sessions'), b64), audit: await db.all('audit'), activeRefId: await db.kvGet('activeRefId') };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `qc-cadangan-${stamp(new Date())}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  await db.audit('CADANGAN_DIEKSPOR', { size: blob.size }); toast(`Cadangan dibuat (${fmtSize(blob.size)}). Simpan file ini di tempat aman.`, 'ok');
};
actions.restore = async () => {
  const el = document.getElementById('restoreFile');
  const file = await new Promise(r => { el.value = ''; el.onchange = () => r(el.files[0]); el.click(); });
  if (!file) return;
  let data; try { data = JSON.parse(await file.text()); } catch { toast('File cadangan tidak valid.', 'bad'); return; }
  if (data.app !== 'qc-batch-release') { toast('Bukan file cadangan QC BATCH RELEASE.', 'bad'); return; }
  if (!await modal({ title: 'Pulihkan cadangan?', body: `<p>${data.sessions.length} sesi dan ${data.refs.length} acuan dari ${fmtTime(data.exportedAt)} akan digabungkan. Record dengan ID sama akan ditimpa dengan isi cadangan.</p>`, ok: 'Pulihkan' })) return;
  for (const r of await deepRestore(data.refs)) await db.put('refs', r);
  for (const s of await deepRestore(data.sessions)) await db.put('sessions', s);
  if (!S.ref && data.activeRefId) await db.kvSet('activeRefId', data.activeRefId);
  await db.audit('CADANGAN_DIPULIHKAN', { from: data.exportedAt }); await loadState(); toast('Cadangan dipulihkan.', 'ok'); render();
};
actions.wipe = async () => {
  if (!await modal({ title: 'Hapus semua data?', danger: true, ok: 'Hapus permanen', phrase: 'HAPUS SEMUA', body: '<p>Semua acuan, sesi, riwayat, dan log di perangkat ini akan dihapus. Tindakan ini tidak dapat dibatalkan.</p>' })) return;
  for (const st of ['refs', 'sessions', 'kv', 'audit']) await db.clear(st);
  S.ref = null; S.draft = null; S.session = null; toast('Semua data dihapus.'); go('beranda');
};

// ================= start =================
(async () => {
  try { await loadState(); } catch (e) { view.innerHTML = `<div class="msg bad">Penyimpanan perangkat tidak tersedia: ${esc(e.message)}. Pastikan tidak memakai mode Samaran (Incognito).</div>`; return; }
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
window.__QC = { S, computeResult };
