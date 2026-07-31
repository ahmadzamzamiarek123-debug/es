-- ============================================================================
-- Es Lilin Tracker — Migrasi 0007: upah Rp5.000/resep per orang
-- Jalankan di Neon SQL editor dengan role OWNER, SETELAH 0006.
--
-- PERUBAHAN ATURAN: upah naik dari Rp3.000 → Rp5.000/resep PER ORANG.
--   berdua → Zummy 5000 + Aril 5000 = 10.000/resep
--   zummy  → Zummy 5000, Aril 0
--   aril   → Aril 5000, Zummy 0
--
-- Kolom wage_* adalah GENERATED (STORED) sehingga tidak bisa di-ALTER ekspresinya
-- di tempat — harus DROP lalu ADD ulang (pola sama seperti 0004). Karena STORED,
-- baris lama (bila ada) otomatis dihitung ulang dengan tarif baru.
-- ============================================================================

ALTER TABLE production DROP COLUMN wage_zummy_rp;
ALTER TABLE production DROP COLUMN wage_aril_rp;
ALTER TABLE production DROP COLUMN wage_rp;

ALTER TABLE production
  ADD COLUMN wage_zummy_rp int GENERATED ALWAYS AS
    (CASE WHEN worker IN ('berdua','zummy') THEN recipes * 5000 ELSE 0 END) STORED,
  ADD COLUMN wage_aril_rp int GENERATED ALWAYS AS
    (CASE WHEN worker IN ('berdua','aril') THEN recipes * 5000 ELSE 0 END) STORED,
  ADD COLUMN wage_rp int GENERATED ALWAYS AS
    (CASE WHEN worker = 'berdua' THEN recipes * 10000 ELSE recipes * 5000 END) STORED;
