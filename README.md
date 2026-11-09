# QC BATCH RELEASE

Aplikasi web bantu inspeksi QC sebelum Batch Release. Dibuat untuk Chrome di Android.

## Arsitektur
- **Frontend** (folder root): GitHub Pages. Data acuan, sesi, dan riwayat disimpan di IndexedDB browser.
- **Server AI** (`worker/`): Cloudflare Worker. Server ini menyimpan `ANTHROPIC_API_KEY` dan `APP_PASSCODE` sebagai *secret*, lalu memanggil Claude untuk **membaca** gambar. Foto tidak disimpan di server.
- **Keputusan** RELEASE / HOLD / HOLD TOTAL dihitung oleh aturan tetap di `src/qc-core.js`, bukan oleh AI.
- Setiap foto dibaca AI 2x secara independen. Hasil yang tidak konsisten atau berisi digit `?` menghasilkan HOLD. Nomor batch acuan tidak dikirim ke AI.

## Uji
- `node --test test/qc-core.test.js test/worker.test.js`
- `python3 e2e/run.py`: menguji alur lengkap di Chrome (Playwright). Panggilan Anthropic ditiru oleh `e2e/mock-server.mjs`.
