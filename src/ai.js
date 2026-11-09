// Klien server AI. API key TIDAK ada di sini — hanya kode akses aplikasi.
import { API_BASE } from './config.js';

const KEY = 'qc_app_passcode';
export const getPasscode = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setPasscode = v => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} };
export const apiBase = () => (window.__API_BASE ?? API_BASE).replace(/\/+$/, '');
export const aiConfigured = () => !!(apiBase() && getPasscode());

async function call(path, { method = 'POST', body, timeout = 150000 } = {}) {
  if (!apiBase()) throw new Error('Alamat server AI belum diatur.');
  if (!getPasscode()) throw new Error('Kode akses belum diisi. Buka Setelan.');
  if (!navigator.onLine) throw new Error('Perangkat offline. Analisis AI membutuhkan internet.');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(apiBase() + path, { method, signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-app-key': getPasscode() }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ ok: false, error: `Respons server tidak valid (HTTP ${r.status})` }));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Waktu habis menunggu server AI');
    if (e instanceof TypeError) throw new Error('Tidak bisa menghubungi server AI (' + e.message + ')');
    throw e;
  } finally { clearTimeout(t); }
}

// Kecilkan gambar khusus untuk dikirim ke AI (maks 1568 px sisi terpanjang).
export async function toAiImage(blob, maxSide = 1568) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
  const url = c.toDataURL('image/jpeg', 0.9);
  return { image: url.split(',')[1], mediaType: 'image/jpeg' };
}

export const health = () => call('/api/health', { method: 'GET', timeout: 20000 });
export async function readReference(blob) { return call('/api/reference', { body: await toAiImage(blob) }); }
export async function readPhoto(blob, ref, pass) { return call('/api/photo', { body: { ...(await toAiImage(blob)), ref, pass } }); }
