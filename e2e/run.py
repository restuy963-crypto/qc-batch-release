# Uji alur lengkap mode AI: frontend asli + kode worker asli (panggilan Anthropic ditiru oleh e2e/mock-server.mjs).
import asyncio, subprocess, sys, os, urllib.request
from playwright.async_api import async_playwright
U='/mnt/user-data/uploads/'
REF=U+'2b57de82-image.jpg'; EMB=U+'82e2bb90-image.jpg'; BOT=U+'5d38d988-image.jpg'
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT='/home/claude/e2e/shots2'; os.makedirs(OUT, exist_ok=True)
errors=[]
def scen(name, fail=False): urllib.request.urlopen(f'http://localhost:8787/__scenario?name={name}&fail={1 if fail else 0}').read()

async def main():
    srv=subprocess.Popen([sys.executable,'-m','http.server','8765'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    api=subprocess.Popen(['node','e2e/mock-server.mjs'],cwd=ROOT)
    await asyncio.sleep(1.5)
    try:
      async with async_playwright() as pw:
        b=await pw.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        ctx=await b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
        pg=await ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type=='error' and 'favicon' not in m.text else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.add_init_script("window.__API_BASE='http://localhost:8787'")
        await pg.goto('http://localhost:8765/'); await pg.wait_for_selector('text=Dashboard QC')
        async def shot(n): await pg.screenshot(path=f'{OUT}/{n}.png',full_page=True)
        assert 'BELUM DIATUR' in await pg.inner_text('#aiChip')
        # Setelan: kode salah lalu benar
        await pg.click('nav a[data-v=setelan]'); await pg.fill('#passIn','salah'); await pg.click('[data-act=savePass]')
        await pg.wait_for_selector('text=Kode akses salah'); print('kode salah ditolak OK')
        await pg.fill('#passIn','uji-kode-123'); await pg.click('[data-act=savePass]'); await pg.wait_for_selector('#aiChip:has-text("AI: AKTIF")')
        await shot('01_setelan'); print('koneksi AI OK')
        # Acuan
        await pg.click('nav a[data-v=acuan]')
        async with pg.expect_file_chooser() as fc: await pg.click('text=PILIH GAMBAR')
        await (await fc.value).set_files(REF); await pg.wait_for_selector('#btnOcr')
        await pg.click('#btnOcr'); await pg.click('.modal [data-r="1"]'); await pg.wait_for_selector('text=hasil baca AI', timeout=30000)
        assert await pg.input_value('[data-ref=batch]')=='09173261'
        await pg.check('[data-unr=brand]'); await pg.check('#refConfirm'); await shot('02_acuan_ai')
        await pg.click('#btnLock'); await pg.click('.modal [data-r="1"]'); await pg.wait_for_selector('text=DATA ACUAN BARU')
        async def session(name, expect, fail=False, finish=True):
            scen(name, fail)
            await pg.goto('http://localhost:8765/#beranda'); await pg.wait_for_selector('text=Dashboard QC')
            await pg.click('text=PEMERIKSAAN BARU >> nth=0')
            if await pg.locator('.modal').count(): await pg.click('.modal [data-r="1"]')
            async with pg.expect_file_chooser() as fc: await pg.click('[data-act=addPhotos][data-k=multi]')
            await (await fc.value).set_files([EMB,BOT]); await pg.wait_for_selector('text=Foto 02')
            await pg.click('[data-act=startAnalysis]'); await pg.click('.modal [data-r="1"]')
            if fail:
                await pg.wait_for_selector('text=COBA LAGI', timeout=60000); await shot('03_gagal_sebagian')
                print(f'[{name}] foto gagal → tombol COBA LAGI tampil, tanpa keputusan')
                assert await pg.locator('text=LIHAT HASIL QC').count()==0
                await pg.click('text=COBA LAGI')
            await pg.wait_for_selector('text=Hasil Pemeriksaan', timeout=60000)
            dec=(await pg.locator('.decision .big').first.inner_text()).strip()
            print(f'[{name}] -> {dec} (harap {expect})'); assert dec==expect, dec
            await shot(f'04_hasil_{name}')
            return dec
        await session('A','HOLD')
        # koreksi petugas: kemasan & karton → N/A
        await pg.click('text=TINJAU / KOREKSI'); await pg.wait_for_selector('text=Tinjau & Koreksi')
        await shot('05_tinjau')
        await pg.click('[data-act=seg][data-path="identity.kemasan.status"][data-v="NOT APPLICABLE"]'); await pg.wait_for_timeout(200)
        await pg.click('[data-act=seg][data-path="visual.karton.status"][data-v="NOT APPLICABLE"]'); await pg.wait_for_timeout(200)
        await pg.click('[data-act=buildReport]'); await pg.wait_for_selector('text=Hasil Pemeriksaan')
        dec=(await pg.locator('.decision .big').first.inner_text()).strip(); print('[A+koreksi] ->',dec); assert dec=='RELEASE'
        assert await pg.locator('text=2 koreksi petugas').count()==1
        await pg.fill('#approver','YOGA'); await pg.check('#approveChk'); await pg.click('#btnFinish'); await pg.click('.modal [data-r="1"]')
        await pg.wait_for_selector('text=read-only'); await shot('06_laporan')
        await session('B','HOLD')     # bacaan 1 ≠ bacaan 2
        await session('C','HOLD TOTAL')   # batch beda
        await session('D','HOLD', fail=True)  # foto gagal lalu coba lagi → tetap ada karton not visible → HOLD
        # Riwayat & PDF
        await pg.goto('http://localhost:8765/#riwayat'); await pg.wait_for_selector('text=Riwayat QC')
        print('riwayat', await pg.locator('#hlist [data-h^="laporan:"]').count())
        await pg.locator('#hlist [data-act=exportPdf]').first.click(); await pg.wait_for_selector('text=LAPORAN QC BATCH RELEASE')
        await pg.evaluate("Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))")
        await pg.emulate_media(media='print'); await pg.pdf(path=f'{OUT}/laporan.pdf', format='A4', print_background=True); await pg.emulate_media(media='screen')
        txt=await pg.inner_text('main'); assert 'claude-sonnet-5-5' in txt and 'Biaya AI sesi' in txt
        # cek: API key tidak pernah ada di HP
        ls=await pg.evaluate("JSON.stringify(localStorage)"); assert 'sk-mock' not in ls; print('localStorage:', ls)
        await b.close()
    finally:
        srv.terminate(); api.terminate()
    print('CONSOLE ERRORS:', errors)
asyncio.run(main())
