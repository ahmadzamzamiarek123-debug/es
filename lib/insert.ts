/**
 * Lapisan INSERT — satu-satunya jalur tulis ke DB dari bot.
 *
 * Prinsip:
 *   - Semua insert lewat Drizzle (query berparameter) — tidak ada string-concat SQL.
 *   - Input WAJIB sudah divalidasi zod (lib/validate.ts) sebelum masuk sini.
 *   - Multi-baris SATU entity = satu statement INSERT (atomik). Multi-OPERASI
 *     (insertBatches) berurutan & TIDAK atomik antar operasi — driver Neon
 *     HTTP tak mendukung transaksi interaktif; hasil dilaporkan jujur N/N.
 *   - Memakai koneksi bot_writer (getDbBot). Web tidak pernah mengimpor modul ini.
 *
 * Nilai uang di sini SUDAH integer rupiah (dijamin oleh zod .int()). Tidak ada
 * float yang menyentuh DB.
 */
import { desc, eq } from 'drizzle-orm';
import { getDbBot } from './db';
import {
  production,
  stockMovement,
  sale,
  cashIn,
  cashOut,
} from './schema';
import type { Entity, ParsedBatch } from './validate';

/** Hasil insert: entity + daftar id baris yang tersimpan (untuk balasan bot). */
export interface InsertResult {
  entity: ParsedBatch['entity'];
  ids: number[];
}

/**
 * Simpan satu batch hasil parse+validasi. Mengembalikan id baris yang dibuat.
 * Kolom GENERATED (output_pieces, wage_rp, total_rp) dihitung DB, tidak dikirim.
 */
export async function insertBatch(batch: ParsedBatch): Promise<InsertResult> {
  const db = getDbBot();

  switch (batch.entity) {
    case 'production': {
      const rows = batch.rows.map((r) => ({
        prodDate: r.prod_date,
        recipes: r.recipes,
        worker: r.worker,
        note: r.note ?? null,
      }));
      const inserted = await db
        .insert(production)
        .values(rows)
        .returning({ id: production.id });
      return { entity: 'production', ids: inserted.map((x) => Number(x.id)) };
    }

    case 'stock_movement': {
      const rows = batch.rows.map((r) => ({
        moveDate: r.move_date,
        fromLoc: r.from_loc,
        toLoc: r.to_loc,
        qty: r.qty,
        note: r.note ?? null,
      }));
      const inserted = await db
        .insert(stockMovement)
        .values(rows)
        .returning({ id: stockMovement.id });
      return { entity: 'stock_movement', ids: inserted.map((x) => Number(x.id)) };
    }

    case 'sale': {
      const rows = batch.rows.map((r) => ({
        saleDate: r.sale_date,
        canteen: r.canteen,
        qty: r.qty,
        priceRp: r.price_rp,
        note: r.note ?? null,
      }));
      const inserted = await db
        .insert(sale)
        .values(rows)
        .returning({ id: sale.id });
      return { entity: 'sale', ids: inserted.map((x) => Number(x.id)) };
    }

    case 'cash_in': {
      const rows = batch.rows.map((r) => ({
        receivedDate: r.received_date,
        canteen: r.canteen,
        amountRp: r.amount_rp,
        method: r.method,
        note: r.note ?? null,
      }));
      const inserted = await db
        .insert(cashIn)
        .values(rows)
        .returning({ id: cashIn.id });
      return { entity: 'cash_in', ids: inserted.map((x) => Number(x.id)) };
    }

    case 'cash_out': {
      const rows = batch.rows.map((r) => ({
        outDate: r.out_date,
        kind: r.kind,
        category: r.category,
        amountRp: r.amount_rp,
        note: r.note ?? null,
      }));
      const inserted = await db
        .insert(cashOut)
        .values(rows)
        .returning({ id: cashOut.id });
      return { entity: 'cash_out', ids: inserted.map((x) => Number(x.id)) };
    }
  }
}

/** Hasil insert multi-batch: per operasi sukses/gagal (untuk laporan N/N). */
export interface MultiInsertResult {
  results: (InsertResult | { entity: Entity; error: true })[];
  okCount: number;
  total: number;
}

/**
 * Simpan BEBERAPA batch berurutan.
 * CATATAN: driver Neon HTTP tidak mendukung transaksi interaktif lintas
 * statement, jadi ini BUKAN atomik antar operasi — operasi yang sudah masuk
 * tetap tersimpan bila operasi berikutnya gagal. Pemanggil wajib melaporkan
 * "okCount/total" dengan jujur ke user.
 */
export async function insertBatches(
  batches: ParsedBatch[],
): Promise<MultiInsertResult> {
  const results: MultiInsertResult['results'] = [];
  let okCount = 0;
  for (const b of batches) {
    try {
      const r = await insertBatch(b);
      results.push(r);
      okCount++;
    } catch {
      results.push({ entity: b.entity, error: true });
    }
  }
  return { results, okCount, total: batches.length };
}

// ===== Revisi (undo / hapus / ubah) — tetap hanya lewat bot =====

const TABLE_BY_ENTITY = {
  production,
  stock_movement: stockMovement,
  sale,
  cash_in: cashIn,
  cash_out: cashOut,
} as const;

export const ENTITY_LABEL: Record<Entity, string> = {
  production: 'produksi',
  stock_movement: 'mutasi',
  sale: 'penjualan',
  cash_in: 'kas masuk',
  cash_out: 'kas keluar',
};

/** Satu baris transaksi generik untuk ditampilkan sebelum konfirmasi revisi. */
export interface TxSnapshot {
  entity: Entity;
  id: number;
  summary: string;
}

function fmtRp(n: number): string {
  return `Rp${n.toLocaleString('id-ID')}`;
}

/** Ambil ringkasan satu baris berdasarkan entity+id (null bila tak ada). */
export async function getSnapshot(
  entity: Entity,
  id: number,
): Promise<TxSnapshot | null> {
  const db = getDbBot();
  switch (entity) {
    case 'production': {
      const r = (await db.select().from(production).where(eq(production.id, id)))[0];
      if (!r) return null;
      return {
        entity, id,
        summary: `produksi ${r.recipes} resep (${r.worker}) · ${r.prodDate}`,
      };
    }
    case 'stock_movement': {
      const r = (await db.select().from(stockMovement).where(eq(stockMovement.id, id)))[0];
      if (!r) return null;
      return {
        entity, id,
        summary: `mutasi ${r.fromLoc}→${r.toLoc} ${r.qty} biji · ${r.moveDate}`,
      };
    }
    case 'sale': {
      const r = (await db.select().from(sale).where(eq(sale.id, id)))[0];
      if (!r) return null;
      return {
        entity, id,
        summary: `jual ${r.canteen} ${r.qty} × ${fmtRp(r.priceRp)} · ${r.saleDate}`,
      };
    }
    case 'cash_in': {
      const r = (await db.select().from(cashIn).where(eq(cashIn.id, id)))[0];
      if (!r) return null;
      return {
        entity, id,
        summary: `kas masuk ${r.canteen} ${fmtRp(r.amountRp)} · ${r.receivedDate}`,
      };
    }
    case 'cash_out': {
      const r = (await db.select().from(cashOut).where(eq(cashOut.id, id)))[0];
      if (!r) return null;
      return {
        entity, id,
        summary: `${r.kind} [${r.category}] ${fmtRp(r.amountRp)} · ${r.outDate}`,
      };
    }
  }
}

/**
 * Cari id di semua tabel (id unik per tabel, bukan global — jadi bila id yang
 * sama ada di dua tabel, kembalikan semuanya agar user memilih entitasnya).
 */
export async function findById(id: number): Promise<TxSnapshot[]> {
  const entities: Entity[] = ['production', 'stock_movement', 'sale', 'cash_in', 'cash_out'];
  const found: TxSnapshot[] = [];
  for (const e of entities) {
    const snap = await getSnapshot(e, id);
    if (snap) found.push(snap);
  }
  return found;
}

/** Hapus satu baris. Mengembalikan true bila ada yang terhapus. */
export async function deleteRow(entity: Entity, id: number): Promise<boolean> {
  const db = getDbBot();
  const table = TABLE_BY_ENTITY[entity];
  const deleted = await db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
  return deleted.length > 0;
}

/**
 * Insert TERAKHIR di seluruh tabel (berdasar created_at) — target perintah
 * `undo`. Mengembalikan snapshot untuk dikonfirmasi dulu, bukan langsung hapus.
 */
export async function getLastInserted(): Promise<TxSnapshot | null> {
  const db = getDbBot();
  const candidates: { snap: TxSnapshot; at: Date }[] = [];

  const p = (await db.select().from(production).orderBy(desc(production.createdAt)).limit(1))[0];
  if (p) candidates.push({ at: p.createdAt, snap: { entity: 'production', id: Number(p.id), summary: `produksi ${p.recipes} resep (${p.worker}) · ${p.prodDate}` } });
  const m = (await db.select().from(stockMovement).orderBy(desc(stockMovement.createdAt)).limit(1))[0];
  if (m) candidates.push({ at: m.createdAt, snap: { entity: 'stock_movement', id: Number(m.id), summary: `mutasi ${m.fromLoc}→${m.toLoc} ${m.qty} biji · ${m.moveDate}` } });
  const s = (await db.select().from(sale).orderBy(desc(sale.createdAt)).limit(1))[0];
  if (s) candidates.push({ at: s.createdAt, snap: { entity: 'sale', id: Number(s.id), summary: `jual ${s.canteen} ${s.qty} × ${fmtRp(s.priceRp)} · ${s.saleDate}` } });
  const ci = (await db.select().from(cashIn).orderBy(desc(cashIn.createdAt)).limit(1))[0];
  if (ci) candidates.push({ at: ci.createdAt, snap: { entity: 'cash_in', id: Number(ci.id), summary: `kas masuk ${ci.canteen} ${fmtRp(ci.amountRp)} · ${ci.receivedDate}` } });
  const co = (await db.select().from(cashOut).orderBy(desc(cashOut.createdAt)).limit(1))[0];
  if (co) candidates.push({ at: co.createdAt, snap: { entity: 'cash_out', id: Number(co.id), summary: `${co.kind} [${co.category}] ${fmtRp(co.amountRp)} · ${co.outDate}` } });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at.getTime() - a.at.getTime());
  return candidates[0]?.snap ?? null;
}

/**
 * Ubah nilai UTAMA satu baris (qty untuk mutasi/penjualan, recipes untuk
 * produksi, amount untuk kas). Perubahan kolom lain = hapus lalu input ulang.
 */
export async function updateMainValue(
  entity: Entity,
  id: number,
  value: number,
): Promise<boolean> {
  const db = getDbBot();
  switch (entity) {
    case 'production': {
      const r = await db.update(production).set({ recipes: value }).where(eq(production.id, id)).returning({ id: production.id });
      return r.length > 0;
    }
    case 'stock_movement': {
      const r = await db.update(stockMovement).set({ qty: value }).where(eq(stockMovement.id, id)).returning({ id: stockMovement.id });
      return r.length > 0;
    }
    case 'sale': {
      const r = await db.update(sale).set({ qty: value }).where(eq(sale.id, id)).returning({ id: sale.id });
      return r.length > 0;
    }
    case 'cash_in': {
      const r = await db.update(cashIn).set({ amountRp: value }).where(eq(cashIn.id, id)).returning({ id: cashIn.id });
      return r.length > 0;
    }
    case 'cash_out': {
      const r = await db.update(cashOut).set({ amountRp: value }).where(eq(cashOut.id, id)).returning({ id: cashOut.id });
      return r.length > 0;
    }
  }
}
