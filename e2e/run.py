import asyncio, base64, subprocess, tempfile, sys, os, re
from playwright.async_api import async_playwright
U='/mnt/user-data/uploads/'
REF=U+'2b57de82-image.jpg'; EMB=U+'82e2bb90-image.jpg'; BOT=U+'5d38d988-image.jpg'
OUT='/home/claude/e2e/shots'; os.makedirs(OUT, exist_ok=True)
errors=[]
def ocr_host(dataurl):
    raw=base64.b64decode(dataurl.split(',',1)[1])
    with tempfile.NamedTemporaryFile(suffix='.jpg',delete=False) as f: f.write(raw); p=f.name
    return subprocess.run(['tesseract',p,'-','--psm','6'],capture_output=True,text=True).stdout

async def main():
    srv=subprocess.Popen([sys.executable,'-m','http.server','8765'],cwd='/home/claude/qc-app',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    await asyncio.sleep(1)
    async with async_playwright() as pw:
        b=await pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
        pg=await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.expose_function('ocrHost', ocr_host)
        await pg.add_init_script("""window.__OCR_MOCK = async blob => { const d = await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(blob)}); return {text: await window.ocrHost(d), confidence:null}; };""")
        await pg.goto('http://localhost:8765/')
        await pg.wait_for_selector('text=Dashboard QC')
        async def shot(n): await pg.screenshot(path=f'{OUT}/{n}.png',full_page=True)
        await shot('01_beranda_kosong')
        # Analisis tanpa acuan
        await pg.click('nav a[data-v=analisis]'); await pg.wait_for_selector('text=DATA ACUAN belum terkunci'); await shot('02_analisis_tanpa_acuan')
        # ACUAN
        await pg.click('nav a[data-v=acuan]')
        async with pg.expect_file_chooser() as fc: await pg.click('text=PILIH GAMBAR')
        await (await fc.value).set_files(REF)
        await pg.wait_for_selector('#btnOcr')
        assert await pg.is_disabled('#btnLock'), 'lock harus nonaktif sebelum valid'
        await pg.click('#btnOcr'); await pg.wait_for_selector('text=usulan OCR', timeout=60000)
        batch=await pg.input_value('[data-ref=batch]'); print('OCR acuan batch =',batch)
        await pg.fill('[data-ref=produk]','ENDURO MATIC G'); await pg.fill('[data-ref=brand]','PERTAMINA')
        await shot('03_acuan_hasil_ocr')
        assert await pg.is_disabled('#btnLock')
        await pg.check('#refConfirm'); assert not await pg.is_disabled('#btnLock')
        await pg.click('#btnLock'); await pg.click('.modal [data-r="1"]')
        await pg.wait_for_selector('text=DATA ACUAN BARU'); await shot('04_acuan_terkunci')
        async def run_session(tag, r1, r2, photo2mode, expect, finish=True):
            await pg.goto('http://localhost:8765/#beranda'); await pg.wait_for_selector('text=Dashboard QC')
            await pg.click('text=PEMERIKSAAN BARU >> nth=0')
            if await pg.locator('.modal').count(): await pg.click('.modal [data-r="1"]')
            await pg.wait_for_selector('text=Upload Foto Aktual')
            async with pg.expect_file_chooser() as fc: await pg.click('[data-act=addPhotos][data-k=multi]')
            await (await fc.value).set_files([EMB,BOT])
            await pg.wait_for_selector('text=Foto 02')
            assert await pg.is_disabled('[data-act=startAnalysis]'), 'harus wajib kategori'
            await pg.select_option('[data-cat="0"]','Emboss'); await pg.wait_for_timeout(300)
            await pg.select_option('[data-cat="1"]','Label'); await pg.wait_for_timeout(300)
            if tag=='a': await shot('05_analisis_foto')
            await pg.click('[data-act=startAnalysis]'); await pg.click('.modal [data-r="1"]')
            await pg.wait_for_selector('text=LANJUT: VERIFIKASI PETUGAS', timeout=90000)
            if tag=='a': await shot('06_proses')
            await pg.click('text=LANJUT: VERIFIKASI PETUGAS'); await pg.wait_for_selector('text=Verifikasi Petugas')
            async def segc(path,val): await pg.click(f'[data-act=seg][data-path="{path}"][data-v="{val}"]'); await pg.wait_for_timeout(150)
            await segc('photos.1.mode','visible')
            await pg.fill('[data-path="photos.1.r1"]',r1); await pg.fill('[data-path="photos.1.r2"]',r2)
            await pg.fill('[data-path="photos.1.occ"]','2'); await pg.fill('[data-path="photos.1.obj"]','1')
            await segc('photos.2.mode',photo2mode)
            # coba susun laporan sebelum lengkap
            await pg.click('[data-act=buildReport]'); await pg.wait_for_selector('text=Belum lengkap')
            for k in ['nama','varian','apiJaso','volume']: await segc(f'identity.{k}.status','MATCH')
            await segc('identity.kemasan.status','NOT APPLICABLE' if expect=='RELEASE' else 'NOT VISIBLE')
            for k,v in [('label','MATCH'),('emboss','MATCH'),('tutup','MATCH'),('printer','NOT APPLICABLE'),('karton','NOT APPLICABLE' if expect=='RELEASE' else 'NOT VISIBLE'),('sticker','NOT APPLICABLE'),('qr','MATCH')]:
                await segc(f'visual.{k}.status',v)
            await pg.fill('[data-path=officer]','YOGA')
            if tag=='a': await shot('07_verifikasi')
            await pg.click('[data-act=buildReport]'); await pg.wait_for_selector('text=Hasil Pemeriksaan')
            dec=(await pg.locator('.decision .big').first.inner_text()).strip()
            print(f'[{tag}] r1={r1} r2={r2} -> {dec} (harap {expect})'); assert dec==expect, dec
            await shot(f'08_hasil_{tag}')
            if finish:
                assert await pg.is_disabled('#btnFinish')
                await pg.check('#approveChk'); await pg.click('#btnFinish'); await pg.click('.modal [data-r="1"]')
                await pg.wait_for_selector('text=read-only')
        await run_session('a','09173261','09173261','notvisible','HOLD TOTAL')
        await shot('09_laporan')
        await run_session('b','0912?261','0912?261','na','HOLD')
        await run_session('c','09121261','09121268','na','HOLD')          # double check tidak konsisten
        await run_session('d','09121261','09121261','na','RELEASE')
        # Riwayat
        await pg.click('nav a[data-v=riwayat]'); await pg.wait_for_selector('text=Riwayat QC')
        n=await pg.locator('#hlist [data-h^="laporan:"]').count(); print('riwayat records',n); assert n==4
        await pg.select_option('#fdec','RELEASE'); await pg.wait_for_timeout(200)
        print('filter RELEASE', await pg.locator('#hlist [data-h^="laporan:"]').count())
        await pg.select_option('#fdec',''); await pg.fill('#fq','zzz'); await pg.wait_for_timeout(200)
        print('cari zzz', await pg.locator('#hlist [data-h^="laporan:"]').count())
        await pg.fill('#fq',''); await pg.wait_for_timeout(200); await shot('10_riwayat')
        # PDF
        await pg.locator('text=UNDUH / CETAK PDF').last.click(); await pg.wait_for_selector('text=LAPORAN QC BATCH RELEASE')
        await pg.evaluate("Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))")
        await pg.emulate_media(media='print'); await pg.pdf(path=f'{OUT}/laporan_contoh.pdf', format='A4', print_background=True); await pg.emulate_media(media='screen')
        # reload: riwayat tetap ada
        await pg.reload(); await pg.goto('http://localhost:8765/#riwayat'); await pg.wait_for_selector('text=Riwayat QC')
        print('setelah reload', await pg.locator('#hlist [data-h^="laporan:"]').count())
        # Setelan
        await pg.click('nav a[data-v=setelan]'); await pg.wait_for_selector('text=Informasi API'); await shot('11_setelan')
        # Beranda
        await pg.click('nav a[data-v=beranda]'); await pg.wait_for_selector('text=Aktivitas terbaru'); await shot('12_beranda')
        # DATA ACUAN BARU
        await pg.click('nav a[data-v=acuan]'); await pg.click('[data-act=refNew]')
        assert await pg.is_disabled('.modal [data-r="1"]')
        await pg.fill('#mPhrase','DATA ACUAN BARU'); await pg.click('.modal [data-r="1"]')
        await pg.wait_for_selector('text=Acuan lama (1)'); print('acuan baru OK')
        await b.close()
    srv.terminate()
    print('CONSOLE ERRORS:', errors)
asyncio.run(main())
