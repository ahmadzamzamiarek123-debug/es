-- ============================================================================
-- Es Lilin Tracker — Migrasi 0004: perbaiki overflow total_rp penjualan
-- Jalankan di Neon SQL editor dengan role OWNER, SETELAH 0003.
--
-- MASALAH: kolom `sale.total_rp` dihitung `qty * price_rp`, tapi qty & price_rp
-- dua-duanya smallint. Di PostgreSQL smallint*smallint tetap smallint (maks
-- 32.767), sehingga penjualan wajar (mis. 79 × 900 = 71.100) OVERFLOW dan
-- insert DITOLAK. Akibatnya semua penjualan bernilai > Rp32.767 gagal.
--
-- SOLUSI: hitung dengan cast integer eksplisit. Kolom lain (output_pieces,
-- wage_*) sudah aman karena literalnya (40, 3000, 6000) bertipe int.
-- ============================================================================

ALTER TABLE sale DROP COLUMN total_rp;

ALTER TABLE sale
  ADD COLUMN total_rp int GENERATED ALWAYS AS (qty::int * price_rp::int) STORED;
