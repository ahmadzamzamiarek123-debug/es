/**
 * Lapisan INSERT — satu-satunya jalur tulis ke DB dari bot.
 *
 * Prinsip:
 *   - Semua insert lewat Drizzle (query berparameter) — tidak ada string-concat SQL.
 *   - Input WAJIB sudah divalidasi zod (lib/validate.ts) sebelum masuk sini.
 *   - Batch (>1 baris, mis. beberapa mutasi sekaligus) disimpan dalam SATU
 *     transaksi lewat db.transaction() — semua berhasil atau semua batal.
 *   - Memakai koneksi bot_writer (getDbBot). Web tidak pernah mengimpor modul ini.
 *
 * Nilai uang di sini SUDAH integer rupiah (dijamin oleh zod .int()). Tidak ada
 * float yang menyentuh DB.
 */
import { getDbBot } from './db';
import {
  production,
  stockMovement,
  sale,
  cashIn,
  cashOut,
} from './schema';
import type { ParsedBatch } from './validate';

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
