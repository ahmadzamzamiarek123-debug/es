/**
 * Skema Drizzle untuk tabel transaksi, referensi, konfigurasi, HPP, worker, dan biaya tetap.
 *
 * CATATAN PENTING:
 * - `output_pieces`: GENERATED ALWAYS AS (recipes * pieces_per_recipe) STORED.
 * - `total_rp`: GENERATED ALWAYS AS (qty::int * price_rp::int) STORED.
 * - Uang selalu integer rupiah, kecuali harga satuan bahan (numeric) di ingredient_master.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// ===== ENUM =====
export const paymentMethodEnum = pgEnum('payment_method', ['cash', 'transfer']);
export const cashoutKindEnum = pgEnum('cashout_kind', [
  'pengeluaran',
  'pengambilan',
]);
export const expenseCategoryEnum = pgEnum('expense_category', [
  'bahan',
  'gas_listrik',
  'plastik',
  'transport',
  'spp_ayah',
  'gaji_ayah',
  'lainnya',
]);

// ===== 1. Pengaturan Global (app_setting) =====
export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== 2. Master Bahan (ingredient_master) & Resep (recipe_ingredient) =====
export const ingredientMaster = pgTable('ingredient_master', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  unit: text('unit').notNull(), // 'g', 'ml', 'pcs'
  pricePerUnitRp: numeric('price_per_unit_rp', { precision: 12, scale: 4 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const recipeIngredient = pgTable('recipe_ingredient', {
  id: serial('id').primaryKey(),
  ingredientId: integer('ingredient_id')
    .notNull()
    .references(() => ingredientMaster.id, { onDelete: 'cascade' })
    .unique(),
  qtyPerRecipe: numeric('qty_per_recipe', { precision: 10, scale: 2 }).notNull(),
});

// ===== 3. Karyawan / Pekerja (worker) =====
export const worker = pgTable('worker', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  role: text('role').notNull().default('produksi'), // 'produksi', 'antar'
  rateType: text('rate_type').notNull().default('per_resep'), // 'per_resep', 'per_pcs', 'per_hari'
  rateRp: integer('rate_rp').notNull(),
  active: boolean('active').notNull().default(true),
  status: text('status').notNull().default('aktif'), // 'aktif', 'rencana_belum_final'
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== 4. Produksi (per resep) =====
export const production = pgTable(
  'production',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    prodDate: date('prod_date').notNull(),
    recipes: smallint('recipes').notNull(),
    // Yield per resep (default 85, bisa diubah per baris)
    piecesPerRecipe: smallint('pieces_per_recipe').notNull().default(85),
    // Dihitung DB: recipes * pieces_per_recipe
    outputPieces: integer('output_pieces').generatedAlwaysAs(
      sql`recipes::int * pieces_per_recipe::int`,
    ),
    // Total upah produksi baris ini (hasil kalkulasi alokasi worker)
    wageRp: integer('wage_rp').notNull().default(0),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('production_recipes_check', sql`${t.recipes} > 0`),
    check('production_pieces_check', sql`${t.piecesPerRecipe} > 0`),
    index('idx_prod_date').on(t.prodDate),
  ],
);

// Rincian pekerja yang mengerjakan produksi
export const productionWorker = pgTable(
  'production_worker',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    productionId: bigint('production_id', { mode: 'number' })
      .notNull()
      .references(() => production.id, { onDelete: 'cascade' }),
    workerId: integer('worker_id')
      .notNull()
      .references(() => worker.id),
    recipes: smallint('recipes').notNull(),
    wageRp: integer('wage_rp').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_prod_worker_prod_id').on(t.productionId),
  ],
);

// ===== 5. Mutasi stok (pindah lokasi, BUKAN penjualan) =====
export const stockMovement = pgTable(
  'stock_movement',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    moveDate: date('move_date').notNull(),
    fromLoc: text('from_loc').notNull(),
    toLoc: text('to_loc').notNull(),
    qty: smallint('qty').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('stock_movement_qty_check', sql`${t.qty} > 0`),
    check('stock_movement_loc_check', sql`${t.fromLoc} <> ${t.toLoc}`),
    index('idx_move_date').on(t.moveDate),
  ],
);

// ===== 6. Penjualan =====
export const sale = pgTable(
  'sale',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    saleDate: date('sale_date').notNull(),
    canteen: text('canteen').notNull(),
    qty: smallint('qty').notNull(),
    priceRp: smallint('price_rp').notNull(),
    totalRp: integer('total_rp').generatedAlwaysAs(sql`qty::int * price_rp::int`),
    canteenIsCanteen: boolean('canteen_is_canteen').generatedAlwaysAs(sql`true`),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('sale_qty_check', sql`${t.qty} >= 0`),
    check('sale_price_check', sql`${t.priceRp} > 0`),
    index('idx_sale_date').on(t.saleDate),
  ],
);

// ===== 7. Kas masuk (uang benar-benar diterima) =====
export const cashIn = pgTable(
  'cash_in',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    receivedDate: date('received_date').notNull(),
    canteen: text('canteen').notNull(),
    amountRp: integer('amount_rp').notNull(),
    method: paymentMethodEnum('method').notNull().default('cash'),
    canteenIsCanteen: boolean('canteen_is_canteen').generatedAlwaysAs(sql`true`),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('cash_in_amount_check', sql`${t.amountRp} > 0`),
    index('idx_cashin_date').on(t.receivedDate),
  ],
);

// ===== 8. Pengeluaran & Pengambilan =====
export const cashOut = pgTable(
  'cash_out',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    outDate: date('out_date').notNull(),
    kind: cashoutKindEnum('kind').notNull(),
    category: expenseCategoryEnum('category').notNull(),
    amountRp: integer('amount_rp').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('cash_out_amount_check', sql`${t.amountRp} > 0`),
    index('idx_cashout_date').on(t.outDate),
  ],
);

// ===== 9. Biaya Tetap Bulanan (monthly_fixed_cost) =====
export const monthlyFixedCost = pgTable('monthly_fixed_cost', {
  effectiveMonth: text('effective_month').primaryKey(), // 'YYYY-MM'
  amountRp: integer('amount_rp').notNull(),
  note: text('note'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== 10. Pending confirm (state konfirmasi bot) =====
export const pendingConfirm = pgTable('pending_confirm', {
  id: text('id').primaryKey(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== 11. Referensi lokasi (location_ref) =====
export const locationRef = pgTable('location_ref', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  sortOrder: smallint('sort_order').notNull().default(100),
  isCanteen: boolean('is_canteen').notNull().default(true),
  isWarehouse: boolean('is_warehouse').notNull().default(false),
  isBatch50: boolean('is_batch50').notNull().default(false),
  priceRp: smallint('price_rp'),
  color: text('color'),
  icon: text('icon'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== 12. Saldo awal (opening_balance) =====
export const openingBalance = pgTable('opening_balance', {
  id: smallint('id').primaryKey().default(1),
  saldoAwalRp: integer('saldo_awal_rp').notNull(),
  note: text('note'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Tipe turunan
export type AppSettingRow = typeof appSetting.$inferSelect;
export type IngredientMasterRow = typeof ingredientMaster.$inferSelect;
export type RecipeIngredientRow = typeof recipeIngredient.$inferSelect;
export type WorkerRow = typeof worker.$inferSelect;
export type ProductionRow = typeof production.$inferSelect;
export type ProductionWorkerRow = typeof productionWorker.$inferSelect;
export type StockMovementRow = typeof stockMovement.$inferSelect;
export type SaleRow = typeof sale.$inferSelect;
export type CashInRow = typeof cashIn.$inferSelect;
export type CashOutRow = typeof cashOut.$inferSelect;
export type MonthlyFixedCostRow = typeof monthlyFixedCost.$inferSelect;
export type LocationRefRow = typeof locationRef.$inferSelect;
export type OpeningBalanceRow = typeof openingBalance.$inferSelect;
