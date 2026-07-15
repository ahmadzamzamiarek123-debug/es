# Desain Database Neon (PostgreSQL) — Es Lilin

<aside>
🗄️

Skema database untuk Neon (PostgreSQL). Prinsip: **efisien** (tipe data sekecil mungkin, kolom hitung otomatis, index seperlunya) + **aman** (peran terpisah bot vs web, validasi, secret di env). Bot menulis, web membaca — satu sumber data.

</aside>

## Keputusan efisiensi (kenapa begini)

- **Uang disimpan `int` rupiah** (tanpa desimal). Rupiah tak butuh koma, jadi hindari `float`/`numeric` yang lebih berat & rawan pembulatan.
- **Angka kecil pakai `smallint`** (qty, resep, harga). Cukup sampai 32.767, hemat ruang.
- **Kolom hitung otomatis** pakai `GENERATED ALWAYS AS ... STORED` (output biji, upah, total). Jadi tidak dihitung di aplikasi & **tidak mungkin meleset** dari rumus.
- **`ENUM`** untuk lokasi/metode/kategori: hemat (4 byte), sekaligus menolak nilai typo.
- **Satu enum `location`** dipakai ulang untuk mutasi & kantin (kantin cukup dibatasi `CHECK <> 'rumah'`), jadi tidak ada tabel referensi tambahan.
- **Index hanya di kolom tanggal** (dipakai untuk laporan). Tidak over-index biar tulis tetap cepat.
- **`GENERATED ALWAYS AS IDENTITY`** untuk primary key: lebih ringan & aman daripada `serial`.

## Skema tabel (DDL)

```sql
-- ===== ENUM: hemat ruang + validasi otomatis =====
CREATE TYPE location AS ENUM ('rumah','mts1','mts2','smp','sma','smk');
CREATE TYPE payment_method AS ENUM ('cash','transfer');
CREATE TYPE cashout_kind AS ENUM ('pengeluaran','pengambilan');
CREATE TYPE expense_category AS ENUM
  ('bahan','gas_listrik','plastik','transport','spp_ayah','lainnya');

-- ===== 1. Produksi (per resep) =====
CREATE TABLE production (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prod_date     date     NOT NULL,
  recipes       smallint NOT NULL CHECK (recipes > 0),
  output_pieces int GENERATED ALWAYS AS (recipes * 40)   STORED,
  wage_rp       int GENERATED ALWAYS AS (recipes * 6000) STORED,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ===== 2. Mutasi stok (pindah lokasi, BUKAN penjualan) =====
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

-- ===== 3. Penjualan =====
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

-- ===== 4. Kas masuk (uang benar-benar diterima) =====
CREATE TABLE cash_in (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_date date     NOT NULL,
  canteen       location NOT NULL CHECK (canteen <> 'rumah'),
  amount_rp     int      NOT NULL CHECK (amount_rp > 0),
  method        payment_method NOT NULL DEFAULT 'cash',
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ===== 5. Pengeluaran & Pengambilan =====
CREATE TABLE cash_out (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  out_date   date     NOT NULL,
  kind       cashout_kind     NOT NULL,
  category   expense_category NOT NULL,
  amount_rp  int      NOT NULL CHECK (amount_rp > 0),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Index laporan (ringan, hanya kolom tanggal) =====
CREATE INDEX idx_prod_date    ON production     (prod_date);
CREATE INDEX idx_move_date    ON stock_movement (move_date);
CREATE INDEX idx_sale_date    ON sale           (sale_date);
CREATE INDEX idx_cashin_date  ON cash_in        (received_date);
CREATE INDEX idx_cashout_date ON cash_out       (out_date);
```

---

## 🔐 KEAMANAN (ini yang paling penting)

<aside>
🚨

**Aturan emas:** bot & web JANGAN pakai role pemilik (owner) Neon. Buat 2 role terbatas — bot cuma boleh tulis data, web cuma boleh baca. Kalau salah satu bocor, kerusakannya terbatas.

</aside>

### 1. Dua peran database (least privilege)

```sql
-- BOT: boleh tulis & koreksi data transaksi, TIDAK boleh hapus tabel/ubah struktur
CREATE ROLE bot_writer LOGIN PASSWORD 'GANTI_password_kuat_1';
GRANT INSERT, SELECT, UPDATE, DELETE
  ON production, stock_movement, sale, cash_in, cash_out
  TO bot_writer;

-- WEB: HANYA baca (read-only). Kalau web dibobol, data tak bisa diubah
CREATE ROLE web_reader LOGIN PASSWORD 'GANTI_password_kuat_2';
GRANT SELECT
  ON production, stock_movement, sale, cash_in, cash_out
  TO web_reader;
```

> Karena PK memakai `GENERATED ... IDENTITY`, hak `INSERT` sudah cukup (tidak perlu grant sequence terpisah seperti `serial`).
> 

### 2. Autentikasi bot Telegram (WAJIB, 2 lapis)

<aside>
🛡️

URL webhook itu publik. Tanpa proteksi, siapa pun yang tahu URL-nya bisa mengirim data palsu ke database-mu.

</aside>

- **Lapis 1 — Secret token webhook.** Saat set webhook, isi `secret_token`. Telegram akan mengirim header `X-Telegram-Bot-Api-Secret-Token` di tiap request. **Tolak** request yang headernya tidak cocok.
- **Lapis 2 — Whitelist ID Telegram-mu.** Ini kontrol terpenting: cek `message.from.id`, hanya terima perintah dari **ID milikmu sendiri**. Walau URL bocor, orang lain tetap tak bisa menulis data.

### 3. Perlakukan output AI sebagai DATA TAK TERPERCAYA

- **Selalu pakai query berparameter** (`$1, $2, ...`) atau ORM (Drizzle). **JANGAN** pernah menyambung string user/AI ke SQL → mencegah SQL injection.
- **Validasi hasil parsing Gemini sebelum insert:** lokasi harus ada di enum, qty/uang berupa angka wajar (mis. 0–1000 biji, uang > 0), tanggal valid. Kalau tidak lolos → minta konfirmasi ulang, jangan langsung simpan.
- **Langkah konfirmasi bot** (“Simpan ini? Ya/Batal”) sekaligus jadi lapisan keamanan terhadap salah tangkap AI.

### 4. Rahasia (secrets) & koneksi

- Simpan semua di **Environment Variables Vercel**, bukan di kode: `DATABASE_URL_BOT`, `DATABASE_URL_WEB`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `ALLOWED_TELEGRAM_ID`.
- **`.env` masuk `.gitignore`** — jangan pernah commit token/API key ke GitHub.
- **Koneksi wajib TLS**: pakai `?sslmode=require` (default Neon). Gunakan **connection string pooled** milik Neon untuk serverless.
- **Jangan bocorkan error mentah** database ke balasan Telegram atau log publik (bisa membocorkan struktur/kredensial).

### 5. Lindungi dashboard web

<aside>
🔒

Web menampilkan keuangan usahamu. Jangan biarkan publik.

</aside>

- Beri **login sederhana / password** (atau Vercel Password Protection). Minimal satu secret akses.
- Web memakai role **`web_reader` (SELECT saja)** — jadi walau dibobol, tak ada yang bisa diubah/hapus.

### 6. Cadangan (backup)

- Aktifkan **Point-in-Time Restore / branching** Neon. Kalau salah hapus/koreksi massal, bisa dikembalikan.

---

## Contoh insert yang AMAN (berparameter)

```tsx
// contoh: simpan penjualan, pakai parameter ($1..$4), bukan string gabung
await sql`
  INSERT INTO sale (sale_date, canteen, qty, price_rp)
  VALUES (${saleDate}, ${canteen}, ${qty}, ${priceRp})
`;
// canteen sudah divalidasi ada di enum, qty & priceRp sudah dipastikan angka
```

## Contoh query laporan bulanan (dibaca web, tanpa Gemini)

```sql
-- Omzet, biaya, laba, pengambilan, kas tersisa per bulan
SELECT
  (SELECT COALESCE(SUM(total_rp),0) FROM sale
     WHERE date_trunc('month', sale_date) = date_trunc('month', $1::date)) AS omzet,
  (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
     WHERE kind='pengeluaran'
       AND date_trunc('month', out_date) = date_trunc('month', $1::date)) AS pengeluaran,
  (SELECT COALESCE(SUM(wage_rp),0) FROM production
     WHERE date_trunc('month', prod_date) = date_trunc('month', $1::date)) AS upah,
  (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
     WHERE kind='pengambilan'
       AND date_trunc('month', out_date) = date_trunc('month', $1::date)) AS pengambilan;
-- laba usaha = omzet - pengeluaran - upah ; kas tersisa = laba usaha - pengambilan
```