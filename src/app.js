import { STATUS, DECISION, validateBatch, compareBatch, reconcileReadings, decide, aggregateBatch } from './qc-core.js';
import { db } from './db.js';
import { readReference, readPhoto, health, aiConfigured, getPasscode, setPasscode, apiBase } from './ai.js';

const APP_VERSION = '0.2.0';
const MAX_FILE = 15 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CATEGORIES = ['', 'Emboss', 'Label', 'Karton', 'Printer', 'Lainnya'];
const AI_KEYS = { identity: { nama: 'nama', varian: 'varian', apiJaso: 'api_jaso', volume: 'volume', kemasan: 'kemasan' } };
const S_ai = { status: 'unknown', model: '', price: null, error: '' };
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

// Catat pemakaian AI (token & estimasi biaya) untuk transparansi.
async function addUsage(u, session) {
  if (!u) return;
  const t = (await db.kvGet('usageTotal')) || { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
  t.input_tokens += u.input_tokens || 0; t.output_tokens += u.output_tokens || 0; t.cost_usd += u.cost_usd || 0; t.calls += 1;
  await db.kvSet('usageTotal', t);
  if (session) {
    const x = session.usage || (session.usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 });
    x.input_tokens += u.input_tokens || 0; x.output_tokens += u.output_tokens || 0; x.cost_usd += u.cost_usd || 0; x.calls += 1;
  }
}
const fmtCost = usd => `$${(usd || 0).toFixed(4)} (± Rp${Math.round((usd || 0) * 16500).toLocaleString('id-ID')})`;

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
  const ac = document.getElementById('aiChip');
  if (ac) {
    const st = !aiConfigured() ? ['AI: BELUM DIATUR', 'warn'] : S_ai.status === 'ok' ? ['AI: AKTIF', 'ok'] : S_ai.status === 'error' ? ['AI: GAGAL', 'bad'] : ['AI: …', ''];
    ac.textContent = st[0]; ac.className = 'chip ' + st[1];
  }
}
async function checkAi() {
  if (!aiConfigured()) { S_ai.status = 'unknown'; updateHeader(); return; }
  try { const h = await health(); Object.assign(S_ai, { status: 'ok', model: h.model, price: h.price, error: '' }); }
  catch (e) { Object.assign(S_ai, { status: 'error', error: e.message }); }
  updateHeader();
}
addEventListener('online', checkAi);
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
    ${d.ocrDone ? `<div class="msg info">Isian di bawah adalah <b>hasil baca AI</b>${d.aiModel ? ' (' + esc(d.aiModel) + ')' : ''}. Cocokkan setiap field dengan gambar. Koreksi bila perlu. Jangan mengisi yang tidak terbaca.</div>`
      : `<div class="msg warn">Tekan <b>BACA DATA ACUAN</b> agar AI membaca tabel, atau isi manual sesuai gambar.</div>`}
    <label class="f">Batch Filling (tepat 8 digit) *</label>
    <input type="text" class="mono" inputmode="numeric" maxlength="8" autocomplete="off" data-ref="batch" value="${esc(d.fields.batch)}" ${d.unreadable.batch ? 'disabled' : ''}>
    <label class="check"><input type="checkbox" data-unr="batch" ${d.unreadable.batch ? 'checked' : ''}> Tidak terbaca</label>
    ${d.candidates.length > 1 && !d.blending ? `<div class="hint">Kandidat 8 digit: ${d.candidates.map(c => `<button class="small sec" data-act="refCand" data-v="${esc(c)}">${esc(c)}</button>`).join(' ')}</div>` : ''}
    ${d.blending ? `<div class="hint">Batch Blending terdeteksi (${esc(d.blending)}) — <b>diabaikan</b>, tidak dipakai untuk pemeriksaan.</div>` : ''}
    ${REF_FIELDS.map(f => `<label class="f">${esc(f.label)}${f.required ? ' *' : ''}</label>
      ${f.key === 'catatan' ? `<textarea data-ref="catatan" ${d.unreadable.catatan ? 'disabled' : ''}>${esc(d.fields.catatan)}</textarea>`
        : `<input type="text" data-ref="${f.key}" value="${esc(d.fields[f.key])}" ${d.unreadable[f.key] ? 'disabled' : ''}>`}
      <label class="check"><input type="checkbox" data-unr="${f.key}" ${d.unreadable[f.key] ? 'checked' : ''}> ${f.key === 'catatan' ? 'Tidak ada / tidak terbaca' : 'Tidak terbaca / tidak tercantum'}</label>`).join('')}
    ${d.ocrText ? `<details><summary>Data mentah hasil AI</summary><div class="ocrtext">${esc(d.ocrText)}</div></details>` : ''}
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
  if (!aiConfigured()) { toast('AI belum diatur. Buka Setelan dan isi kode akses.', 'bad'); return; }
  if (!await modal({ title: 'Kirim gambar acuan ke AI?', ok: 'Kirim & baca', body: '<p>Gambar DATA ACUAN dikirim ke Claude (Anthropic) melalui server aplikasi untuk dibaca. Server aplikasi tidak menyimpan gambar.</p>' })) return;
  S.busy = true; b.disabled = true;
  const prog = document.getElementById('ocrProg'); prog.classList.remove('hidden');
  const bar = prog.querySelector('i'); bar.style.width = '35%';
  document.getElementById('ocrMsg').textContent = 'AI sedang membaca tabel… (10–40 detik)';
  try {
    const res = await readReference(S.draft.image);
    const a = res.data || {}; const d = S.draft;
    const unr = new Set((a.tidak_terbaca || []).map(x => String(x).toLowerCase()));
    d.ocrText = JSON.stringify(a, null, 1); d.ocrDone = true; d.aiModel = res.model; d.aiUsage = res.usage;
    d.blending = a.batch_blending || ''; d.ambiguous = [...(a.ambigu || [])]; d.candidates = [];
    if ((a.jumlah_baris_data || 0) > 1) d.ambiguous.unshift(`Tabel berisi ${a.jumlah_baris_data} baris data — pastikan baris yang benar`);
    d.unreadable = {}; d.confirmed = false;
    Object.assign(d.fields, { produk: a.produk || '', brand: a.brand || '', varian: a.varian || '', apiJaso: a.api_jaso || '', volume: a.volume || '', kemasan: a.kemasan || '', batch: (a.batch_filling || '').replace(/\s/g, ''), catatan: a.catatan || '' });
    if ([...unr].some(x => x.includes('batch'))) d.ambiguous.push('AI menyatakan Batch Filling tidak terbaca pasti');
    if (d.fields.batch.includes('?')) d.ambiguous.push('Batch Filling mengandung digit tidak terbaca (?) — ambil gambar acuan yang lebih jelas');
    await saveDraft();
    await addUsage(res.usage);
    toast('AI selesai membaca. Periksa setiap field.', 'ok');
  } catch (e) {
    toast('Gagal membaca: ' + e.message + ' Coba lagi, atau isi manual sesuai gambar.', 'bad');
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
    fields: { ...f }, unreadable: { ...d.unreadable }, aiRaw: d.ocrText, aiModel: d.aiModel || '', blendingIgnored: d.blending, ambiguous: [...d.ambiguous] };
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
function resetAnalysis(s) { s.stages = null; s.result = null; s.photos.forEach(p => { p.ai = null; p.aiCategory = ''; }); s.verification = null; }

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
  const canRun = photos.length > 0 && !bad.length && aiConfigured();
  view.innerHTML = `
  <h2>Upload Foto Aktual</h2><p class="sub">Tambahkan foto untuk satu sesi QC${s ? ` • <b>${esc(s.id)}</b>` : ''}</p>
  <div class="card"><h3>Tambahkan foto</h3>
    <div class="row"><button data-act="addPhotos" data-k="multi">GALERI</button><button data-act="addPhotos" data-k="camera">KAMERA</button></div>
    <p class="hint">Pilih beberapa foto sekaligus. JPG/PNG/WEBP, maks ${fmtSize(MAX_FILE)} per foto. Untuk emboss, foto dari dekat dengan cahaya miring. Kategori dideteksi AI; Anda boleh mengoreksi.</p>
  </div>
  <div class="card"><h3>Daftar foto (${photos.length})</h3>
    ${photos.length ? photos.map((p, i) => `<div class="photo">
      ${p.blob ? `<img src="${url(p.blob)}" alt="" data-act="viewPhoto" data-i="${i}">` : `<div style="width:76px;height:76px;border-radius:8px;background:var(--gray)"></div>`}
      <div><div class="srow"><b>${photoNo(p.no)}</b>${badge(p.status === 'Siap' ? 'Siap' : p.status)}</div>
        <div class="meta">${esc(p.name)} • ${fmtSize(p.size)}</div>
        <select data-cat="${i}" style="margin-top:6px" ${p.status !== 'Siap' ? 'disabled' : ''}>${CATEGORIES.map(c => `<option value="${c}" ${p.category === c ? 'selected' : ''}>${c || '— Kategori otomatis (AI) —'}</option>`).join('')}</select>
        <div class="row" style="margin-top:6px"><button class="small sec" data-act="viewPhoto" data-i="${i}" ${p.blob ? '' : 'disabled'}>LIHAT</button><button class="small sec" data-act="replacePhoto" data-i="${i}">GANTI</button><button class="small sec" data-act="delPhoto" data-i="${i}">HAPUS</button></div>
      </div></div>`).join('')
    : `<div class="empty">Belum ada foto aktual. Tekan GALERI atau KAMERA untuk menambahkan.</div>`}
  </div>
  <div class="card"><h3>Mulai analisis</h3>
    <div class="kv"><span>Jumlah foto</span><b>${photos.length}</b><span>Total ukuran</span><b>${fmtSize(total || 0)}</b>
      <span>DATA ACUAN</span><b>TERKUNCI • ${esc(S.ref.fields.batch)}</b></div>
    ${bad.length ? `<div class="msg bad" style="margin-top:8px">${bad.length} foto bermasalah (${[...new Set(bad.map(p => p.status))].join(', ')}). Ganti atau hapus dulu.</div>` : ''}
    ${!aiConfigured() ? `<div class="msg warn" style="margin-top:8px">AI belum diatur. Buka <a href="#setelan">Setelan</a> dan isi kode akses.</div>` : ''}
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
  const s = S.session; const n = s.photos.length;
  const ok = await modal({ title: 'Pemberitahuan privasi & biaya', ok: 'Mulai analisis',
    body: `<p><b>${n} foto</b> akan dikirim ke <b>Claude (Anthropic)</b> melalui server aplikasi untuk dibaca. Setiap foto dibaca <b>2 kali</b> (double check), jadi ada ${n * 2} permintaan AI.</p>
      <p class="hint">Server aplikasi tidak menyimpan foto. API key tersimpan aman di server, tidak di HP. Biaya pemakaian dicatat dan ditampilkan di hasil.</p>` });
  if (!ok) return;
  s.stages = STAGES.map(x => ({ name: x, status: 'MENUNGGU', note: '' }));
  s.photos.forEach(p => { p.ai = { status: 'menunggu' }; });
  s.result = null; s.verification = emptyVerification(s);
  await saveSession(); go('proses');
  runPipeline();
};

// ================= PROSES =================
const STAGES = ['Validasi referensi', 'Klasifikasi gambar', 'Pembacaan batch', 'Identitas produk', 'Pemeriksaan visual', 'Double check', 'Susun laporan'];
function setStage(i, status, note = '') { S.session.stages[i].status = status; S.session.stages[i].note = note; }
const aiDone = s => !!(s && s.stages && s.photos.length && s.photos.every(p => p.ai && p.ai.status === 'selesai'));
const aiFinished = s => !!(s && s.stages && s.photos.length && s.photos.every(p => p.ai && ['selesai', 'gagal'].includes(p.ai.status)));

async function analyzePhoto(s, p) {
  const ref = s.refSnapshot.fields;
  const refForAi = { produk: ref.produk, brand: ref.brand, varian: ref.varian, apiJaso: ref.apiJaso, volume: ref.volume, kemasan: ref.kemasan }; // tanpa nomor batch
  p.ai = { status: 'diproses' }; refreshProses();
  try {
    const [r1, r2] = await Promise.all([readPhoto(p.blob, refForAi, 1), readPhoto(p.blob, refForAi, 2)]);
    p.ai = { status: 'selesai', read1: r1.data, read2: r2.data, model: r1.model, at: new Date().toISOString() };
    await addUsage(r1.usage, s); await addUsage(r2.usage, s);
  } catch (e) { p.ai = { status: 'gagal', error: e.message }; }
  await saveSession(); refreshProses();
}

async function runPipeline(onlyFailed = false) {
  const s = S.session; if (!s || S.busy) return;
  S.busy = true;
  try {
    const refOk = S.ref && S.ref.id === s.refId && validateBatch(S.ref.fields.batch).valid;
    setStage(0, refOk ? 'SELESAI' : 'GAGAL', refOk ? S.ref.id : 'Acuan tidak aktif / tidak valid');
    await saveSession(); refreshProses();
    if (!refOk) return;
    for (let i = 1; i <= 4; i++) setStage(i, 'PROSES');
    await saveSession(); refreshProses();
    for (const p of s.photos) {
      if (onlyFailed && p.ai && p.ai.status === 'selesai') continue;
      await analyzePhoto(s, p);
    }
    const failed = s.photos.filter(p => p.ai.status === 'gagal');
    const st = failed.length ? 'GAGAL' : 'SELESAI';
    const note = failed.length ? `${failed.length} foto gagal: ${failed[0].ai.error}` : '';
    setStage(1, st, note || 'Kategori dari AI (koreksi petugas diutamakan)');
    setStage(2, st, note); setStage(3, st, note); setStage(4, st, note);
    if (!failed.length) { fillVerificationFromAi(s); finalizeResult(s); }
    await saveSession();
    if (!failed.length) { await db.audit('ANALISIS_AI_SELESAI', { id: s.id, decision: s.result.decision, cost_usd: s.usage && s.usage.cost_usd }); if (location.hash === '#proses') go('hasil'); }
  } finally { S.busy = false; refreshProses(); }
}

routes.proses = async () => {
  const s = S.session;
  if (!s || !s.stages) { view.innerHTML = `<h2>Analisis</h2><div class="empty">Belum ada analisis berjalan.</div><button class="full" data-act="goto" data-h="analisis">KE UPLOAD FOTO</button>`; return; }
  view.innerHTML = `<h2>Analisis Berjalan</h2><p class="sub">${esc(s.id)} • status berdasarkan respons server AI</p><div id="proc"></div>`;
  refreshProses();
};
function refreshProses() {
  const box = document.getElementById('proc'); const s = S.session; if (!box || !s || !s.stages) return;
  const st = s.stages; const failed = s.photos.filter(p => p.ai && p.ai.status === 'gagal');
  const lbl = { menunggu: 'MENUNGGU', diproses: 'PROSES', selesai: 'SELESAI', gagal: 'GAGAL' };
  box.innerHTML = `
  <div class="card"><h3>Tahap analisis</h3>${st.map((x, i) => `<div class="stage"><div><b>${i + 1}. ${esc(x.name)}</b>${x.note ? `<div class="hint">${esc(x.note)}</div>` : ''}</div>${badge(x.status)}</div>`).join('')}</div>
  <div class="card"><h3>Status foto</h3>${s.photos.map(p => `<div class="stage"><div style="flex:1"><b>${photoNo(p.no)}</b> <span class="hint">${esc(p.category || (p.ai && p.ai.read1 && p.ai.read1.kategori) || '')}</span>
     ${p.ai && p.ai.status === 'diproses' ? '<div class="hint">AI membaca 2x… (biasanya 10–40 detik)</div>' : ''}
     ${p.ai && p.ai.status === 'gagal' ? `<div class="hint" style="color:var(--bad)">${esc(p.ai.error)}</div>` : ''}
     ${p.ai && p.ai.status === 'selesai' ? `<div class="hint">Batch terbaca: ${esc(((p.ai.read1.batch_kemunculan || []).map(x => x.teks).join(', ')) || 'tidak ada')}</div>` : ''}
     </div>${badge(p.ai ? lbl[p.ai.status] || p.ai.status : 'MENUNGGU')}</div>`).join('')}</div>
  <div class="card"><h3>Pesan sistem</h3>
    ${s.result ? `<div class="msg info">Laporan sudah disusun.</div><button class="full" data-act="goto" data-h="hasil">LIHAT HASIL QC</button>`
      : `<div class="msg warn">Belum ada keputusan final. Jangan anggap RELEASE sebelum seluruh tahap selesai.</div>`}
    ${failed.length && !S.busy ? `<div class="msg bad">${failed.length} foto gagal dianalisis. Pemeriksaan TIDAK lengkap.${navigator.onLine ? '' : ' Perangkat offline.'}</div>
      <button class="full" data-act="retryAi">COBA LAGI</button>
      <button class="full sec" style="margin-top:8px" data-act="reportWithFailed">SUSUN LAPORAN APA ADANYA (pasti bukan RELEASE)</button>` : ''}
    ${st[0].status === 'GAGAL' ? `<button class="full sec" data-act="goto" data-h="analisis">KEMBALI KE UPLOAD</button>` : ''}
  </div>`;
}
actions.retryAi = () => runPipeline(true);
actions.reportWithFailed = async () => {
  const s = S.session; fillVerificationFromAi(s); finalizeResult(s); await saveSession();
  await db.audit('LAPORAN_DENGAN_FOTO_GAGAL', { id: s.id, decision: s.result.decision }); go('hasil');
};

// ================= ISI DARI AI & TINJAU PETUGAS =================
function emptyVerification(s) {
  return { photos: {}, identity: Object.fromEntries(IDENTITY.map(x => [x.key, { status: '', photo: '', note: '' }])),
    visual: Object.fromEntries(VISUAL.map(x => [x.key, { status: '', critical: true, photo: '', note: '' }])), officer: '', followUp: '', edits: [] };
}
function pv(s, no) { const v = s.verification.photos; if (!v[no]) v[no] = { mode: '', r1: '', r2: '', occ: '', obj: '', note: '' }; return v[no]; }

// Wakil satu foto: bila ada angka terbaca penuh yang berbeda dari acuan → itu (mismatch terbukti);
// bila ada yang tidak terbaca → itu; selain itu nilai pertama.
function representative(list, refBatch) {
  const vals = (list || []).map(x => String(x || '').replace(/\s/g, ''));
  if (!vals.length) return '';
  return vals.find(v => /^\d{8}$/.test(v) && v !== refBatch) || vals.find(v => !/^\d{8}$/.test(v)) || vals[0];
}
const elemOf = (read, group, key) => (read && read[group] && read[group][key]) || {};
// Gabungkan status elemen dari semua foto; status per foto hanya dipakai bila pembacaan 1 dan 2 sama.
function combineElement(s, group, aiKey) {
  const per = s.photos.filter(p => p.ai && p.ai.status === 'selesai').map(p => {
    const a = elemOf(p.ai.read1, group, aiKey), b = elemOf(p.ai.read2, group, aiKey);
    const st = a.status && a.status === b.status ? a.status : STATUS.NOT_READABLE;
    return { no: p.no, status: st, note: [a.terbaca, a.catatan].filter(Boolean).join(' — ') + (a.status !== b.status ? ` [bacaan 1: ${a.status || '-'}, bacaan 2: ${b.status || '-'}]` : '') };
  });
  const pick = st => per.find(x => x.status === st);
  const order = [STATUS.MISMATCH, STATUS.MATCH, STATUS.NOT_READABLE, STATUS.NOT_APPLICABLE, STATUS.NOT_VISIBLE];
  // MISMATCH terbukti mengalahkan semua; MATCH dipakai bila tidak ada MISMATCH; dst.
  for (const st of order) {
    const hit = pick(st);
    if (!hit) continue;
    return { status: st, photo: String(hit.no), note: hit.note };
  }
  return { status: STATUS.NOT_VISIBLE, photo: '', note: 'Tidak ada hasil AI' };
}

function fillVerificationFromAi(s) {
  const v = s.verification = emptyVerification(s); const refBatch = s.refSnapshot.fields.batch;
  for (const p of s.photos) {
    const x = pv(s, p.no);
    if (!p.ai || p.ai.status !== 'selesai') { Object.assign(x, { mode: 'failed', note: p.ai && p.ai.error || 'Analisis gagal' }); continue; }
    const o1 = (p.ai.read1.batch_kemunculan || []).map(o => o.teks), o2 = (p.ai.read2.batch_kemunculan || []).map(o => o.teks);
    if (!p.category && p.ai.read1.kategori) p.aiCategory = p.ai.read1.kategori;
    if (!o1.length && !o2.length) { Object.assign(x, { mode: 'notvisible', note: 'AI: tidak ada nomor batch di foto ini' }); continue; }
    Object.assign(x, { mode: 'visible', r1: representative(o1, refBatch) || '', r2: representative(o2, refBatch) || '',
      occ: String(o1.length), obj: String(p.ai.read1.jumlah_objek_fisik ?? ''), occ2: String(o2.length), obj2: String(p.ai.read2.jumlah_objek_fisik ?? ''),
      note: [p.ai.read1.catatan_hitungan, p.ai.read1.catatan_kualitas].filter(Boolean).join(' — ') });
  }
  IDENTITY.forEach(it => { v.identity[it.key] = combineElement(s, 'identitas', AI_KEYS.identity[it.key]); });
  VISUAL.forEach(it => { v.visual[it.key] = { ...combineElement(s, 'visual', it.key), critical: true }; });
}

function finalizeResult(s) {
  const r = computeResult(s);
  s.result = r;
  const failed = s.photos.filter(p => !p.ai || p.ai.status !== 'selesai').length;
  setStage(2, failed ? 'GAGAL' : r.batch.status === STATUS.MATCH || r.batch.status === STATUS.MISMATCH ? 'TERBACA' : 'TIDAK TERBACA', r.batch.reason);
  setStage(5, r.doubleCheck.every(x => x.consistent) && !r.findings.some(f => f.sev === 'PERLU TINJAU') ? 'SELESAI' : 'PERLU TINJAU');
  setStage(6, 'SELESAI', r.decision);
}

const seg = (path, cur, opts) => `<div class="seg">${opts.map(([val, lab]) => `<button type="button" class="${cur === val ? 'on' : ''}" data-act="seg" data-path="${path}" data-v="${val}">${esc(lab)}</button>`).join('')}</div>`;
const statusSeg = (path, cur) => seg(path, cur, ALL_STATUS.map(x => [x, x === STATUS.NOT_APPLICABLE ? 'N/A' : x]));
const photoSelect = (path, cur, s) => `<select data-path="${path}"><option value="">— Foto bukti —</option>${s.photos.map(p => `<option value="${p.no}" ${String(cur) === String(p.no) ? 'selected' : ''}>${photoNo(p.no)}</option>`).join('')}</select>`;

routes.verifikasi = async () => {
  const s = S.session;
  if (!s || !s.result) { go('proses'); return; }
  const v = s.verification; const ref = s.refSnapshot;
  view.innerHTML = `
  <h2>Tinjau &amp; Koreksi Hasil AI</h2><p class="sub">Ubah hanya bila Anda melihat AI salah. Setiap perubahan dicatat sebagai koreksi petugas. Gunakan <b>?</b> untuk digit yang tidak terbaca.</p>
  <div class="card"><h3>Batch Filling acuan</h3><div style="font:700 22px ui-monospace,monospace;letter-spacing:4px">${esc(ref.fields.batch)}</div></div>
  <div class="card"><h3>A. Batch Filling per foto</h3>
  ${s.photos.map(p => { const x = pv(s, p.no); const occ = (p.ai && p.ai.read1 && p.ai.read1.batch_kemunculan) || []; return `<div class="itm">
    <div class="photo" style="padding:0;border:0"><img src="${url(p.blob)}" data-act="viewPhotoV" data-no="${p.no}" alt="">
      <div><b>${photoNo(p.no)}</b> • ${esc(p.category || p.aiCategory || '-')}<div class="meta">${esc(p.name)}</div>
      <div class="hint">${occ.length ? 'AI: ' + occ.map(o => `${esc(o.teks)} (${esc(o.lokasi)}, ${esc(o.objek)}, yakin ${esc(o.yakin)})`).join('; ') : (x.mode === 'failed' ? 'Analisis gagal' : 'AI: tidak menemukan nomor batch')}</div>
      <button class="small sec" data-act="viewPhotoV" data-no="${p.no}" style="margin-top:4px">LIHAT + ZOOM</button></div></div>
    ${x.mode === 'failed' ? `<div class="msg bad" style="margin-top:6px">${esc(x.note)}</div>` : `
    ${seg(`photos.${p.no}.mode`, x.mode, [['visible', 'Terlihat'], ['notvisible', 'Tidak terlihat'], ['na', 'Tidak relevan']])}
    ${x.mode === 'visible' ? `
      <div class="row"><div><label class="f">Bacaan AI 1</label><input type="text" class="mono" maxlength="8" autocomplete="off" data-path="photos.${p.no}.r1" data-batch value="${esc(x.r1)}"></div>
      <div><label class="f">Bacaan AI 2</label><input type="text" class="mono" maxlength="8" autocomplete="off" data-path="photos.${p.no}.r2" data-batch value="${esc(x.r2)}"></div></div>
      <div class="row"><div><label class="f">Kemunculan</label><input type="number" min="0" inputmode="numeric" data-path="photos.${p.no}.occ" value="${esc(x.occ)}"></div>
        <div><label class="f">Objek fisik</label><input type="number" min="0" inputmode="numeric" data-path="photos.${p.no}.obj" value="${esc(x.obj)}"></div></div>` : ''}
    <label class="f">Catatan</label><input type="text" data-path="photos.${p.no}.note" value="${esc(x.note)}">`}
  </div>`; }).join('')}
  </div>
  <div class="card"><h3>B. Identitas produk</h3>
  ${IDENTITY.map(it => { const x = v.identity[it.key]; const rv = it.ref(ref);
    return `<div class="itm"><b>${esc(it.name)}</b><div class="hint">Acuan: <b>${esc(rv || '(tidak tercantum di acuan)')}</b></div>
    ${statusSeg(`identity.${it.key}.status`, x.status)}
    <div class="row" style="margin-top:6px">${photoSelect(`identity.${it.key}.photo`, x.photo, s)}<input type="text" placeholder="Catatan" data-path="identity.${it.key}.note" value="${esc(x.note)}"></div></div>`; }).join('')}
  </div>
  <div class="card"><h3>C. Pemeriksaan visual</h3><p class="hint">MATCH = sesuai/baik. MISMATCH = tidak sesuai/cacat. N/A = tidak relevan.</p>
  ${VISUAL.map(it => { const x = v.visual[it.key]; return `<div class="itm"><b>${esc(it.name)}</b>
    ${statusSeg(`visual.${it.key}.status`, x.status)}
    <label class="check"><input type="checkbox" data-path="visual.${it.key}.critical" ${x.critical ? 'checked' : ''}> Elemen kritis (MISMATCH → HOLD TOTAL)</label>
    <div class="row">${photoSelect(`visual.${it.key}.photo`, x.photo, s)}<input type="text" placeholder="Catatan" data-path="visual.${it.key}.note" value="${esc(x.note)}"></div></div>`; }).join('')}
  </div>
  <div class="card"><h3>D. Tindak lanjut</h3>
    <label class="f">Temuan tambahan / tindak lanjut</label><textarea data-path="followUp">${esc(v.followUp)}</textarea>
  </div>
  <div id="verErr"></div>
  <button class="full" data-act="buildReport">SIMPAN KOREKSI &amp; HITUNG ULANG</button>`;
  view.querySelectorAll('[data-path]').forEach(el => {
    if (el.tagName === 'BUTTON') return;
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let val = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.batch !== undefined) { val = val.replace(/\s/g, ''); if (val !== el.value) el.value = val; }
      setPath(s.verification, el.dataset.path, val); markEdit(s, el.dataset.path, val); saveSoon(saveSession);
    });
  });
};
function markEdit(s, path, val) {
  const e = s.verification.edits || (s.verification.edits = []);
  const last = e[e.length - 1];
  if (last && last.path === path) { last.to = val; last.at = new Date().toISOString(); } else e.push({ path, to: val, at: new Date().toISOString() });
}
actions.viewPhotoV = b => { const p = S.session.photos.find(x => x.no === +b.dataset.no); viewer(p.blob, photoNo(p.no)); };
actions.seg = async b => {
  const y = scrollY; setPath(S.session.verification, b.dataset.path, b.dataset.v); markEdit(S.session, b.dataset.path, b.dataset.v);
  await saveSession(); await render(); scrollTo(0, y);
};

function verificationErrors(s) {
  const v = s.verification; const errs = [];
  s.photos.forEach(p => {
    const x = pv(s, p.no);
    if (x.mode === 'failed') return;
    if (!x.mode) errs.push(`${photoNo(p.no)}: pilih apakah batch terlihat`);
    if (x.mode === 'visible') {
      ['r1', 'r2'].forEach((k, i) => { if (!/^[0-9?]{8}$/.test(x[k] || '')) errs.push(`${photoNo(p.no)}: bacaan ${i + 1} harus 8 karakter (angka atau ?)`); });
    }
  });
  IDENTITY.forEach(it => { if (!v.identity[it.key].status) errs.push(`Identitas "${it.name}": pilih status`); });
  VISUAL.forEach(it => { if (!v.visual[it.key].status) errs.push(`Visual "${it.name}": pilih status`); });
  return errs;
}

// ---------- susun hasil (keputusan dihitung oleh qc-core) ----------
function computeResult(s) {
  const v = s.verification; const ref = s.refSnapshot; const refBatch = ref.fields.batch;
  const perPhoto = []; const dc = []; const review = [];
  for (const p of s.photos) {
    const x = pv(s, p.no);
    const row = { no: p.no, category: p.category || p.aiCategory || '', mode: x.mode, r1: x.r1, r2: x.r2, occ: x.occ, obj: x.obj, note: x.note,
      occurrences: (p.ai && p.ai.read1 && p.ai.read1.batch_kemunculan) || [] };
    if (x.mode === 'failed') { row.status = STATUS.NOT_READABLE; row.reason = 'Analisis foto gagal: ' + x.note; }
    else if (x.mode === 'na') { row.status = STATUS.NOT_APPLICABLE; row.reason = 'Batch tidak relevan untuk foto ini'; }
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
      let cnote = '';
      if (x.occ2 !== undefined && (x.occ2 !== x.occ || x.obj2 !== x.obj)) { cnote = `Hitungan bacaan 1: ${x.occ} kemunculan/${x.obj} objek; bacaan 2: ${x.occ2}/${x.obj2}`; review.push(`${photoNo(p.no)}: hitungan kemunculan berbeda antar bacaan`); }
      dc.push({ no: p.no, first: x.r1, second: x.r2, consistent: rc.consistent, note: cnote || 'Hitungan konsisten' });
    }
    perPhoto.push(row);
  }
  const batchStatus = aggregateBatch(perPhoto);
  const show = perPhoto.find(r => r.status === STATUS.MISMATCH) || perPhoto.find(r => r.status === STATUS.NOT_READABLE && r.positions) || perPhoto.find(r => r.status === STATUS.MATCH);
  const actualDisplay = show ? (show.value || [show.r1, show.r2].join(' / ')) : '-';
  const batchReason = show ? show.reason : (perPhoto.find(r => r.mode === 'failed') ? 'Ada foto yang gagal dianalisis' : 'Batch Filling tidak terlihat pada foto mana pun');

  const identity = IDENTITY.map(it => { const x = v.identity[it.key]; const rv = it.ref(ref);
    return { key: it.key, name: it.name, ref: rv || '', status: x.status, photo: x.photo, note: x.note, required: true, critical: true }; });
  const visual = VISUAL.map(it => { const x = v.visual[it.key]; return { key: it.key, name: it.name, status: x.status, photo: x.photo, note: x.note, required: true, critical: !!x.critical }; });

  const elements = [{ name: 'Batch Filling', status: batchStatus, required: true, critical: true, note: batchReason },
    ...identity.map(e => ({ ...e, name: 'Identitas: ' + e.name })), ...visual.map(e => ({ ...e, name: 'Visual: ' + e.name }))];
  const failed = s.photos.filter(p => !p.ai || p.ai.status !== 'selesai').length;
  const fileBad = s.photos.filter(p => p.status !== 'Siap').length;
  const meta = { referenceLocked: !!(S.ref && S.ref.id === s.refId), photosTotal: s.photos.length, photosFailed: failed + fileBad,
    analysisComplete: verificationErrors(s).length === 0 && failed === 0 };
  const d = decide(elements, meta);

  const counts = perPhoto.map(r => ({ no: r.no, occ: r.occ, obj: r.obj, value: r.value || '', occurrences: r.occurrences }));
  const findings = [];
  for (const e of elements) {
    if (e.status === STATUS.MATCH || e.status === STATUS.NOT_APPLICABLE) continue;
    if (e.status === STATUS.MISMATCH) findings.push({ sev: e.critical ? 'KRITIS' : 'NON-KRITIS', text: `${e.name}: MISMATCH${e.note ? ' — ' + e.note : ''}`, action: e.critical ? 'Tahan/karantina batch; investigasi sumber ketidaksesuaian' : 'Catat dan tinjau oleh supervisor' });
    else findings.push({ sev: 'BUKTI KURANG', text: `${e.name}: ${e.status}${e.note ? ' — ' + e.note : ''}`, action: e.status === STATUS.NOT_VISIBLE ? 'Tambahkan foto yang memperlihatkan elemen ini, atau tandai N/A bila memang tidak relevan' : 'Ambil foto close-up ulang dengan pencahayaan lebih baik' });
  }
  review.forEach(u => findings.push({ sev: 'PERLU TINJAU', text: u, action: 'Periksa foto; koreksi hitungan bila perlu' }));
  (s.photos || []).forEach(p => (p.ai && p.ai.read1 && p.ai.read1.temuan || []).forEach(t => findings.push({ sev: 'CATATAN AI', text: `${photoNo(p.no)}: ${t}`, action: 'Tinjau oleh petugas' })));
  return { ...d, computedAt: new Date().toISOString(), meta, model: (s.photos.find(p => p.ai && p.ai.model) || {}).ai?.model || '',
    edits: (v.edits || []).length,
    batch: { ref: refBatch, actual: actualDisplay, status: batchStatus, reason: batchReason, positions: show && show.positions ? show.positions : [], perPhoto },
    identity, visual, counts, doubleCheck: dc, findings,
    totals: { occ: counts.reduce((a, c) => a + (+c.occ || 0), 0), obj: counts.reduce((a, c) => a + (+c.obj || 0), 0), unique: [...new Set(perPhoto.filter(r => r.value).map(r => r.value))] } };
}

actions.buildReport = async () => {
  const s = S.session; const errs = verificationErrors(s);
  const box = document.getElementById('verErr');
  if (errs.length) { box.innerHTML = `<div class="msg bad"><b>Belum lengkap (${errs.length}):</b><br>${errs.slice(0, 12).map(esc).join('<br>')}</div>`; box.scrollIntoView({ behavior: 'smooth' }); return; }
  finalizeResult(s);
  await saveSession(); await db.audit('HASIL_DIHITUNG_ULANG', { id: s.id, decision: s.result.decision, edits: (s.verification.edits || []).length });
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
      <span>Model AI</span><b>${esc(r.model || '-')}</b><span>Biaya AI sesi</span><b>${s.usage ? fmtCost(s.usage.cost_usd) + ' • ' + s.usage.calls + ' permintaan' : '-'}</b>
      <span>Koreksi petugas</span><b>${r.edits ? r.edits + ' perubahan' : 'tidak ada'}</b>
      ${s.revisionNote ? `<span>Alasan revisi</span><b>${esc(s.revisionNote)}</b>` : ''}</div>`),
    sec('B. Referensi terkunci', `<img class="preview" src="${url(ref.image)}" alt="DATA ACUAN"><div class="kv" style="margin-top:8px">
      <span>ID acuan</span><b>${esc(ref.id)}</b><span>Waktu lock</span><b>${fmtTime(ref.lockedAt)}</b><span>Batch Filling</span><b style="font-family:monospace">${esc(f.batch)}</b>
      ${REF_FIELDS.map(x => `<span>${esc(x.label)}</span><b>${esc(ref.unreadable[x.key] ? '(tidak terbaca)' : f[x.key] || '-')}</b>`).join('')}</div>`),
    sec('C. Identitas produk', tbl(['Elemen', 'Acuan', 'Status', 'Bukti', 'Catatan'], r.identity.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.ref || '-')}</td><td>${badge(e.status)}</td><td>${ph(e.photo)}</td><td>${esc(e.note)}</td></tr>`))),
    sec('D. Batch Filling', `<div class="kv"><span>Acuan</span><b style="font-family:monospace">${esc(r.batch.ref)}</b><span>Aktual</span><b style="font-family:monospace">${esc(r.batch.actual)}</b><span>Status</span><b>${badge(r.batch.status)}</b></div>
      <div class="hint">${esc(r.batch.reason)}</div>${digitsHtml(r.batch)}
      <div style="margin-top:10px">${tbl(['Foto', 'Bacaan', 'Status', 'Keterangan'], r.batch.perPhoto.map(x => `<tr><td>${ph(x.no)}</td><td style="font-family:monospace">${esc(x.value || (x.mode === 'visible' ? x.r1 + ' / ' + x.r2 : '-'))}</td><td>${badge(x.status)}</td><td>${esc(x.reason)}</td></tr>`))}</div>`),
    sec('E. Pemeriksaan foto', `${tbl(['Foto', 'Kategori', 'File', 'Kualitas', 'Status AI'], s.photos.map(p => `<tr><td>${ph(p.no)}</td><td>${esc(p.category || p.aiCategory || '-')}${p.category ? ' <span class="hint">(petugas)</span>' : ''}</td><td>${esc(p.name)}<br><span class="hint">${fmtSize(p.size)}</span></td><td>${esc(p.ai && p.ai.read1 ? p.ai.read1.kualitas + (p.ai.read1.catatan_kualitas ? ' — ' + p.ai.read1.catatan_kualitas : '') : '-')}</td><td>${p.ai ? esc(p.ai.status) + (p.ai.error ? ': ' + esc(p.ai.error) : '') : '-'}</td></tr>`))}
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:8px">${s.photos.map(p => `<figure style="margin:0"><img src="${url(p.blob)}" style="width:100%;border-radius:6px" alt=""><figcaption class="hint">${ph(p.no)}</figcaption></figure>`).join('')}</div>
      <div style="margin-top:8px">${tbl(['Elemen visual', 'Status', 'Kritis', 'Bukti', 'Catatan'], r.visual.map(e => `<tr><td>${esc(e.name)}</td><td>${badge(e.status)}</td><td>${e.critical ? 'Ya' : 'Tidak'}</td><td>${ph(e.photo)}</td><td>${esc(e.note)}</td></tr>`))}</div>`),
    sec('F. Hitungan batch', `${tbl(['Foto', 'Kemunculan', 'Objek fisik', 'Nilai', 'Rincian'], r.counts.map(c => `<tr><td>${ph(c.no)}</td><td>${esc(c.occ || '-')}</td><td>${esc(c.obj || '-')}</td><td style="font-family:monospace">${esc(c.value || '-')}</td><td>${(c.occurrences || []).map(o => `${esc(o.teks)} — ${esc(o.lokasi)}, ${esc(o.objek)}`).join('<br>') || '-'}</td></tr>`))}
      <div class="kv" style="margin-top:8px"><span>Total kemunculan</span><b>${r.totals.occ}</b><span>Total objek fisik</span><b>${r.totals.obj}</b><span>Nilai unik</span><b style="font-family:monospace">${esc(r.totals.unique.join(', ') || '-')}</b></div>
      <p class="hint">Keterbatasan: Hitungan dari AI (bacaan 1) dan dapat dikoreksi petugas; pantulan/duplikat pada benda yang sama tidak dihitung sebagai objek tambahan.</p>`),
    sec('G. Double check', r.doubleCheck.length ? tbl(['Foto', 'Bacaan 1', 'Bacaan 2', 'Konsisten', 'Catatan'], r.doubleCheck.map(x => `<tr><td>${ph(x.no)}</td><td style="font-family:monospace">${esc(x.first)}</td><td style="font-family:monospace">${esc(x.second)}</td><td>${x.consistent ? badge('YA') : badge('TIDAK')}</td><td>${esc(x.note)}</td></tr>`)) : '<div class="hint">Tidak ada pembacaan batch.</div>'),
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
  <div class="msg info">Dibaca oleh AI (${esc(r.model || '-')}), masing-masing foto 2x. ${r.edits ? `<b>${r.edits} koreksi petugas</b>.` : 'Belum ada koreksi petugas.'} Biaya sesi: ${s.usage ? fmtCost(s.usage.cost_usd) : '-'}.</div>
  <div class="card"><h3>Batch Filling</h3><div class="kv"><span>Acuan</span><b style="font-family:monospace">${esc(r.batch.ref)}</b><span>Aktual</span><b style="font-family:monospace">${esc(r.batch.actual)}</b><span>Status</span><b>${badge(r.batch.status)}</b></div>${digitsHtml(r.batch)}</div>
  <div class="card"><h3>Identitas produk</h3>${r.identity.map(e => `<div class="srow" style="padding:3px 0"><span>${esc(e.name)}</span>${badge(e.status)}</div>`).join('')}</div>
  <div class="card"><h3>Tindakan</h3>
    <div class="row"><button class="sec" data-act="toggleDetail">DETAIL HASIL</button><button class="sec" data-act="exportPdf" data-k="${esc(s.key)}">EKSPOR PDF</button></div>
    <div class="row" style="margin-top:8px"><button class="sec" data-act="goto" data-h="verifikasi">TINJAU / KOREKSI</button><button class="sec" data-act="redo">ULANGI ANALISIS</button></div>
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
  if (!await modal({ title: 'Ulangi analisis?', body: '<p>Semua foto akan dikirim ulang ke AI dan hasil serta koreksi saat ini dihapus. Ini memakai kuota/biaya API lagi.</p>', ok: 'Ulangi' })) return;
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
  const usage = (await db.kvGet('usageTotal')) || { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
  view.innerHTML = `<h2>Pengaturan</h2><p class="sub">Informasi layanan dan privasi</p>
  <div class="card"><h3>Status aplikasi</h3><div class="kv"><span>Versi aplikasi</span><b>${APP_VERSION}</b>
    <span>Backend</span><b>${!apiBase() ? badge('BELUM DIATUR') : S_ai.status === 'ok' ? badge('AKTIF') : S_ai.status === 'error' ? badge('GAGAL') : badge('BELUM DICEK')}</b>
    <span>Internet</span><b>${navigator.onLine ? badge('ONLINE') : badge('OFFLINE')}</b></div>
    ${S_ai.status === 'error' ? `<div class="msg bad" style="margin-top:8px">${esc(S_ai.error)}</div>` : ''}</div>
  <div class="card"><h3>Informasi API</h3><div class="kv"><span>Koneksi</span><b>${S_ai.status === 'ok' ? badge('AKTIF') : S_ai.status === 'error' ? badge('ERROR') : '-'}</b>
    <span>Server</span><b style="word-break:break-all">${esc(apiBase() || '(belum diatur)')}</b><span>Model AI</span><b>${esc(S_ai.model || '-')}</b>
    <span>API key</span><b>Tersimpan di server, tidak pernah ditampilkan</b></div>
    <label class="f">Kode akses aplikasi</label><input type="text" id="passIn" autocomplete="off" placeholder="${getPasscode() ? '•••••••• (tersimpan)' : 'Masukkan kode akses'}">
    <div class="row" style="margin-top:8px"><button data-act="savePass">SIMPAN &amp; TES KONEKSI</button>${getPasscode() ? '<button class="sec" data-act="clearPass">HAPUS KODE</button>' : ''}</div>
    <p class="hint">Kode akses mencegah orang lain memakai server AI Anda. Ini bukan API key.</p></div>
  <div class="card"><h3>Biaya AI</h3><div class="kv"><span>Total permintaan</span><b>${usage.calls}</b><span>Token masuk / keluar</span><b>${usage.input_tokens.toLocaleString('id-ID')} / ${usage.output_tokens.toLocaleString('id-ID')}</b>
    <span>Estimasi biaya total</span><b>${fmtCost(usage.cost_usd)}</b><span>Tarif dipakai</span><b>${S_ai.price ? `$${S_ai.price.in} / $${S_ai.price.out} per 1 juta token (masuk/keluar)` : '-'}</b></div>
    <p class="hint">Estimasi dari jumlah token. Tagihan resmi ada di console Anthropic. Hosting (GitHub Pages & Cloudflare Workers paket gratis) Rp0.</p></div>
  <div class="card"><h3>Privasi & data</h3><div class="kv"><span>Gambar dikirim ke AI?</span><b>YA, saat Anda menekan BACA/ANALISIS dan menyetujui</b>
    <span>Penyedia AI</span><b>Anthropic (Claude API)</b><span>Data dikirim</span><b>Foto (diperkecil maks 1568 px) + identitas produk acuan. Nomor batch acuan TIDAK dikirim.</b>
    <span>Tujuan</span><b>Membaca teks/angka & memeriksa visual untuk QC</b>
    <span>Server aplikasi</span><b>Hanya meneruskan; tidak menyimpan foto</b><span>Retensi di Anthropic</span><b>Sesuai kebijakan data API Anthropic</b></div></div>
  <div class="card"><h3>Penyimpanan</h3><div class="kv"><span>Mode</span><b>Lokal (IndexedDB di Chrome)</b>
    <span>Terpakai</span><b>${est ? fmtSize(est.usage || 0) : '-'}</b><span>Penyimpanan permanen</span><b>${persisted ? badge('AKTIF') : badge('BELUM')}</b>
    <span>Sesi tersimpan</span><b>${sessions.filter(s => s.status === 'final').length}</b><span>Acuan tersimpan</span><b>${refs.length}</b>
    <span>Sinkronisasi cloud</span><b>Tidak ada</b></div>
    <p class="hint">Riwayat, foto, dan acuan disimpan di HP sampai Anda menghapusnya. Data hilang bila data situs Chrome dihapus, aplikasi di-uninstall, atau HP rusak/diganti. Pemulihan hanya dari file cadangan.</p>
    ${!persisted ? '<button class="full sec" data-act="persist">MINTA PENYIMPANAN PERMANEN</button>' : ''}
    <div class="row" style="margin-top:8px"><button data-act="backup">EKSPOR CADANGAN</button><button class="sec" data-act="restore">PULIHKAN CADANGAN</button></div>
    <input type="file" id="restoreFile" accept="application/json,.json" class="hidden"></div>
  <div class="card"><h3>Aturan keputusan (terkunci)</h3>
    <div class="kv"><span>${badge('RELEASE')}</span><b>Semua elemen wajib yang relevan terbaca, terverifikasi, dan sesuai.</b>
    <span>${badge('HOLD')}</span><b>Bukti kritis tidak terbaca, tidak terlihat, ambigu, atau analisis belum lengkap.</b>
    <span>${badge('HOLD TOTAL')}</span><b>Ketidaksesuaian kritis terbukti, termasuk Batch Filling berbeda.</b></div>
    <p class="hint">Aturan tertanam di kode dan tidak dapat diubah dari aplikasi. AI hanya membaca; keputusan dihitung oleh aturan ini.</p></div>
  <div class="card"><h3>Log audit (terbaru)</h3>${audit.length ? audit.map(a => `<div class="itm"><b>${esc(a.event)}</b> <span class="hint">${fmtTime(a.at)}</span><div class="hint">${esc(JSON.stringify(a.detail))}</div></div>`).join('') : '<div class="empty">Belum ada aktivitas.</div>'}</div>
  <div class="card"><h3>Tentang aplikasi</h3><p style="font-size:14px">QC BATCH RELEASE adalah alat bantu inspeksi. AI dapat salah membaca angka yang blur, emboss bertekstur rendah, pantulan cahaya, atau objek yang tumpang tindih. Karena itu setiap foto dibaca 2 kali, digit yang ragu ditandai "?", dan keraguan selalu menghasilkan HOLD. Petugas QC meninjau dan memegang otoritas persetujuan akhir.</p>
    <button class="full danger" data-act="wipe">HAPUS SEMUA DATA</button></div>`;
};
actions.savePass = async () => {
  const v = document.getElementById('passIn').value.trim();
  if (v) setPasscode(v);
  if (!getPasscode()) { toast('Isi kode akses dulu.', 'bad'); return; }
  S_ai.status = 'unknown'; await checkAi();
  toast(S_ai.status === 'ok' ? 'Terhubung ke server AI.' : 'Gagal: ' + S_ai.error, S_ai.status === 'ok' ? 'ok' : 'bad'); render();
};
actions.clearPass = async () => { setPasscode(''); S_ai.status = 'unknown'; toast('Kode akses dihapus dari HP ini.'); render(); };
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
  render(); checkAi();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
window.__QC = { S, computeResult };
