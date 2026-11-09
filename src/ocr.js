// OCR di perangkat menggunakan Tesseract.js. Gambar TIDAK dikirim ke mana pun.
// Yang diunduh dari internet hanya kode program & data bahasa (sekali, lalu tersimpan di cache).
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerPromise = null;
let progressCb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Gagal memuat modul OCR. Periksa koneksi internet (hanya dibutuhkan saat pertama kali).'));
    document.head.appendChild(s);
  });
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

async function getWorker() {
  if (window.__OCR_MOCK) return null;
  if (!workerPromise) {
    workerPromise = (async () => {
      await withTimeout(loadScript(TESS_URL), 60000, 'Waktu habis saat memuat modul OCR');
      const w = await withTimeout(window.Tesseract.createWorker('eng', 1, {
        logger: m => { if (progressCb && m.status === 'recognizing text') progressCb(m.progress); },
      }), 120000, 'Waktu habis saat menyiapkan OCR');
      return w;
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Perbesar kontras & ubah ke grayscale sebelum OCR (tidak mengubah foto asli).
export async function enhance(blob, maxSide = 2000) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.6)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c;
}

export async function recognize(blob, onProgress) {
  if (window.__OCR_MOCK) return window.__OCR_MOCK(blob);
  const w = await getWorker();
  progressCb = onProgress;
  try {
    const canvas = await enhance(blob);
    const { data } = await withTimeout(w.recognize(canvas), 120000, 'Waktu habis saat membaca gambar');
    return { text: data.text || '', confidence: data.confidence ?? null };
  } finally { progressCb = null; }
}
