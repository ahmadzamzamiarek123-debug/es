-- ============================================================================
-- Es Lilin Tracker — Migrasi 0003: bersih data test, upah per orang, pending
-- Jalankan di Neon SQL editor dengan role OWNER, SETELAH 0002_roles.sql.
--
-- Isi:
--   A. TRUNCATE semua tabel transaksi (data sebelumnya hanya test).
--   B. Kolom `worker` di production (berdua/zummy/aril) + upah per orang.
--      Upah Rp3.000/resep per orang yang ikut mengerjakan:
--        berdua → Zummy 3000 + Aril 3000 = 6000/resep (sama seperti dulu)
--        zummy  → Zummy 3000, Aril 0
--        aril   → Aril 3000, Zummy 0
--   C. Tabel `pending_confirm`: penampung sementara batch tervalidasi yang
--      menunggu tombol ✅ Simpan di Telegram (callback_data hanya membawa id
--      pendek karena batas 64 byte). Dibersihkan setelah dipakai/kedaluwarsa.
-- ============================================================================

-- ---- A. Bersihkan data test ----
TRUNCATE production, stock_movement, sale, cash_in, cash_out RESTART IDENTITY;

-- ---- B. Upah per orang ----
CREATE TYPE worker AS ENUM ('berdua','zummy','aril');

ALTER TABLE production
  ADD COLUMN worker worker NOT NULL DEFAULT 'berdua';

-- wage_rp lama (recipes*6000) diganti perhitungan berbasis worker.
ALTER TABLE production DROP COLUMN wage_rp;

ALTER TABLE production
  ADD COLUMN wage_zummy_rp int GENERATED ALWAYS AS
    (CASE WHEN worker IN ('berdua','zummy') THEN recipes * 3000 ELSE 0 END) STORED,
  ADD COLUMN wage_aril_rp int GENERATED ALWAYS AS
    (CASE WHEN worker IN ('berdua','aril') THEN recipes * 3000 ELSE 0 END) STORED,
  ADD COLUMN wage_rp int GENERATED ALWAYS AS
    (CASE WHEN worker = 'berdua' THEN recipes * 6000 ELSE recipes * 3000 END) STORED;

-- ---- C. Pending confirm (state konfirmasi bot) ----
-- payload = ParsedBatch[] tervalidasi (JSON); divalidasi ULANG saat dipakai.
CREATE TABLE pending_confirm (
  id         text PRIMARY KEY,          -- id pendek acak (dibuat bot)
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT, SELECT, UPDATE, DELETE ON pending_confirm TO bot_writer;
-- web tidak butuh akses pending_confirm (bukan data laporan).
