-- ============================================================================
-- Es Lilin Tracker — Migrasi 0006: ENUM location → text + FK ke location_ref
-- Jalankan di Neon SQL editor dengan role OWNER, SETELAH 0005.
--
-- PRASYARAT: tabel transaksi KOSONG (keputusan "mulai bersih"). Jalankan
-- db/reset_data.sql lebih dulu bila ada sisa data — kalau tidak, pemasangan FK
-- akan gagal untuk kode yang belum ada di location_ref.
--
-- APA: kolom lokasi yang dulu bertipe ENUM `location` diubah jadi `text` lalu
-- diikat FK ke location_ref(code). Tipe ENUM dihapus. Aturan "penjualan/kas
-- hanya ke kantin (bukan gudang)" yang dulu di-hardcode `CHECK (canteen <>
-- 'rumah')` diganti FK-SUBSET komposit ke location_ref(code, is_canteen) —
-- data-driven, tanpa menyebut 'rumah' di kode.
-- ============================================================================

-- ----- 1. Lepaskan kolom dari tipe ENUM: ubah jadi text -----
-- USING c::text mengonversi nilai lama (aman walau tabel kosong).
ALTER TABLE stock_movement
  ALTER COLUMN from_loc TYPE text USING from_loc::text,
  ALTER COLUMN to_loc   TYPE text USING to_loc::text;

-- sale.canteen & cash_in.canteen punya CHECK (canteen <> 'rumah') yang mengacu
-- tipe ENUM — DROP dulu sebelum ubah tipe, ganti dengan FK-subset di langkah 4.
ALTER TABLE sale    DROP CONSTRAINT IF EXISTS sale_canteen_check;
ALTER TABLE cash_in DROP CONSTRAINT IF EXISTS cash_in_canteen_check;

ALTER TABLE sale    ALTER COLUMN canteen TYPE text USING canteen::text;
ALTER TABLE cash_in ALTER COLUMN canteen TYPE text USING canteen::text;

-- ----- 2. Hapus tipe ENUM yang sudah tak dipakai -----
DROP TYPE IF EXISTS location;

-- ----- 3. FK lokasi bebas (mutasi boleh dari/ke gudang maupun kantin) -----
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_from_fk
    FOREIGN KEY (from_loc) REFERENCES location_ref (code),
  ADD CONSTRAINT stock_movement_to_fk
    FOREIGN KEY (to_loc)   REFERENCES location_ref (code);

-- ----- 4. FK-subset: sale/cash_in hanya boleh ke lokasi is_canteen = true -----
-- Kolom generated bernilai konstan true; FK komposit (canteen, true) hanya cocok
-- dengan baris location_ref yang is_canteen=true (di-UNIQUE-kan di 0005).
-- Efek: menulis penjualan/kas ke 'rumah' (is_canteen=false) DITOLAK DB.
ALTER TABLE sale
  ADD COLUMN canteen_is_canteen boolean GENERATED ALWAYS AS (true) STORED;
ALTER TABLE sale
  ADD CONSTRAINT sale_canteen_fk
    FOREIGN KEY (canteen, canteen_is_canteen)
    REFERENCES location_ref (code, is_canteen);

ALTER TABLE cash_in
  ADD COLUMN canteen_is_canteen boolean GENERATED ALWAYS AS (true) STORED;
ALTER TABLE cash_in
  ADD CONSTRAINT cash_in_canteen_fk
    FOREIGN KEY (canteen, canteen_is_canteen)
    REFERENCES location_ref (code, is_canteen);

-- Catatan:
-- * CHECK (from_loc <> to_loc) di stock_movement TETAP (perbandingan antar-kolom,
--   tak terkait ENUM) — tidak perlu diubah.
-- * Semua CHECK numerik (qty>0, price_rp>0, dst.) tetap berlaku.
