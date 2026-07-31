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
Kas tersisa = Saldo awal + Laba usaha − Pengambilan
```

- **Upah produksi** dihitung DB **per orang**: `recipes × 5000` tiap orang, jadi
  `recipes × 10000` bila dikerjakan **berdua** (Zummy + Aril). Kolom `wage_zummy_rp`
  & `wage_aril_rp` dihitung terpisah sesuai `worker` (`berdua|zummy|aril`).
- **Output** dihitung DB: `recipes × 40` biji.
- **Harga jual** yang disimpan = **omzet kita** (default kantin **Rp1.300/biji**;
  bisa diubah per kantin lewat `/setting`). Harga eceran ke siswa (mis. Rp1.500)
  **tidak** disimpan.
- **Saldo awal** = modal awal (kas + nilai bahan yang sudah dimiliki) sebagai
  titik-nol satu kali. Diisi lewat `/setting saldo`. Tidak melacak stok bahan.
- **Pengambilan** (mis. uang diambil Ayah untuk SPP) adalah *owner draw* —
  mengurangi kas tersisa, **bukan** laba usaha. Diinput manual (`ambil ...`).
- **Kantin batch 50** (mis. SMA & SMK): qty penjualan wajib kelipatan 50; stok
  fisiknya tidak dilacak. Ditandai lewat `/setting` (`batch50`).
- **Lokasi/kantin bukan lagi nilai tetap** — tersimpan di tabel `location_ref`
  dan dikelola lewat `/setting` (mendukung 7+ sekolah). Migrasi hanya menyeed
  gudang `rumah`; semua kantin diisi pemilik.
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
- **Penjualan & kas masuk hanya boleh ke kantin**, ditegakkan berlapis: validasi
  zod/ctx di aplikasi **dan** di level DB lewat FK-subset ke
  `location_ref(code, is_canteen)` (bukan `CHECK` hardcode `<> 'rumah'`).
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
Jalankan migrasi SQL di `db/migrations/` (urut `0001` → `0008`) pada project
Neon-mu. Ini membuat 5 tabel transaksi dengan kolom `GENERATED`, tabel
`pending_confirm`, tabel referensi lokasi `location_ref` (menggantikan enum
lokasi; kolom lokasi jadi `text` + FK), upah 5.000/orang, tabel `opening_balance`
(saldo awal), serta **dua role** `bot_writer` & `web_reader` dengan hak akses
masing-masing. Lihat berkas di folder `db/`.

Setelah migrasi, DB baru berisi gudang `rumah` saja. Daftarkan kantin/sekolah
dan saldo awal lewat bot dengan `/setting` (lihat bagian di bawah).

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

**Input transaksi** (regex/AI → konfirmasi → simpan):
```
produksi 6 resep                   (default berdua; 10rb upah)
produksi 4 resep sendiri           (Zummy saja; 5rb upah)
kirim rumah->mts1 100              (mutasi stok, BUKAN penjualan)
lempar mts2->sma 15                (antar kantin)
jual mts1 100                      (harga default per kantin, mis. 1300)
jual sma batch 50                  (SMA batch 50 → qty kelipatan 50)
jual smk 50 @1300                  (override harga)
uang mts1 90rb                     (kas masuk)
beli bahan 20rb                    (pengeluaran)
ambil ayah 31500 spp               (pengambilan → owner draw)
```
Bot menampilkan ringkasan + tombol **✅ Simpan / ✏️ Ubah / ❌ Batal**. Tidak ada
data tersimpan tanpa konfirmasi.

**Pertanyaan** (deterministik, tanpa AI):
```
cek stok
ringkasan hari ini
kemarin mts1 kirim berapa
mts1 jual berapa hari ini
transaksi terakhir               (tampil id untuk ralat)
```

**Revisi** (hapus/ubah via id):
```
undo                             (hapus transaksi terakhir)
hapus jual 42
ubah produksi 12 jadi 5 resep
```

**Konfigurasi** (`/setting` — satu kali, owner):
```
/setting lokasi sdn1 "SDN 1 Makmur" 1300       (daftarkan kantin)
/setting lokasi sma "SMA Negeri 1" 1300 batch50
/setting hapuslokasi sdn1                      (soft-delete)
/setting saldo 500000                          (modal awal, one-time)
/setting                                       (help + daftar kantin)
```
Gudang `rumah` sudah ada dari migrasi; sekolah didaftarkan via `/setting`.
Harga default 1300 (omzet kita/biji). Batch 50 untuk kantin dengan kulkas besar.

## Perlu dikonfirmasi user (asumsi yang saya ambil)

- **Auth dashboard**: satu password (`DASHBOARD_PASSWORD`) + cookie token HMAC,
  tanpa tabel sesi. Memadai untuk pemakaian pribadi; kalau butuh multi-user atau
  revokasi sesi, perlu ditingkatkan.
- **Periode dashboard**: `hari` = hari ini, `minggu` = 7 hari terakhir, `bulan`
  = bulan berjalan (tgl 1 s/d hari ini). Semua zona **Asia/Jakarta**.
- **"Perlu dicek"**: kantin dengan omzet > kas masuk pada periode ditandai. Ini
  bukan error (SMA/SMK wajar bayar menyusul), hanya bantu audit.
- **Model Gemini** default `gemini-2.0-flash`; ganti lewat `GEMINI_MODEL`.
- **Harga & saldo awal diisi pemilik**: default harga kantin Rp1.300/biji hanya
  contoh — nilai sebenarnya diset per kantin lewat `/setting`. Saldo awal (modal)
  wajib diisi sekali lewat `/setting saldo` agar "kas tersisa" akurat; sebelum
  diisi, saldo awal dianggap 0.
- **Batas konfirmasi**: batch yang di-encode ke tombol dibatasi 64 byte (limit
  Telegram). Catatan (note) tidak ikut di tombol konfirmasi.
