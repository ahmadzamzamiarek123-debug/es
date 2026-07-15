# Es Lilin Tracker

Pencatatan usaha es lilin lewat **bot Telegram** (input bahasa bebas) dengan
**dashboard web** (Next.js) untuk laporan keuangan. Data di **Neon Postgres**.

- Bot menerima catatan seperti `jual mts1 100` atau `beli bahan 20rb`, mengurai
  dengan regex (hemat kuota) lalu **Gemini** sebagai fallback, dan **selalu
  minta konfirmasi** sebelum menyimpan.
- Web menampilkan omzet, laba usaha, kas tersisa, tren, penjualan per kantin,
  komposisi biaya, transaksi, dan laporan bulanan (bisa export CSV).

## Model keuangan (ringkas)

```
Laba usaha  = Omzet − (Pengeluaran usaha + Upah produksi)
Kas tersisa = Laba usaha − Pengambilan
```

- **Upah produksi** dihitung DB: `recipes × 6000` (Rp6.000/resep untuk 2 orang).
- **Output** dihitung DB: `recipes × 40` biji.
- **Pengambilan** (mis. uang MTS2 diambil Ayah untuk SPP) adalah *owner draw* —
  mengurangi kas tersisa, **bukan** laba usaha.
- **SMA & SMK** memakai model **batch 50**: qty penjualan wajib kelipatan 50.
- Semua uang **integer rupiah** — tidak ada float di mana pun.

## Arsitektur & keamanan

- **Dua role DB terpisah** (least privilege):
  - `bot_writer` (`DATABASE_URL_BOT`) — INSERT/SELECT, dipakai bot.
  - `web_reader` (`DATABASE_URL_WEB`) — SELECT saja, dipakai web.
- Web **tidak pernah** mengimpor koneksi bot; semua query berparameter (tidak ada
  string-concat SQL).
- Webhook Telegram diverifikasi dua lapis **sebelum** menyentuh Gemini/DB:
  1. Header `X-Telegram-Bot-Api-Secret-Token` harus cocok.
  2. `from.id` harus sama dengan `ALLOWED_TELEGRAM_ID` (pemilik).
- Output AI dianggap **tidak tepercaya** → wajib lolos validasi zod sebelum
  insert. Saat konfirmasi ditekan, batch **divalidasi ulang** (defense in depth).
- Dashboard dilindungi login password (cookie httpOnly berisi token HMAC).

## Setup

### 1. Prasyarat
- Node.js 20+
- Akun **Neon** (Postgres), **bot Telegram** (dari @BotFather), **Gemini API key**.

### 2. Install
```bash
npm install
```

### 3. Database
Jalankan migrasi SQL di `db/` (urut) pada project Neon-mu — termasuk pembuatan
enum, 5 tabel dengan kolom `GENERATED`, dan **dua role** `bot_writer` &
`web_reader` dengan hak akses masing-masing. Lihat berkas di folder `db/`.

### 4. Environment
Salin `.env.example` → `.env.local`, lalu isi:

| Variabel | Untuk | Keterangan |
|---|---|---|
| `DATABASE_URL_BOT` | bot | koneksi role `bot_writer` |
| `DATABASE_URL_WEB` | web | koneksi role `web_reader` (SELECT saja) |
| `TELEGRAM_BOT_TOKEN` | bot | token dari @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | bot | string acak panjang; dicek tiap update |
| `ALLOWED_TELEGRAM_ID` | bot | ID Telegram pemilik (satu-satunya yang boleh) |
| `GEMINI_API_KEY` | bot | fallback parser kalimat bebas |
| `GEMINI_MODEL` | bot | opsional, default `gemini-2.0-flash` |
| `DASHBOARD_PASSWORD` | web | password login dashboard |
| `PUBLIC_BASE_URL` | deploy | URL publik, mis. `https://es.vercel.app` |

### 5. Jalankan dev
```bash
npm run dev
```
Dashboard di `http://localhost:3000` (akan diarahkan ke `/login`).

### 6. Daftarkan webhook bot (setelah deploy publik)
Webhook butuh URL HTTPS publik. Setelah deploy (mis. Vercel), set `PUBLIC_BASE_URL`
lalu jalankan:
```bash
npm run set-webhook          # daftarkan webhook + secret_token
npm run set-webhook -- --info   # cek status
npm run set-webhook -- --delete # hapus
```

Untuk mencoba parser **tanpa** Telegram asli, kirim POST langsung ke
`/api/telegram` (mis. lewat PowerShell `Invoke-RestMethod` atau curl) dengan
header `X-Telegram-Bot-Api-Secret-Token` berisi secret-mu dan body update
Telegram palsu — secret salah harus ditolak 401, `from.id` bukan pemilik
diabaikan.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | jalankan Next.js dev server |
| `npm run build` | build produksi |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit test (vitest) parser & validasi |
| `npm run set-webhook` | daftarkan webhook Telegram |

## Contoh perintah bot

```
produksi 6 resep
kirim rumah->mts1 100        (mutasi stok, BUKAN penjualan)
lempar mts2->sma 15
jual mts1 100                (harga default 900)
jual sma batch 50            (SMA default 800, kelipatan 50)
jual smk 50 @800
uang mts1 90rb               (kas masuk)
beli bahan 20rb              (pengeluaran)
ambil ayah 31500 spp         (pengambilan → SPP)
```
Bot menampilkan ringkasan + tombol **✅ Simpan / ✏️ Ubah / ❌ Batal**. Tidak ada
data tersimpan tanpa konfirmasi.

## Perlu dikonfirmasi user (asumsi yang saya ambil)

- **Auth dashboard**: satu password (`DASHBOARD_PASSWORD`) + cookie token HMAC,
  tanpa tabel sesi. Memadai untuk pemakaian pribadi; kalau butuh multi-user atau
  revokasi sesi, perlu ditingkatkan.
- **Periode dashboard**: `hari` = hari ini, `minggu` = 7 hari terakhir, `bulan`
  = bulan berjalan (tgl 1 s/d hari ini). Semua zona **Asia/Jakarta**.
- **"Perlu dicek"**: kantin dengan omzet > kas masuk pada periode ditandai. Ini
  bukan error (SMA/SMK wajar bayar menyusul), hanya bantu audit.
- **Model Gemini** default `gemini-2.0-flash`; ganti lewat `GEMINI_MODEL`.
- **Batas konfirmasi**: batch yang di-encode ke tombol dibatasi 64 byte (limit
  Telegram). Catatan (note) tidak ikut di tombol konfirmasi.
