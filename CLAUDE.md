# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Baca `PROJECT.md` untuk memahami APA yang dibangun (spesifikasi domain lengkap). File ini mengatur BAGAIMANA mengerjakannya. Kalau ada konflik, tanyakan; jangan menebak hal yang berdampak pada uang/keamanan.

## Commands

```bash
npm run dev              # Next.js dev server (http://localhost:3000, redirect ke /login)
npm run build             # build produksi (jalankan untuk verifikasi sebelum selesai kerja)
npm run typecheck         # tsc --noEmit — WAJIB lulus, tanpa error tipe
npm test                  # vitest run — semua unit test (parse.ts & validate.ts)
npm run test:watch        # vitest mode watch
npx vitest run tests/parse.test.ts     # jalankan satu file test
npm run format             # prettier --write .
npm run set-webhook        # daftarkan webhook Telegram (butuh .env.local + deploy publik)
npm run set-webhook -- --info    # cek status webhook
npm run set-webhook -- --delete  # hapus webhook
```

Test hanya menguji fungsi murni (`lib/parse.ts`, `lib/validate.ts`) — **tidak** menyentuh DB/jaringan sungguhan (lihat `vitest.config.ts`). Jangan mencoba connect ke Neon/Vercel/Telegram nyata; itu bagian user.

## Arsitektur

Satu project Next.js App Router berisi **dua jalur terpisah** ke Neon Postgres yang sama:

- **Bot (jalur tulis)** — `app/api/telegram/route.ts` → grammY webhook (bukan polling) → `lib/telegram.ts`. Pakai koneksi `DATABASE_URL_BOT` (role `bot_writer`).
- **Web (jalur baca)** — halaman di `app/*/page.tsx`, dilindungi `middleware.ts` + cookie auth. Pakai koneksi `DATABASE_URL_WEB` (role `web_reader`, SELECT saja). Revisi data **hanya** lewat bot; web tidak pernah punya jalur tulis.

Kedua koneksi dibuat lazy di `lib/db.ts` (`getDbBot`/`getDbWeb`/`getSqlBot`/`getSqlWeb`) lewat `@neondatabase/serverless` (driver HTTP, bukan `pg`). **Jangan pernah** impor `getDbBot`/`getSqlBot` dari kode di bawah `app/` (halaman web) — itu melanggar pemisahan role.

### Alur pesan bot (`lib/telegram.ts`)

1. Route handler (`app/api/telegram/route.ts`) verifikasi header `X-Telegram-Bot-Api-Secret-Token` dan `from.id == ALLOWED_TELEGRAM_ID` **sebelum** apa pun lain disentuh (tidak buang kuota Gemini/DB kalau bukan pemilik).
2. `lib/parse.ts` — coba regex/command dulu (hemat kuota Gemini), fallback ke Gemini (`@google/generative-ai`) untuk kalimat bebas → hasil multi-operasi JSON.
3. `lib/validate.ts` — validasi zod (tipe, enum, rentang wajar) terhadap output parser (AI = data tak tepercaya).
4. Ringkasan + inline keyboard `[✅ Simpan] [❌ Batal]` — batch tervalidasi disimpan sementara di tabel `pending_confirm` (`lib/pending.ts`), `callback_data` hanya membawa id pendek (limit 64 byte Telegram).
5. Saat "Simpan" ditekan: payload **divalidasi ulang** (defense in depth) lalu `lib/insert.ts` melakukan INSERT berparameter (transaksi utk batch).
6. Jalur lain: pertanyaan deterministik → `lib/ask.ts` (baca saja, tanpa AI); revisi (`undo`/`hapus`/`ubah`) → selalu tampilkan data lama → konfirmasi → eksekusi.

### Lokasi/kantin adalah data, bukan konstanta

Sejak migrasi `0005`–`0006`, daftar kantin/gudang **tidak** hardcode — tersimpan di tabel `location_ref` dan dikelola lewat perintah bot `/setting`. `lib/locations.ts` adalah **sumber tunggal**: `getLocations`/`getLocationsFresh` baca tabel (cache TTL 30 dtk untuk jalur baca, jalur tulis bot selalu fresh), `buildLocationCtx` menghasilkan `LocationCtx` (`locationSet`, `canteenSet`, `batch50Set`, `warehouseSet`, `defaultPrice`, `aliasMap`) yang dipakai parser & validator untuk mengenali kode lokasi, alias ketikan, harga default, dan penanda batch 50 — semua dinamis per baris `location_ref`, tidak ada nama sekolah di-hardcode di kode.

Aturan "kantin bukan gudang" ditegakkan berlapis: validasi aplikasi **dan** FK-subset di level DB ke `location_ref(code, is_canteen)` (lihat kolom generated `canteen_is_canteen` di `lib/schema.ts`).

### Kolom `GENERATED ALWAYS AS ... STORED`

`output_pieces`, `wage_rp`, `wage_zummy_rp`, `wage_aril_rp`, `total_rp`, `canteen_is_canteen` **dihitung oleh Postgres**, bukan aplikasi — di Drizzle ditandai `.generatedAlwaysAs(...)` sehingga tidak bisa di-insert manual. Kalau logika upah/total berubah, ekspresi harus diubah **serentak** di `db/migrations/000N_*.sql` (migrasi baru) dan `lib/schema.ts` (harus identik persis) — bukan salah satu saja.

### Auth web

`middleware.ts` (edge runtime) hanya cek keberadaan cookie `AUTH_COOKIE` (dari `lib/auth-shared.ts`, aman untuk edge) untuk redirect UX ke `/login`. Verifikasi token HMAC yang sebenarnya ada di `lib/auth.ts` (server-only, pakai `node:crypto`) dan dipanggil di tiap halaman/route — middleware **bukan** gerbang keamanan asli, halaman itu sendiri yang memvalidasi.

### Skema database & migrasi

`db/migrations/0001`…`0008` bersifat **kumulatif** — `0001_init.sql` adalah bentuk sejarah/awal (bahkan sudah memakai enum `location` yang lalu dihapus di `0006`). Selalu baca migrasi terbaru untuk state skema yang berjalan sekarang, jangan asumsikan dari `0001` saja. Ringkasan evolusi ada di `PROJECT.md` §5. Dua role DB (`bot_writer`, `web_reader`) dibuat di `0002_roles.sql`.

## Aturan domain (gampang salah — baca sebelum mengubah logika bisnis)

- **1 resep = 85 biji; upah Rp5.000/resep PER ORANG** (bukan Rp3.000 — nilai lama sudah tidak berlaku). `production.worker` (`berdua`|`zummy`|`aril`): berdua → Rp10.000/resep total (`wage_zummy_rp` & `wage_aril_rp` masing-masing Rp5.000/resep), sendiri → Rp5.000/resep ke satu orang saja. Lihat migrasi `0007_wage_5000.sql`.
- **Harga tidak hardcode.** Default per lokasi (mis. Rp1.300/biji) disimpan di `location_ref.price_rp`, diatur lewat `/setting`, dan disalin ke `sale.price_rp` per baris — bisa beda per kantin & berubah dari waktu ke waktu.
- **Mutasi ≠ penjualan.** Perpindahan es antar kantin/gudang (termasuk "lempar") masuk `stock_movement`, TIDAK menambah `sale`/kas.
- **Batch 50** ditandai per lokasi via `location_ref.is_batch50` (bukan daftar sekolah hardcode). Kantin batch50: penjualan/penagihan kelipatan 50; stok fisik tidak dilacak.
- **Penjualan dan Kas Masuk terpisah** (uang bisa diterima di hari lain) — jangan digabung jadi satu insert.
- **Pengambilan** (owner draw, mis. SPP) diinput MANUAL sebagai `cash_out` `kind='pengambilan'` — tidak ada lagi mekanisme otomatis dari kantin manapun.
- **Saldo awal** (`opening_balance`, baris tunggal id=1) = titik-nol modal, diisi sekali lewat `/setting saldo`. Rumus laporan inti: `Laba usaha = Omzet − (Pengeluaran + Upah)`; `Kas tersisa = Saldo awal + Laba usaha − Pengambilan`.
- **Revisi (undo/hapus/ubah) hanya lewat bot.** Web (`web_reader`) tetap read-only.
- Tanggal default = hari ini, zona **Asia/Jakarta** (`lib/dates.ts`).
- Semua nominal uang = **integer rupiah**, tidak pernah float/numeric.

## Batasan teknologi (tidak boleh diubah tanpa diminta eksplisit)

- TypeScript strict, tanpa `any` implisit.
- DB driver **wajib** `@neondatabase/serverless` (HTTP) — **dilarang** `pg`/`node-postgres` biasa (masalah koneksi di serverless).
- Semua query **berparameter** (Drizzle atau tagged-template neon). Dilarang mutlak string-concat ke SQL.
- Bot **wajib mode webhook** — tidak boleh ada `bot.start()` polling / proses long-running.
- Satu API key Gemini saja — jangan bangun mekanisme multi-akun/rotasi key.
- Free tier only (Neon + Vercel + Gemini) — jangan tambah layanan berbayar/dependency berat tanpa alasan kuat.

## Keamanan (jangan dilanggar)

- Webhook **wajib** verifikasi header secret + whitelist `from.id` **sebelum** menyentuh Gemini/DB (lihat urutan di `app/api/telegram/route.ts`).
- Output Gemini = data tak tepercaya: **selalu** lolos validasi zod (rentang wajar: `qty` 0–2000, `recipes` 1–50, `price_rp` 100–5000, `amount_rp` >0 & <100.000.000) sebelum insert. Tidak ada auto-insert tanpa konfirmasi inline keyboard.
- Jangan `console.log` secret/connection string/token, termasuk saat debug.
- Jangan tampilkan error stack/detail DB ke user (bot maupun web) — pesan ramah + minta ulang.
- `.env*` di `.gitignore`; jangan pernah commit `.env`. Semua rahasia lewat env var, lihat `.env.example` untuk daftar nama variabel.

## Kalau ragu

Tulis asumsi sebagai komentar `// ASUMSI:` di kode dan lanjut dengan default yang masuk akal — jangan diam-diam mengarang nilai domain. Untuk hal yang menyangkut uang atau keamanan, catat di README bagian "Perlu dikonfirmasi user". Jangan mencoba deploy, menjalankan migrasi ke DB sungguhan, atau connect ke Neon/Vercel/Telegram nyata — itu dilakukan user sendiri.
