-- ============================================================================
-- Es Lilin Tracker — Migrasi 0002: role keamanan (least privilege)
-- Jalankan SETELAH 0001_init.sql, dengan role OWNER Neon.
--
-- Prinsip: bot & web JANGAN pakai role owner.
--   - bot_writer : boleh tulis & koreksi data transaksi (INSERT/SELECT/UPDATE/DELETE),
--                  TIDAK boleh ubah struktur / hapus tabel.
--   - web_reader : HANYA baca (SELECT). Kalau web dibobol, data tak bisa diubah.
--
-- PENTING: ganti password di bawah dengan password kuat Anda sendiri sebelum run.
-- ============================================================================

-- ---- BOT: penulis data ----
CREATE ROLE bot_writer LOGIN PASSWORD '123_Zamzami';
GRANT INSERT, SELECT, UPDATE, DELETE
  ON production, stock_movement, sale, cash_in, cash_out
  TO bot_writer;

-- ---- WEB: pembaca saja ----
CREATE ROLE web_reader LOGIN PASSWORD '123_Zamzami';
GRANT SELECT
  ON production, stock_movement, sale, cash_in, cash_out
  TO web_reader;

-- Catatan:
-- * Karena PK memakai GENERATED ... AS IDENTITY (bukan serial), hak INSERT sudah
--   cukup — tidak perlu grant sequence terpisah.
-- * Kedua role otomatis punya USAGE pada schema public di Neon. Jika tidak,
--   jalankan: GRANT USAGE ON SCHEMA public TO bot_writer, web_reader;
-- * ENUM (type) tidak butuh grant terpisah untuk dipakai di DML.
