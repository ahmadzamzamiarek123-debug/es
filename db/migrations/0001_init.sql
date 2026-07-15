-- ============================================================================
-- Es Lilin Tracker — Migrasi 0001: skema awal
-- Jalankan di Neon SQL editor / psql dengan role OWNER (pemilik project Neon).
-- Uang = integer rupiah (tanpa desimal). Kolom hitung otomatis pakai GENERATED.
-- ============================================================================

-- ===== ENUM: hemat ruang + validasi otomatis =====
CREATE TYPE location AS ENUM ('rumah','mts1','mts2','smp','sma','smk');
CREATE TYPE payment_method AS ENUM ('cash','transfer');
CREATE TYPE cashout_kind AS ENUM ('pengeluaran','pengambilan');
CREATE TYPE expense_category AS ENUM
  ('bahan','gas_listrik','plastik','transport','spp_ayah','lainnya');

-- ===== 1. Produksi (per resep) =====
-- 1 resep = 40 biji; upah = Rp6.000/resep (Rp3.000 x 2 orang). Dihitung DB.
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
-- Perpindahan es antar lokasi. Tidak menambah omzet/kas.
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
-- price_rp disimpan per baris (bisa beda per kantin & berubah). total dihitung DB.
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

-- ===== 4. Kas masuk (uang benar-benar diterima; bisa beda hari dgn penjualan) =====
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
-- kind='pengeluaran' = biaya usaha (mengurangi laba).
-- kind='pengambilan' = owner draw (mis. uang MTS2 diambil ayah utk SPP): TIDAK
--   mengurangi laba usaha, hanya mengurangi kas tersisa.
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
