-- ============================================================================
-- Es Lilin Tracker — Migrasi 0005: tabel referensi lokasi (location_ref)
-- Jalankan di Neon SQL editor dengan role OWNER, SETELAH 0004.
--
-- KENAPA: lokasi sebelumnya ENUM tetap ('rumah','mts1'...). Sekarang ada 7
-- sekolah & bisa bertambah, jadi lokasi dipindah ke TABEL referensi supaya
-- owner bisa menambah/mengubah sekolah lewat bot (/setting) tanpa migrasi baru.
--
-- Migrasi ini HANYA membuat tabel + seed 'rumah' (gudang). Kode kantin lama
-- TIDAK diseed — sesuai keputusan "mulai bersih": 7 sekolah diisi owner via
-- /setting. Konversi kolom ENUM→text + FK dilakukan di 0006.
--
-- Kolom flag (is_canteen/is_warehouse/is_batch50) menggantikan aturan lama yang
-- di-hardcode di kode/CHECK (mis. "canteen <> 'rumah'", "sma/smk batch 50").
-- ============================================================================

CREATE TABLE location_ref (
  code        text     PRIMARY KEY,               -- kode kanonik (mis. 'mts1')
  label       text     NOT NULL,                  -- tampilan (mis. 'MTS1')
  sort_order  smallint NOT NULL DEFAULT 100,      -- urutan tampil di web/bot
  is_canteen  boolean  NOT NULL DEFAULT true,     -- tujuan jual/kas (bukan gudang)
  is_warehouse boolean NOT NULL DEFAULT false,    -- gudang (rumah): asal produksi
  is_batch50  boolean  NOT NULL DEFAULT false,    -- model batch 50 (kulkas)
  price_rp    smallint CHECK (price_rp IS NULL OR price_rp > 0), -- harga jual kita/biji
  color       text,                               -- warna grafik (opsional)
  icon        text,                               -- ikon (opsional)
  active      boolean  NOT NULL DEFAULT true,     -- nonaktif = sembunyikan, JANGAN hapus
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Target FK-subset dari 0006 (sale/cash_in butuh (code,is_canteen)=(x,true)).
  UNIQUE (code, is_canteen)
);

CREATE INDEX idx_locref_active ON location_ref (active);

-- Seed HANYA gudang. Kantin (7 sekolah) diisi owner lewat /setting.
-- rumah: gudang, bukan kantin, tanpa harga jual.
INSERT INTO location_ref (code, label, sort_order, is_canteen, is_warehouse, is_batch50, price_rp)
VALUES ('rumah', 'Rumah', 0, false, true, false, NULL);

-- Hak akses: web hanya baca; bot boleh baca + kelola (via /setting).
GRANT SELECT                 ON location_ref TO web_reader;
GRANT SELECT, INSERT, UPDATE ON location_ref TO bot_writer;
