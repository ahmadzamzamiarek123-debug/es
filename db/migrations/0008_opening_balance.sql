-- ============================================================================
-- Es Lilin Tracker — Migrasi 0008: saldo awal (opening_balance)
-- Jalankan di Neon SQL editor dengan role OWNER, SETELAH 0007.
--
-- KENAPA: laporan butuh titik nol modal. "Saldo awal" = uang kas + nilai bahan
-- yang sudah dimiliki saat mulai mencatat (SATU nilai rupiah, sekali isi). Ini
-- BUKAN fitur pelacakan stok bahan — hanya baseline untuk rumus kas:
--   Kas tersisa = Saldo awal + Laba usaha − Pengambilan
--
-- Tabel satu-baris (id selalu 1) supaya mudah dibaca getSummary & di-GRANT.
-- TIDAK diseed — owner mengisi lewat /setting (bot).
-- ============================================================================

CREATE TABLE opening_balance (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  saldo_awal_rp int      NOT NULL CHECK (saldo_awal_rp >= 0),
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Hak akses: web hanya baca (untuk laporan); bot boleh isi/ubah lewat /setting.
GRANT SELECT                 ON opening_balance TO web_reader;
GRANT SELECT, INSERT, UPDATE ON opening_balance TO bot_writer;
