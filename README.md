# QC BATCH RELEASE

Aplikasi web bantu inspeksi QC sebelum Batch Release. Dibuat untuk Chrome di Android.

- Semua proses berjalan **di perangkat**. Foto tidak dikirim ke server atau AI eksternal.
- OCR: Tesseract.js (open-source), dimuat dari cdn.jsdelivr.net, lalu disimpan di cache.
- Keputusan RELEASE / HOLD / HOLD TOTAL dihitung oleh aturan tetap di `src/qc-core.js`.
- Data (acuan, sesi, riwayat) tersimpan di IndexedDB browser. Gunakan menu Setelan untuk ekspor dan pulihkan cadangan.
- Petugas QC memegang otoritas persetujuan akhir.

## Uji
- Logika inti: `node --test test/qc-core.test.js`
- Alur lengkap (Playwright + Tesseract CLI): `python3 e2e/run.py` (path foto sampel perlu disesuaikan)
