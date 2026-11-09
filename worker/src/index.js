// QC BATCH RELEASE — server AI (Cloudflare Worker).
// Tugas: menyimpan API key, memeriksa kode akses, memanggil Claude untuk MEMBACA gambar,
// dan mengembalikan hasil bacaan terstruktur. Server ini TIDAK membuat keputusan RELEASE/HOLD
// dan TIDAK menyimpan foto.

const STATUS_ENUM = ['MATCH', 'MISMATCH', 'NOT READABLE', 'NOT VISIBLE', 'NOT APPLICABLE'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const REF_TOOL = {
  name: 'laporkan_data_acuan',
  description: 'Laporkan isi tabel DATA ACUAN persis seperti tertulis.',
  input_schema: {
    type: 'object',
    properties: {
      jumlah_baris_data: { type: 'integer', description: 'Jumlah baris data produk yang terlihat di tabel' },
      produk: { type: 'string', description: 'Nama produk persis seperti tertulis (tanpa ukuran kemasan). Kosong bila tidak ada/tidak terbaca.' },
      brand: { type: 'string', description: 'Merek HANYA jika tertulis di tabel. Kosong bila tidak tertulis.' },
      varian: { type: 'string', description: 'Viskositas/grade, mis. 20W-40. Kosong bila tidak tertulis.' },
      api_jaso: { type: 'string', description: 'Spesifikasi API/JASO, mis. "API SL, JASO MB". Kosong bila tidak tertulis.' },
      volume: { type: 'string', description: 'Volume isi per unit, mis. "0,8 L". Kosong bila tidak tertulis.' },
      kemasan: { type: 'string', description: 'Konfigurasi kemasan, mis. "6 x 0,8 L". Kosong bila tidak tertulis.' },
      batch_filling: { type: 'string', description: 'Nilai kolom Batch Filling, 8 karakter. Ganti digit yang tidak pasti dengan "?". Kosong bila kolom tidak ada.' },
      batch_blending: { type: 'string', description: 'Nilai kolom Batch Blending bila ada (hanya dicatat, tidak dipakai).' },
      catatan: { type: 'string', description: 'Info lain yang terbaca jelas: tanggal, line, kode material, tangki.' },
      tidak_terbaca: { type: 'array', items: { type: 'string' }, description: 'Nama field yang ada tetapi tidak terbaca pasti.' },
      ambigu: { type: 'array', items: { type: 'string' }, description: 'Keraguan, mis. lebih dari satu baris, kolom terpotong.' },
    },
    required: ['jumlah_baris_data', 'produk', 'batch_filling', 'tidak_terbaca', 'ambigu'],
  },
};

const elemStatus = { type: 'object', properties: { status: { type: 'string', enum: STATUS_ENUM }, terbaca: { type: 'string', description: 'Teks/kondisi yang benar-benar terlihat' }, catatan: { type: 'string' } }, required: ['status'] };
const PHOTO_TOOL = {
  name: 'laporkan_foto_qc',
  description: 'Laporkan hasil pembacaan satu foto produk aktual.',
  input_schema: {
    type: 'object',
    properties: {
      kategori: { type: 'string', enum: ['Emboss', 'Label', 'Karton', 'Printer', 'Lainnya'] },
      kualitas: { type: 'string', enum: ['baik', 'cukup', 'buruk'] },
      catatan_kualitas: { type: 'string' },
      batch_kemunculan: {
        type: 'array',
        description: 'SETIAP cetakan nomor batch 8 digit yang terlihat (emboss/inkjet/cetak). Kosong bila tidak ada.',
        items: { type: 'object', properties: {
          teks: { type: 'string', description: 'Tepat 8 karakter seperti terlihat; "?" untuk digit yang tidak pasti.' },
          lokasi: { type: 'string', description: 'mis. ring tutup, leher botol, sisi karton' },
          objek: { type: 'string', description: 'Benda fisik tempat angka ini, mis. "botol kiri". Cetakan berbeda pada benda yang sama → objek sama.' },
          yakin: { type: 'string', enum: ['tinggi', 'sedang', 'rendah'] },
        }, required: ['teks', 'lokasi', 'objek', 'yakin'] },
      },
      angka_lain_8_digit: { type: 'array', items: { type: 'string' }, description: 'Angka 8 digit lain yang jelas BUKAN batch filling (mis. Batch Blending berlabel), bila ada.' },
      jumlah_objek_fisik: { type: 'integer', description: 'Jumlah benda fisik berbeda yang membawa nomor batch. Pantulan/bayangan/cetakan ganda pada benda sama TIDAK dihitung.' },
      catatan_hitungan: { type: 'string' },
      identitas: { type: 'object', properties: { nama: elemStatus, varian: elemStatus, api_jaso: elemStatus, volume: elemStatus, kemasan: elemStatus }, required: ['nama', 'varian', 'api_jaso', 'volume', 'kemasan'] },
      visual: { type: 'object', properties: { label: elemStatus, emboss: elemStatus, tutup: elemStatus, printer: elemStatus, karton: elemStatus, sticker: elemStatus, qr: elemStatus }, required: ['label', 'emboss', 'tutup', 'printer', 'karton', 'sticker', 'qr'] },
      temuan: { type: 'array', items: { type: 'string' } },
    },
    required: ['kategori', 'kualitas', 'batch_kemunculan', 'jumlah_objek_fisik', 'identitas', 'visual'],
  },
};

const RULES = `Anda adalah pemeriksa visual QC produk pelumas. Aturan mutlak:
- ZERO ASSUMPTION: laporkan hanya yang benar-benar terlihat. Jangan menebak, jangan melengkapi, jangan mengoreksi berdasarkan "seharusnya".
- Digit yang tidak pasti WAJIB ditulis "?". Lebih baik "?" daripada salah.
- Jangan menyimpulkan status dari pengetahuan umum produk; hanya dari bukti foto.
- Gunakan tool yang disediakan untuk menjawab.`;

function photoPrompt(ref, pass) {
  const r = ref || {};
  return `${pass === 2
    ? 'PEMBACAAN ULANG INDEPENDEN: abaikan kesan pertama. Untuk setiap nomor batch, baca digit SATU PER SATU dari kiri ke kanan, perhatikan bentuk tiap angka (0/8/6/9, 1/7, 3/8, 5/6).'
    : 'PEMBACAAN PERTAMA: periksa seluruh foto dengan teliti.'}

Nilai identitas DATA ACUAN (pembanding untuk bagian identitas saja):
- Nama produk: ${r.produk || '(tidak ada)'}${r.brand ? ` | Brand: ${r.brand}` : ''}
- Varian/grade: ${r.varian || '(tidak ada)'}
- API/JASO: ${r.apiJaso || '(tidak ada)'}
- Volume: ${r.volume || '(tidak ada)'}
- Kemasan: ${r.kemasan || '(tidak ada)'}

Petunjuk status:
- MATCH: terbaca jelas dan sama dengan acuan (satuan setara boleh, mis. 800 ml = 0,8 L).
- MISMATCH: terbaca jelas dan BERBEDA dari acuan, atau (untuk visual) ada cacat/kerusakan nyata.
- NOT READABLE: ada tetapi tidak bisa dibaca pasti.
- NOT VISIBLE: elemen tidak tampak di foto ini.
- NOT APPLICABLE: elemen memang tidak ada pada benda yang difoto (mis. tidak ada sticker sama sekali pada botol yang terlihat utuh), atau acuan bernilai "(tidak ada)".
- Visual MATCH berarti elemen terlihat dan kondisinya baik/sesuai (label rapi, emboss utuh, tutup tersegel, dsb).
- Nomor batch: catat setiap kemunculan. Nomor batch acuan TIDAK diberikan kepada Anda; baca apa adanya.`;
}

function json(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });
}

function corsHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-app-key', 'access-control-max-age': '86400', vary: 'origin' };
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function callClaude(env, { system, image, mediaType, text, tool }) {
  const base = {
    model: env.MODEL || 'claude-sonnet-5-5',
    max_tokens: 4096,
    system,
    tools: [tool],
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text },
    ] }],
  };
  const send = async body => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 100000);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 504, data: { error: { message: e.name === 'AbortError' ? 'Waktu habis menunggu AI' : e.message } } };
    } finally { clearTimeout(t); }
  };
  let res = await send({ ...base, tool_choice: { type: 'tool', name: tool.name } });
  // Beberapa model tidak mengizinkan tool_choice paksa (mis. saat thinking aktif) → ulangi dengan auto.
  if (!res.ok && res.status === 400 && /tool_choice|thinking/i.test(JSON.stringify(res.data))) {
    res = await send({ ...base, tool_choice: { type: 'auto' }, system: system + '\nWAJIB menjawab dengan memanggil tool ' + tool.name + '.' });
  }
  if (!res.ok) {
    const msg = res.data?.error?.message || `HTTP ${res.status}`;
    const e = new Error(`AI gagal: ${msg}`); e.status = res.status === 429 ? 429 : 502; throw e;
  }
  const block = (res.data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  let input = block?.input;
  if (!input) {
    const txt = (res.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = txt.match(/\{[\s\S]*\}/);
    try { input = m ? JSON.parse(m[0]) : null; } catch { input = null; }
  }
  if (!input) { const e = new Error('AI tidak mengembalikan hasil terstruktur'); e.status = 502; throw e; }
  const u = res.data.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const cost = inTok / 1e6 * Number(env.PRICE_IN_PER_MTOK || 0) + outTok / 1e6 * Number(env.PRICE_OUT_PER_MTOK || 0);
  return { data: input, usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: Math.round(cost * 1e6) / 1e6 }, model: res.data.model || base.model };
}

function checkImage(body) {
  const { image, mediaType } = body || {};
  if (typeof image !== 'string' || !image) return 'Gambar tidak ada';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) return 'Format gambar tidak didukung';
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return 'Gambar terlalu besar (maks 5 MB)';
  return null;
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '' || path === '/') return json({ app: 'QC BATCH RELEASE API', ok: true }, 200, cors);
    if (!env.APP_PASSCODE || !env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'Server belum dikonfigurasi (secret ANTHROPIC_API_KEY / APP_PASSCODE belum diisi)' }, 503, cors);
    if (!timingSafeEqual(req.headers.get('x-app-key') || '', env.APP_PASSCODE)) return json({ ok: false, error: 'Kode akses salah' }, 401, cors);

    try {
      if (path === '/api/health' && req.method === 'GET') return json({ ok: true, model: env.MODEL, price: { in: Number(env.PRICE_IN_PER_MTOK), out: Number(env.PRICE_OUT_PER_MTOK) } }, 200, cors);
      if (req.method !== 'POST') return json({ ok: false, error: 'Metode tidak didukung' }, 405, cors);
      const len = Number(req.headers.get('content-length') || 0);
      if (len > 8 * 1024 * 1024) return json({ ok: false, error: 'Permintaan terlalu besar' }, 413, cors);
      const body = await req.json().catch(() => null);
      const bad = checkImage(body); if (bad) return json({ ok: false, error: bad }, 400, cors);

      if (path === '/api/reference') {
        const r = await callClaude(env, { system: RULES, image: body.image, mediaType: body.mediaType, tool: REF_TOOL,
          text: 'Ini gambar tabel DATA ACUAN. Baca baris data produk. Salin nilai persis; jangan menebak. Batch Filling dan Batch Blending adalah kolom berbeda — jangan tertukar.' });
        return json({ ok: true, ...r }, 200, cors);
      }
      if (path === '/api/photo') {
        const pass = body.pass === 2 ? 2 : 1;
        const r = await callClaude(env, { system: RULES, image: body.image, mediaType: body.mediaType, tool: PHOTO_TOOL, text: photoPrompt(body.ref, pass) });
        return json({ ok: true, pass, ...r }, 200, cors);
      }
      return json({ ok: false, error: 'Alamat tidak dikenal' }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: e.message || 'Kesalahan server' }, e.status || 500, cors);
    }
  },
};
