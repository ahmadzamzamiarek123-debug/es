# Es Lilin Tracker — Project Specification

> Baca file ini **sampai habis** sebelum menulis kode. Aturan pengerjaan ada di `CLAUDE.md` (baca itu juga). File ini = APA yang dibangun. `CLAUDE.md` = BAGAIMANA cara mengerjakannya.

---

## 1. Ringkasan & tujuan

Usaha **es lilin** dititipkan ke **5 kantin sekolah**. Pemilik (satu orang, dibantu adik) butuh sistem pencatatan yang:

- **Mudah input** lewat **bot Telegram** (chat bahasa bebas, AI ubah jadi baris database).
- **Mudah dibaca** lewat **web dashboard** (grafik, tabel, laporan bulanan).
- **Satu sumber data** (Neon PostgreSQL). Kalau bot salah input, langsung terlihat & bisa dikoreksi via web.
- **100% gratis** (Neon free tier + Vercel free tier + Gemini free tier).

Bot = jalur **tulis**. Web = jalur **baca**. Keduanya menunjuk ke database yang sama.

---

## 2. Konteks bisnis (WAJIB dipahami, ini bagian tersulit)

Kantin (sekolah) **7+** + rumah (gudang). Daftar kantin **bukan lagi nilai tetap**:
tersimpan di tabel `location_ref` dan dikelola pemilik lewat `/setting` (kode,
nama, harga, penanda batch 50). Migrasi hanya menyeed gudang `rumah`; semua
kantin/sekolah didaftarkan pemilik. Contoh bentuk kantin:

| Bentuk | Harga jual (omzet kita) | Catatan |
|---|---|---|
| wadah biasa | default **Rp1.300/biji** | es dibawa pulang, sisa bisa dihitung |
| **kulkas** | default **Rp1.300/biji** | pakai model **batch 50**, stok fisik tidak dihitung |

- **Harga jual = omzet kita** (yang disimpan di `price_rp`). Harga eceran ke
  siswa (mis. Rp1.500) **tidak** disimpan. Harga **tidak di-hardcode** selain
  default; harga default per kantin diatur lewat `/setting` dan disalin ke tiap
  baris penjualan (bisa berbeda per kantin & berubah).

### Aturan domain penting

1. **Produksi per resep.** Tiap malam buat 4–8 resep. 1 resep = **40 biji**. Upah = **Rp5.000/resep untuk tiap orang** (Zummy + Aril) = **Rp10.000/resep bila berdua**. Produksi mencatat `worker` (`berdua|zummy|aril`); DB menghitung `wage_zummy_rp` & `wage_aril_rp` terpisah.
2. **Mutasi ≠ Penjualan.** Es sering dipindah antar kantin (mis. sisa dilempar ke kantin lain agar tidak balik rumah). Perpindahan dicatat sebagai **mutasi stok**, BUKAN penjualan, supaya tidak dobel hitung.
3. **Model batch 50 (kantin berkulkas, mis. SMA & SMK).** Karena stok fisik tidak dihitung, penagihan **selalu genap kelipatan 50**. Penanda batch 50 diatur per kantin lewat `/setting`.
4. **Uang bisa beda hari.** Terutama kantin batch 50: uang diterima saat pengisian berikutnya. Maka **Penjualan** (kapan terjual) dan **Kas Masuk** (kapan uang diterima) dipisah.
5. **MTS2 dicatat normal** seperti kantin lain (penjualan + kas masuk biasa). **Pengambilan ayah** (owner draw untuk SPP) diinput **manual** sebagai `cash_out` `kind='pengambilan'` `category='spp_ayah'` — tidak lagi otomatis dari MTS2.
6. **Saldo awal (modal).** Baseline modal (kas + nilai bahan awal) sebagai titik-nol **satu kali**, diisi lewat `/setting saldo`. Bukan pelacakan stok bahan.

### Rumus laporan inti

```
Laba usaha  = Omzet (total penjualan) − Biaya (pengeluaran + upah produksi)
Kas tersisa = Saldo awal + Laba usaha − Pengambilan (owner draw, mis. SPP)
```

Insight yang harus bisa dibuktikan dashboard: laba usaha biasanya **positif**, tapi kas terasa habis karena **pengambilan menyedot laba**.

---

## 3. Arsitektur

```
         ┌─────────────┐   webhook (HTTPS POST)   ┌───────────────────────┐
  Kamu → │  Telegram    │ ───────────────────────▶ │  /api/telegram (Vercel │
  chat   │  Bot         │                          │  serverless, grammY)   │
         └─────────────┘                          │  - verifikasi secret   │
                                                   │  - cek allowed user id │
                                                   │  - parse (Gemini flash)│
                                                   │  - validasi (zod)      │
                                                   │  - konfirmasi (inline) │
                                                   │  - INSERT (bot_writer) │
                                                   └───────────┬───────────┘
                                                               │ SQL (TLS)
                                                               ▼
                                                   ┌───────────────────────┐
                                                   │   Neon PostgreSQL      │
                                                   │   (single source)      │
                                                   └───────────┬───────────┘
                                                               │ SELECT (web_reader, read-only)
                                                               ▼
         ┌─────────────┐                          ┌───────────────────────┐
  Kamu → │  Browser    │ ───────────────────────▶ │  Web dashboard (Vercel │
  lihat  │             │                          │  Next.js + Recharts)   │
         └─────────────┘                          └───────────────────────┘
```

- **Tanpa VPS.** Bot pakai mode **webhook** (bukan polling), jadi cukup serverless function di Vercel.
- **Grafik/riwayat tidak memanggil Gemini** — web query langsung ke DB. Gemini hanya dipakai bot untuk parsing input bahasa bebas (dan opsional tanya-jawab).

---

## 4. Tech stack (WAJIB, jangan diganti)

| Bagian | Pilihan | Alasan |
|---|---|---|
| Bahasa | **TypeScript** (strict) | 1 bahasa untuk bot + web, aman tipe |
| Framework | **Next.js (App Router)** | web + API route bot dalam 1 project & 1 deploy |
| DB | **Neon PostgreSQL** | gratis, serverless |
| DB driver | **`@neondatabase/serverless`** | driver HTTP, aman untuk serverless (hindari `pg` biasa) |
| ORM/query | **Drizzle ORM** | ringan, type-safe (SQL manual berparameter juga boleh) |
| Validasi | **zod** | validasi output AI & input sebelum insert |
| Bot | **grammY** (mode webhook) | ringan, dukungan webhook & inline keyboard bagus |
| AI | **`@google/generative-ai`**, model `gemini-2.0-flash` (default; override `GEMINI_MODEL`) | free tier, cepat, murah token |
| Grafik | **SVG/CSS server-render** (tanpa Recharts, demi bundel ringan) | gratis, First Load kecil |
| Deploy | **Vercel** | gratis, native Next.js |

**Batasan:** semua harus muat di **free tier**. Jangan tambahkan layanan berbayar atau dependency berat yang tidak perlu.

---

## 5. Skema database (Neon PostgreSQL)

> File migrasi `0001_init.sql` di bawah adalah bentuk **AWAL** (historis). Skema
> berjalan sekarang sudah **berevolusi** lewat migrasi `0003`–`0008`. Perubahan
> penting terhadap blok di bawah:
>
> - **Upah (0007):** `wage_rp` = `recipes * 5000` (per orang) + `worker`
>   (`berdua|zummy|aril`) + kolom `wage_zummy_rp` & `wage_aril_rp` (berdua =
>   `recipes*10000`). Menggantikan `recipes * 6000`.
> - **Lokasi (0005–0006):** ENUM `location` **dihapus**, diganti tabel referensi
>   `location_ref(code, label, is_canteen, is_warehouse, is_batch50, price_rp,
>   active, …)`. Kolom `from_loc`/`to_loc`/`canteen` jadi `text` + **FK** ke
>   `location_ref(code)`. Aturan "kantin bukan gudang" ditegakkan via **FK-subset**
>   ke `location_ref(code, is_canteen)` (bukan `CHECK canteen <> 'rumah'`).
> - **Saldo awal (0008):** tabel satu-baris `opening_balance(id=1, saldo_awal_rp,
>   note, updated_at)` untuk baseline modal.
> - **pending_confirm (0004):** tabel state konfirmasi bot.
>
> Blok di bawah dipertahankan sebagai catatan sejarah `0001`.

```sql
-- ===== ENUM (0001; catatan: enum `location` dihapus di 0006) =====
CREATE TYPE location AS ENUM ('rumah','mts1','mts2','smp','sma','smk');
CREATE TYPE payment_method AS ENUM ('cash','transfer');
CREATE TYPE cashout_kind AS ENUM ('pengeluaran','pengambilan');
CREATE TYPE expense_category AS ENUM
  ('bahan','gas_listrik','plastik','transport','spp_ayah','lainnya');

-- 1. Produksi
CREATE TABLE production (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prod_date     date     NOT NULL,
  recipes       smallint NOT NULL CHECK (recipes > 0),
  output_pieces int GENERATED ALWAYS AS (recipes * 40)   STORED,
  wage_rp       int GENERATED ALWAYS AS (recipes * 6000) STORED,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 2. Mutasi stok
CREATE TABLE stock_movement (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  move_date  date     NOT NULL,
  from_loc   location NOT NULL,
  to_loc     location NOT NULL,
  qty        smallint NOT NULL CHECK (qty > 0),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_loc <> to_loc)
);

-- 3. Penjualan
CREATE TABLE sale (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_date  date     NOT NULL,
  canteen    location NOT NULL CHECK (canteen <> 'rumah'),
  qty        smallint NOT NULL CHECK (qty >= 0),
  price_rp   smallint NOT NULL CHECK (price_rp > 0),
  total_rp   int GENERATED ALWAYS AS (qty * price_rp) STORED,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Kas masuk
CREATE TABLE cash_in (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_date date     NOT NULL,
  canteen       location NOT NULL CHECK (canteen <> 'rumah'),
  amount_rp     int      NOT NULL CHECK (amount_rp > 0),
  method        payment_method NOT NULL DEFAULT 'cash',
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 5. Pengeluaran & Pengambilan
CREATE TABLE cash_out (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  out_date   date     NOT NULL,
  kind       cashout_kind     NOT NULL,
  category   expense_category NOT NULL,
  amount_rp  int      NOT NULL CHECK (amount_rp > 0),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index laporan
CREATE INDEX idx_prod_date    ON production     (prod_date);
CREATE INDEX idx_move_date    ON stock_movement (move_date);
CREATE INDEX idx_sale_date    ON sale           (sale_date);
CREATE INDEX idx_cashin_date  ON cash_in        (received_date);
CREATE INDEX idx_cashout_date ON cash_out       (out_date);
```

Role keamanan (dibuat user di Neon, ada di `db/migrations/0002_roles.sql`):

```sql
CREATE ROLE bot_writer LOGIN PASSWORD 'GANTI';
GRANT INSERT, SELECT, UPDATE, DELETE
  ON production, stock_movement, sale, cash_in, cash_out TO bot_writer;

CREATE ROLE web_reader LOGIN PASSWORD 'GANTI';
GRANT SELECT
  ON production, stock_movement, sale, cash_in, cash_out TO web_reader;
```

---

## 6. Perilaku bot Telegram

### Endpoint
`POST /api/telegram` (App Router route handler). Mode **webhook**.

### Keamanan (lihat detail di CLAUDE.md)
1. Verifikasi header `X-Telegram-Bot-Api-Secret-Token` == `TELEGRAM_WEBHOOK_SECRET`. Kalau tidak cocok → balas 401, berhenti.
2. Cek `ctx.from.id` == `ALLOWED_TELEGRAM_ID`. Kalau bukan → abaikan.

### Alur input (state machine sederhana)
1. User kirim pesan (mis. `"kirim mts1 100, mts2 50"` atau `"jual sma batch 50"` atau `"beli bahan 20rb"`).
2. **Coba parse tanpa AI dulu** (regex untuk format rapi & command). Kalau gagal/kalimat bebas → panggil **Gemini** untuk ubah jadi JSON terstruktur.
3. **Validasi** hasil dengan zod + cek enum & rentang wajar.
4. **Konfirmasi**: bot balas ringkasan + inline keyboard **[✅ Simpan] [✏️ Ubah] [❌ Batal]**.
5. Kalau Simpan → INSERT (berparameter) → balas sukses + id baris.
6. Kalau ada beberapa item (mis. 2 mutasi sekaligus) → tampilkan semuanya, simpan sebagai batch (transaction).

### Perintah yang didukung (minimal)
- `/start`, `/help` — bantuan singkat & contoh format.
- **Produksi**: `"produksi 6 resep"` → production.
- **Mutasi/kirim**: `"kirim rumah->mts1 100"`, `"lempar mts2->sma 15"`.
- **Penjualan**: `"jual mts1 100"` (harga default per kantin, mis. 1300), `"jual sma 50 @1300"`.
- **Kas masuk**: `"uang mts1 90rb"`.
- **Pengeluaran**: `"beli bahan 20rb"`, `"ambil ayah 31500 spp"` (→ cash_out pengambilan).
- Tanggal default = hari ini (timezone **Asia/Jakarta**); boleh sebut "kemarin".

### Kontrak JSON hasil parse (contoh)
```json
{
  "entity": "sale",
  "rows": [
    { "sale_date": "2026-07-14", "canteen": "sma", "qty": 50, "price_rp": 1300, "note": "batch 50" }
  ]
}
```
`entity` ∈ `production | stock_movement | sale | cash_in | cash_out`. Selalu berupa array `rows`.
`canteen`/`from_loc`/`to_loc` = kode `location_ref` (bukan lagi enum tetap); harga `price_rp` = omzet kita.

### Error handling
- Jangan pernah kirim error mentah DB ke chat. Balas pesan ramah + minta ulang.
- Kalau AI ragu / data kurang → tanya balik field yang kurang, jangan menebak nilai uang/qty.

---

## 7. Web dashboard (read-only)

kuti gaya visual pada design/ui-mockup.html (warna, layout kartu, jenis grafik, mobile-first). Implementasikan ulang dengan Recharts + React, bukan copy JS-nya.
Semua halaman pakai role **`web_reader`** (SELECT saja) + dilindungi login sederhana.

Halaman:
1. **Dashboard** (`/`):
   - Kartu angka: Omzet bulan ini, Pengeluaran, Upah, Laba usaha, Pengambilan, **Kas tersisa**.
   - Grafik garis: omzet harian.
   - Grafik batang: penjualan per kantin.
   - Donut: komposisi pengeluaran per kategori.
2. **Transaksi** (`/transaksi`): tabel gabungan terbaru dari 5 tabel, filter tanggal & jenis. Termasuk view **"Perlu dicek"** (mis. penjualan tanpa kas masuk terkait, atau mutasi mencurigakan).
3. **Laporan bulanan** (`/laporan`): tabel omzet → biaya → laba → pengambilan → kas tersisa, bisa pilih bulan. Bisa export CSV.
4. Filter periode: harian / mingguan / bulanan / rentang tanggal.

---

## 8. Environment variables

```
# Database (dua koneksi berbeda role)
DATABASE_URL_BOT=postgres://bot_writer:...@...neon.tech/db?sslmode=require
DATABASE_URL_WEB=postgres://web_reader:...@...neon.tech/db?sslmode=require

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...        # string acak panjang
ALLOWED_TELEGRAM_ID=123456789      # user id Telegram pemilik

# Gemini
GEMINI_API_KEY=...

# Web auth
DASHBOARD_PASSWORD=...             # atau mekanisme auth sederhana lain
```

Buat juga `.env.example` (tanpa nilai rahasia). `.env` harus masuk `.gitignore`.

---

## 9. Struktur folder (usulan)

```
es-lilin/
├─ app/
│  ├─ api/telegram/route.ts       # webhook bot
│  ├─ (dashboard)/page.tsx        # dashboard
│  ├─ transaksi/page.tsx
│  ├─ laporan/page.tsx
│  └─ login/route.ts | page.tsx
├─ lib/
│  ├─ db.ts                       # koneksi neon (bot & web terpisah)
│  ├─ schema.ts                   # drizzle schema
│  ├─ parse.ts                    # regex + Gemini parser → JSON
│  ├─ validate.ts                 # zod schema per entity
│  ├─ insert.ts                   # insert berparameter / drizzle
│  ├─ reports.ts                  # query laporan
│  └─ telegram.ts                 # setup grammY, keyboard, handlers
├─ db/migrations/
│  ├─ 0001_init.sql
│  └─ 0002_roles.sql
├─ scripts/
│  └─ set-webhook.ts              # daftarkan webhook + secret_token
├─ .env.example
├─ CLAUDE.md
└─ PROJECT.md
```

---

## 10. Urutan pengerjaan (build order)

1. Init project Next.js + TypeScript strict + deps.
2. `db/migrations/*.sql` (schema + roles) + `.env.example`.
3. `lib/db.ts`, `lib/schema.ts` (drizzle).
4. `lib/validate.ts` (zod), `lib/parse.ts` (regex dulu, Gemini fallback), `lib/insert.ts`.
5. `lib/telegram.ts` + `app/api/telegram/route.ts` (auth → parse → confirm → insert).
6. `scripts/set-webhook.ts`.
7. Web: `lib/reports.ts`, dashboard, transaksi, laporan, login.
8. README singkat: cara set env, jalankan migrasi, set webhook, deploy.

---

## 11. Yang dikerjakan user (JANGAN dilakukan Claude Code)

- Membuat project Neon & menjalankan migrasi SQL.
- Mengisi nilai environment variables asli.
- Membuat bot Telegram (BotFather) & mengambil token.
- Deploy ke Vercel & set env di Vercel.
- Menjalankan `scripts/set-webhook.ts` setelah deploy.
- Testing end-to-end.

Claude Code cukup **menulis kode + migrasi + dokumentasi** yang siap dijalankan.
