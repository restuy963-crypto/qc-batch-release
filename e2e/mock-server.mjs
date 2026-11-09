// Server uji lokal: menjalankan kode worker ASLI, hanya panggilan ke Anthropic yang ditiru.
import http from 'node:http';
import worker from '../worker/src/index.js';

const env = { APP_PASSCODE: 'uji-kode-123', ANTHROPIC_API_KEY: 'sk-mock', MODEL: 'claude-sonnet-5-5', ALLOWED_ORIGINS: 'http://localhost:8765', PRICE_IN_PER_MTOK: '2', PRICE_OUT_PER_MTOK: '10' };
let scenario = 'A', photoCalls = 0, failOnce = false;
const st = (status, terbaca = '') => ({ status, terbaca });
const ident = { nama: st('MATCH', 'PERTAMINA Enduro MATIC-G'), varian: st('MATCH', '20W-40'), api_jaso: st('MATCH', 'API SL, JASO MB'), volume: st('MATCH', '0,8L / 800ml'), kemasan: st('NOT VISIBLE') };
const embossVisual = { label: st('NOT VISIBLE'), emboss: st('MATCH', 'emboss utuh'), tutup: st('MATCH', 'tutup tersegel'), printer: st('NOT APPLICABLE'), karton: st('NOT VISIBLE'), sticker: st('NOT APPLICABLE'), qr: st('NOT VISIBLE') };
const labelVisual = { label: st('MATCH', 'label rapi'), emboss: st('NOT READABLE'), tutup: st('MATCH'), printer: st('NOT APPLICABLE'), karton: st('NOT VISIBLE'), sticker: st('NOT APPLICABLE'), qr: st('MATCH', 'QR terlihat') };
function photoData(idx, pass) {
  if (idx === 0) {
    let t = '09173261';
    if (scenario === 'B' && pass === 2) t = '09178261';
    if (scenario === 'C') t = '09173262';
    return { kategori: 'Emboss', kualitas: 'baik', batch_kemunculan: [{ teks: t, lokasi: 'ring tutup', objek: 'botol 1', yakin: 'tinggi' }, { teks: t, lokasi: 'leher botol', objek: 'botol 1', yakin: 'tinggi' }],
      jumlah_objek_fisik: 1, catatan_hitungan: 'Dua cetakan pada botol yang sama', identitas: { ...ident, nama: st('NOT VISIBLE'), varian: st('NOT VISIBLE'), api_jaso: st('NOT VISIBLE'), volume: st('NOT VISIBLE') }, visual: embossVisual, temuan: [] };
  }
  return { kategori: 'Label', kualitas: 'cukup', batch_kemunculan: [], jumlah_objek_fisik: 0, identitas: ident, visual: labelVisual, temuan: [] };
}
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); const tool = body.tools[0].name;
  await new Promise(r => setTimeout(r, 150));
  if (tool === 'laporkan_data_acuan') {
    return new Response(JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 2100, output_tokens: 300 }, content: [{ type: 'tool_use', name: tool, input: {
      jumlah_baris_data: 1, produk: 'ENDURO MATIC G 20W-40 SL/JASO MB, 6X0,8L', brand: '', varian: '20W-40', api_jaso: 'API SL, JASO MB', volume: '0,8 L', kemasan: '6 x 0,8 L',
      batch_filling: '09173261', batch_blending: '09144261', catatan: 'Tgl 2026-11-09, Line FL02, Kimap A070207513', tidak_terbaca: [], ambigu: [] } }] }), { status: 200 });
  }
  const idx = Math.floor(photoCalls / 2); photoCalls++;
  const pass = body.messages[0].content[1].text.includes('ULANG') ? 2 : 1;
  if (failOnce && idx === 1) { failOnce = false; return new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 529 }); }
  return new Response(JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 3200, output_tokens: 700 }, content: [{ type: 'tool_use', name: tool, input: photoData(idx, pass) }] }), { status: 200 });
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:8787');
  if (u.pathname === '/__scenario') { scenario = u.searchParams.get('name'); photoCalls = 0; failOnce = u.searchParams.get('fail') === '1'; res.writeHead(200, { 'access-control-allow-origin': '*' }); return res.end('ok'); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(u, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log('mock 8787'));
