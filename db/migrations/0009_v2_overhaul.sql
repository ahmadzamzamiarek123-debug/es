-- ============================================================================
-- Es Lilin Tracker — Migrasi 0009: V2 Overhaul
-- (HPP dinamis, yield per resep dinamis, sistem gaji fleksibel,
--  biaya tetap bulanan, dan kategori gaji_ayah)
-- ============================================================================

-- ===== 1. Pengaturan Global (app_setting) =====
CREATE TABLE IF NOT EXISTS app_setting (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_setting (key, value)
VALUES ('default_pieces_per_recipe', '85')
ON CONFLICT (key) DO NOTHING;

-- ===== 2. Master Bahan (ingredient_master) & Resep (recipe_ingredient) =====
CREATE TABLE IF NOT EXISTS ingredient_master (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  unit text NOT NULL,
  price_per_unit_rp numeric(12, 4) NOT NULL CHECK (price_per_unit_rp >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ingredient_master (name, unit, price_per_unit_rp) VALUES
  ('air', 'ml', 1.0000),
  ('gula', 'g', 18.0000),
  ('skm', 'g', 24.8000),
  ('maizena', 'g', 30.0000),
  ('uht', 'ml', 21.0000),
  ('creamer', 'g', 50.0000),
  ('perisa', 'g', 166.6667),
  ('glaze', 'g', 60.0000),
  ('plastik', 'pcs', 50.0000)
ON CONFLICT (name) DO UPDATE
  SET unit = EXCLUDED.unit,
      price_per_unit_rp = EXCLUDED.price_per_unit_rp;

CREATE TABLE IF NOT EXISTS recipe_ingredient (
  id serial PRIMARY KEY,
  ingredient_id int NOT NULL REFERENCES ingredient_master(id) ON DELETE CASCADE,
  qty_per_recipe numeric(10, 2) NOT NULL CHECK (qty_per_recipe > 0),
  UNIQUE (ingredient_id)
);

INSERT INTO recipe_ingredient (ingredient_id, qty_per_recipe)
SELECT id, 3000 FROM ingredient_master WHERE name = 'air'
UNION ALL
SELECT id, 400 FROM ingredient_master WHERE name = 'gula'
UNION ALL
SELECT id, 400 FROM ingredient_master WHERE name = 'skm'
UNION ALL
SELECT id, 70 FROM ingredient_master WHERE name = 'maizena'
UNION ALL
SELECT id, 500 FROM ingredient_master WHERE name = 'uht'
UNION ALL
SELECT id, 150 FROM ingredient_master WHERE name = 'creamer'
UNION ALL
SELECT id, 7 FROM ingredient_master WHERE name = 'perisa'
UNION ALL
SELECT id, 400 FROM ingredient_master WHERE name = 'glaze'
UNION ALL
SELECT id, 85 FROM ingredient_master WHERE name = 'plastik'
ON CONFLICT (ingredient_id) DO UPDATE
  SET qty_per_recipe = EXCLUDED.qty_per_recipe;

-- ===== 3. Karyawan / Pekerja (worker) & Relasi Produksi =====
CREATE TABLE IF NOT EXISTS worker (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'produksi',
  rate_type text NOT NULL DEFAULT 'per_resep',
  rate_rp int NOT NULL CHECK (rate_rp >= 0),
  active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'aktif',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO worker (name, role, rate_type, rate_rp, active, status) VALUES
  ('adek', 'produksi', 'per_resep', 5000, true, 'aktif'),
  ('diri_sendiri', 'produksi', 'per_resep', 10000, true, 'aktif'),
  ('ayah', 'antar', 'per_hari', 10000, true, 'rencana_belum_final')
ON CONFLICT (name) DO UPDATE
  SET role = EXCLUDED.role,
      rate_type = EXCLUDED.rate_type,
      rate_rp = EXCLUDED.rate_rp,
      status = EXCLUDED.status;

-- Perbarui tabel production
ALTER TABLE production
  DROP COLUMN IF EXISTS wage_zummy_rp,
  DROP COLUMN IF EXISTS wage_aril_rp,
  DROP COLUMN IF EXISTS wage_rp,
  DROP COLUMN IF EXISTS worker,
  DROP COLUMN IF EXISTS output_pieces;

DROP TYPE IF EXISTS worker;

ALTER TABLE production
  ADD COLUMN IF NOT EXISTS pieces_per_recipe smallint NOT NULL DEFAULT 85 CHECK (pieces_per_recipe > 0),
  ADD COLUMN IF NOT EXISTS output_pieces int GENERATED ALWAYS AS (recipes::int * pieces_per_recipe::int) STORED,
  ADD COLUMN IF NOT EXISTS wage_rp int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS production_worker (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  production_id bigint NOT NULL REFERENCES production(id) ON DELETE CASCADE,
  worker_id int NOT NULL REFERENCES worker(id),
  recipes smallint NOT NULL CHECK (recipes > 0),
  wage_rp int NOT NULL CHECK (wage_rp >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prod_worker_prod_id ON production_worker (production_id);

-- ===== 4. Biaya Tetap Bulanan (monthly_fixed_cost) =====
CREATE TABLE IF NOT EXISTS monthly_fixed_cost (
  effective_month text PRIMARY KEY, -- 'YYYY-MM'
  amount_rp int NOT NULL CHECK (amount_rp >= 0),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO monthly_fixed_cost (effective_month, amount_rp, note)
VALUES (to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM'), 55000, 'Estimasi listrik freezer + gas')
ON CONFLICT (effective_month) DO NOTHING;

-- ===== 5. Kategori Pengeluaran Baru (gaji_ayah) =====
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'gaji_ayah';

-- ===== 6. Hak Akses Role (bot_writer & web_reader) =====
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_setting,
  ingredient_master,
  recipe_ingredient,
  worker,
  monthly_fixed_cost,
  production_worker
TO bot_writer;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bot_writer;

GRANT SELECT ON
  app_setting,
  ingredient_master,
  recipe_ingredient,
  worker,
  monthly_fixed_cost,
  production_worker
TO web_reader;
