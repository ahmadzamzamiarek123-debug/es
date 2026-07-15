# CLAUDE.md — Aturan Pengerjaan Proyek Es Lilin Tracker

> **Baca `PROJECT.md` lebih dulu** untuk memahami APA yang dibangun. File ini mengatur BAGAIMANA mengerjakannya. Kalau ada konflik, tanyakan; jangan menebak hal yang berdampak pada uang/keamanan.

---

## 0. Prinsip utama

1. **Free tier only.** Jangan menambah layanan/deps berbayar atau berat tanpa alasan kuat. Target: Neon free + Vercel free + Gemini free.
2. **Keamanan > kepraktisan.** Kalau ragu antara cepat vs aman, pilih aman.
3. **Uang harus akurat.** Semua nominal = **integer rupiah** (tanpa desimal/float). Jangan pernah pakai `float`/`number` untuk uang di DB.
4. **Jangan menebak nilai domain.** Kalau aturan bisnis tidak jelas, beri komentar `// ASUMSI:` di kode dan lanjut dengan default yang masuk akal, JANGAN diam-diam mengarang.

---

## 1. Batasan teknologi (tidak boleh diubah)

- Bahasa: **TypeScript strict** (`"strict": true`). Tanpa `any` implisit.
- Framework: **Next.js App Router**. Bot & web dalam satu project.
- DB driver: **`@neondatabase/serverless`** (HTTP). **DILARANG** pakai `pg`/`node-postgres` biasa (masalah koneksi di serverless).
- ORM: **Drizzle** (atau SQL berparameter). Bebas, tapi konsisten.
- Bot: **grammY** mode **webhook** (bukan polling — tidak boleh ada proses long-running / `bot.start()` polling).
- AI: **`@google/generative-ai`**, model flash. Satu API key saja (JANGAN buat mekanisme multi-akun/rotasi key — ribet & melanggar ToS).

---

## 2. Aturan KEAMANAN (paling penting — jangan dilanggar)

### Rahasia
- **Semua** token/kunci/koneksi lewat **environment variables**. Tidak ada nilai rahasia yang di-hardcode di kode.
- Buat `.env.example` (tanpa nilai). Pastikan `.env*` ada di `.gitignore`. **Jangan pernah** commit `.env`.
- Jangan `console.log` secret, connection string, atau token — termasuk saat debug.

### Database
- **Dua koneksi role berbeda**: bot pakai `DATABASE_URL_BOT` (bot_writer), web pakai `DATABASE_URL_WEB` (web_reader, read-only). Jangan tertukar. Web tidak boleh punya jalur menulis DB.
- **Selalu query berparameter** (`$1,$2` atau Drizzle). **DILARANG** menyambung string ke SQL. Ini mutlak, tanpa pengecualian.
- Koneksi wajib `sslmode=require`.

### Bot Telegram
- Endpoint webhook **wajib**: (1) verifikasi header `X-Telegram-Bot-Api-Secret-Token` == `TELEGRAM_WEBHOOK_SECRET`; (2) cek `from.id` == `ALLOWED_TELEGRAM_ID`. Gagal salah satu → tolak/abaikan sebelum proses apa pun.
- Verifikasi keamanan harus dijalankan **sebelum** memanggil Gemini atau menyentuh DB (biar tidak buang kuota / tidak bisa disalahgunakan).

### Output AI = data tak terpercaya
- Perlakukan hasil Gemini seperti input asing: **validasi zod** (tipe, enum, rentang wajar) sebelum insert.
- Batas wajar contoh: `qty` 0–2000, `recipes` 1–50, `price_rp` 100–5000, `amount_rp` > 0 & < 100.000.000. Di luar itu → minta konfirmasi ulang.
- **Wajib ada langkah konfirmasi** (inline keyboard) sebelum menyimpan. Tidak ada auto-insert langsung dari AI.

### Web
- Dashboard tidak boleh publik. Beri proteksi (password sederhana / Vercel protection). Role DB read-only sebagai lapis kedua.
- Jangan tampilkan error stack/detail DB ke user.

---

## 3. Aturan domain (logika bisnis yang gampang salah)

- **1 resep = 40 biji; upah Rp6.000/resep** (Rp3.000 × 2 orang). Jangan diubah kecuali diminta.
- **Harga tidak di-hardcode** selain default per kantin (SMA=800, lainnya=900). Simpan `price_rp` per baris penjualan.
- **Mutasi ≠ penjualan.** Perpindahan es (termasuk "lempar" antar kantin) masuk `stock_movement`, TIDAK menambah penjualan/kas.
- **SMA & SMK = batch 50.** Penjualan/penagihan kelipatan 50; jangan andalkan stok fisik.
- **Penjualan dan Kas Masuk dipisah** (uang bisa beda hari). Jangan gabung jadi satu insert.
- **Uang MTS2 diambil ayah** = catat Penjualan (normal) + `cash_out` (`kind='pengambilan'`, `category='spp_ayah'`). Jangan hilangkan salah satu.
- Tanggal default = **hari ini** menurut zona **Asia/Jakarta**.

---

## 4. Gaya kode & struktur

- Ikuti struktur folder di `PROJECT.md` §9.
- Fungsi kecil, satu tanggung jawab. Pisahkan: parse / validate / insert / report.
- Semua tipe entity punya **zod schema** + **tipe TS** turunannya (`z.infer`).
- Format dengan Prettier. Tidak ada kode mati / komentar TODO menggantung tanpa penjelasan.
- Tulis komentar singkat berbahasa Indonesia pada logika domain yang rumit (batch 50, pengambilan, dsb).
- Hemat panggilan Gemini: **coba regex/command dulu**, Gemini hanya fallback untuk kalimat bebas.

---

## 5. Git & deliverable

- Commit kecil & jelas (mis. `feat(bot): webhook auth + parser`).
- **Jangan** commit `.env`, `node_modules`, build output.
- Sertakan **README.md** ringkas: langkah setup (env, migrasi Neon, BotFather, deploy Vercel, set webhook, cara test).
- Sertakan `.env.example`, `db/migrations/0001_init.sql`, `db/migrations/0002_roles.sql`, `scripts/set-webhook.ts`.

---

## 6. Testing / verifikasi (yang Claude Code lakukan)

- Pastikan `tsc --noEmit` **lulus** (tanpa error tipe).
- Pastikan `next build` **berhasil** secara lokal.
- Sediakan **contoh payload uji** untuk webhook (file `scripts/sample-updates.http` atau test) agar user bisa mencoba parser tanpa Telegram asli.
- Sediakan minimal 1 unit test untuk `lib/parse.ts` (beberapa kalimat → JSON benar) dan `lib/validate.ts` (nilai di luar rentang ditolak).
- **JANGAN** mencoba connect ke Neon/Vercel/Telegram sungguhan atau butuh internet — user yang menyambungkan & test end-to-end.

---

## 7. Yang TIDAK boleh dilakukan

- ❌ Deploy sendiri / menjalankan migrasi ke DB sungguhan.
- ❌ Menaruh secret di kode atau di README.
- ❌ Mode polling untuk bot.
- ❌ String-concat SQL.
- ❌ Auto-insert dari AI tanpa konfirmasi.
- ❌ Menyimpan uang sebagai float.
- ❌ Menambah dependency berat / layanan berbayar tanpa izin.

---

## 8. Kalau ragu

Tulis asumsi sebagai komentar `// ASUMSI:` dan lanjutkan dengan default paling aman. Untuk hal yang menyangkut **uang atau keamanan**, beri catatan menonjol di README bagian "Perlu dikonfirmasi user".
