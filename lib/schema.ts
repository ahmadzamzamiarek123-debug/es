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
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// ===== ENUM (harus identik dengan migrasi) =====
// CATATAN: `location` BUKAN lagi ENUM — sejak migrasi 0006 lokasi jadi tabel
// referensi `location_ref` (lihat di bawah) & kolom lokasi bertipe `text` dengan
// FK ke location_ref(code). Daftar lokasi kini dinamis (owner tambah via /setting).
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
// Siapa yang mengerjakan produksi (upah Rp5.000/resep per orang yang ikut).
export const workerEnum = pgEnum('worker', ['berdua', 'zummy', 'aril']);

// ===== 1. Produksi (per resep) =====
export const production = pgTable(
  'production',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    prodDate: date('prod_date').notNull(),
    recipes: smallint('recipes').notNull(),
    // Siapa yang mengerjakan (menentukan pembagian upah).
    worker: workerEnum('worker').notNull().default('berdua'),
    // Dihitung DB: recipes * 40. Tidak boleh di-insert manual.
    outputPieces: integer('output_pieces').generatedAlwaysAs(
      sql`recipes * 40`,
    ),
    // Upah per orang: Rp5.000/resep untuk tiap orang yang ikut (0007).
    // Harus identik dengan ekspresi generated di migrasi 0007.
    wageZummyRp: integer('wage_zummy_rp').generatedAlwaysAs(
      sql`CASE WHEN worker IN ('berdua','zummy') THEN recipes * 5000 ELSE 0 END`,
    ),
    wageArilRp: integer('wage_aril_rp').generatedAlwaysAs(
      sql`CASE WHEN worker IN ('berdua','aril') THEN recipes * 5000 ELSE 0 END`,
    ),
    wageRp: integer('wage_rp').generatedAlwaysAs(
      sql`CASE WHEN worker = 'berdua' THEN recipes * 10000 ELSE recipes * 5000 END`,
    ),
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
    // Lokasi = text ber-FK ke location_ref(code) (migrasi 0006). Boleh gudang/kantin.
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

// ===== 3. Penjualan =====
export const sale = pgTable(
  'sale',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    saleDate: date('sale_date').notNull(),
    // Kantin = text ber-FK ke location_ref (migrasi 0006). Aturan "harus kantin,
    // bukan gudang" dijaga FK-subset (canteen, canteenIsCanteen)→(code, is_canteen).
    canteen: text('canteen').notNull(),
    qty: smallint('qty').notNull(),
    priceRp: smallint('price_rp').notNull(),
    // Dihitung DB: qty * price_rp. Cast ke int WAJIB — smallint*smallint tetap
    // smallint (maks 32.767) dan meng-overflow untuk penjualan wajar.
    totalRp: integer('total_rp').generatedAlwaysAs(sql`qty::int * price_rp::int`),
    // Konstan true; dipakai FK-subset kantin (0006). Tidak di-insert manual.
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

// ===== 4. Kas masuk (uang benar-benar diterima) =====
export const cashIn = pgTable(
  'cash_in',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    receivedDate: date('received_date').notNull(),
    // Kantin = text ber-FK ke location_ref; aturan "harus kantin" via FK-subset (0006).
    canteen: text('canteen').notNull(),
    amountRp: integer('amount_rp').notNull(),
    method: paymentMethodEnum('method').notNull().default('cash'),
    // Konstan true; dipakai FK-subset kantin (0006). Tidak di-insert manual.
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

// ===== 6. Pending confirm (state konfirmasi bot, lihat 0003) =====
// Batch tervalidasi menunggu tombol ✅ Simpan; callback_data hanya membawa id
// pendek (batas Telegram 64 byte). Payload divalidasi ULANG saat dipakai.
export const pendingConfirm = pgTable('pending_confirm', {
  id: text('id').primaryKey(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ===== 7. Referensi lokasi (0005) — sumber daftar sekolah/gudang =====
// Menggantikan ENUM `location`. Owner menambah/mengubah lewat bot (/setting).
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

// ===== 8. Saldo awal (0008) — baseline modal, satu baris (id=1) =====
export const openingBalance = pgTable('opening_balance', {
  id: smallint('id').primaryKey().default(1),
  saldoAwalRp: integer('saldo_awal_rp').notNull(),
  note: text('note'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Tipe turunan (dipakai lintas modul)
export type ProductionRow = typeof production.$inferSelect;
export type StockMovementRow = typeof stockMovement.$inferSelect;
export type SaleRow = typeof sale.$inferSelect;
export type CashInRow = typeof cashIn.$inferSelect;
export type CashOutRow = typeof cashOut.$inferSelect;
export type LocationRefRow = typeof locationRef.$inferSelect;
export type OpeningBalanceRow = typeof openingBalance.$inferSelect;
