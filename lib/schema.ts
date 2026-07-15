/**
 * Skema Drizzle untuk 5 tabel + enum.
 *
 * CATATAN PENTING soal kolom `GENERATED ALWAYS AS ... STORED`:
 * (output_pieces, wage_rp, total_rp) DIHITUNG OLEH DATABASE. Aplikasi tidak
 * boleh menulisnya. Karena itu kolom-kolom tsb ditandai `.generatedAlwaysAs(...)`
 * agar Drizzle mengeluarkannya dari tipe insert (tidak bisa di-insert manual).
 *
 * Uang selalu integer rupiah — tidak ada float/numeric di mana pun.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// ===== ENUM (harus identik dengan 0001_init.sql) =====
export const locationEnum = pgEnum('location', [
  'rumah',
  'mts1',
  'mts2',
  'smp',
  'sma',
  'smk',
]);
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
  'lainnya',
]);

// ===== 1. Produksi (per resep) =====
export const production = pgTable(
  'production',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    prodDate: date('prod_date').notNull(),
    recipes: smallint('recipes').notNull(),
    // Dihitung DB: recipes * 40. Tidak boleh di-insert manual.
    outputPieces: integer('output_pieces').generatedAlwaysAs(
      sql`recipes * 40`,
    ),
    // Dihitung DB: recipes * 6000 (Rp6.000/resep = Rp3.000 x 2 orang).
    wageRp: integer('wage_rp').generatedAlwaysAs(sql`recipes * 6000`),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('production_recipes_check', sql`${t.recipes} > 0`),
    index('idx_prod_date').on(t.prodDate),
  ],
);

// ===== 2. Mutasi stok (pindah lokasi, BUKAN penjualan) =====
export const stockMovement = pgTable(
  'stock_movement',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    moveDate: date('move_date').notNull(),
    fromLoc: locationEnum('from_loc').notNull(),
    toLoc: locationEnum('to_loc').notNull(),
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

// ===== 3. Penjualan =====
export const sale = pgTable(
  'sale',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    saleDate: date('sale_date').notNull(),
    canteen: locationEnum('canteen').notNull(),
    qty: smallint('qty').notNull(),
    priceRp: smallint('price_rp').notNull(),
    // Dihitung DB: qty * price_rp.
    totalRp: integer('total_rp').generatedAlwaysAs(sql`qty * price_rp`),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('sale_canteen_check', sql`${t.canteen} <> 'rumah'`),
    check('sale_qty_check', sql`${t.qty} >= 0`),
    check('sale_price_check', sql`${t.priceRp} > 0`),
    index('idx_sale_date').on(t.saleDate),
  ],
);

// ===== 4. Kas masuk (uang benar-benar diterima) =====
export const cashIn = pgTable(
  'cash_in',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    receivedDate: date('received_date').notNull(),
    canteen: locationEnum('canteen').notNull(),
    amountRp: integer('amount_rp').notNull(),
    method: paymentMethodEnum('method').notNull().default('cash'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('cash_in_canteen_check', sql`${t.canteen} <> 'rumah'`),
    check('cash_in_amount_check', sql`${t.amountRp} > 0`),
    index('idx_cashin_date').on(t.receivedDate),
  ],
);

// ===== 5. Pengeluaran & Pengambilan =====
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

// Tipe turunan (dipakai lintas modul)
export type ProductionRow = typeof production.$inferSelect;
export type StockMovementRow = typeof stockMovement.$inferSelect;
export type SaleRow = typeof sale.$inferSelect;
export type CashInRow = typeof cashIn.$inferSelect;
export type CashOutRow = typeof cashOut.$inferSelect;
