/**
 * Lapisan INSERT — satu-satunya jalur tulis ke DB dari bot.
 *
 * Semua insert lewat Drizzle (query berparameter) — tidak ada string-concat SQL.
 * Memakai koneksi bot_writer (getDbBot).
 */
import { desc, eq } from 'drizzle-orm';
import { getDbBot, getSqlBot } from './db';
import {
  production,
  productionWorker,
  stockMovement,
  sale,
  cashIn,
  cashOut,
  locationRef,
  openingBalance,
} from './schema';
import type {
  Entity,
  ParsedBatch,
  LocationSetting,
  OpeningBalanceInput,
  IngredientPriceUpdateInput,
  WorkerSettingInput,
  MonthlyFixedCostInput,
  DefaultPiecesInput,
} from './validate';
import { invalidateLocations } from './locations';
import { getDefaultPiecesPerRecipe, setDefaultPiecesPerRecipe as setAppSettingDefaultPieces } from './settings';
import { getWorkers, buildWorkerCtx, calculateWagesForProduction, upsertWorker as dbUpsertWorker, setWorkerStatus as dbSetWorkerStatus } from './workers';
import { updateIngredientPrice as dbUpdateIngredientPrice } from './hpp';
import { setMonthlyFixedCost as dbSetMonthlyFixedCost } from './fixed-costs';

export interface InsertResult {
  entity: ParsedBatch['entity'];
  ids: number[];
}

/**
 * Simpan satu batch hasil parse+validasi.
 */
export async function insertBatch(batch: ParsedBatch): Promise<InsertResult> {
  const db = getDbBot();
  const sql = getSqlBot();

  switch (batch.entity) {
    case 'production': {
      const defaultPieces = await getDefaultPiecesPerRecipe(sql);
      const rawWorkers = await getWorkers(sql, true);
      const wCtx = buildWorkerCtx(rawWorkers);

      const insertedIds: number[] = [];

      for (const r of batch.rows) {
        const pieces = r.pieces_per_recipe ?? defaultPieces;
        
        // Tentukan worker yang mengerjakan
        let assignedWorkers = wCtx.productionWorkers;
        if (r.workers && r.workers.length > 0) {
          const matched = r.workers
            .map((wName) => wCtx.workerMap.get(wName.toLowerCase()))
            .filter((w): w is typeof rawWorkers[0] => Boolean(w && w.active));
          if (matched.length > 0) {
            assignedWorkers = matched;
          }
        }

        const { workerAllocations, totalWageRp } = calculateWagesForProduction(
          assignedWorkers,
          r.recipes,
          pieces,
        );

        const inserted = await db
          .insert(production)
          .values({
            prodDate: r.prod_date,
            recipes: r.recipes,
            piecesPerRecipe: pieces,
            wageRp: totalWageRp,
            note: r.note ?? null,
          })
          .returning({ id: production.id });

        const prodId = Number(inserted[0]?.id);
        insertedIds.push(prodId);

        // Insert rincian alokasi worker ke production_worker
        if (workerAllocations.length > 0) {
          await db.insert(productionWorker).values(
            workerAllocations.map((a) => ({
              productionId: prodId,
              workerId: a.workerId,
              recipes: a.recipes,
              wageRp: a.wageRp,
            })),
          );
        }
      }

      return { entity: 'production', ids: insertedIds };
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

export interface MultiInsertResult {
  results: (InsertResult | { entity: Entity; error: true })[];
  okCount: number;
  total: number;
}

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

// ===== Revisi (undo / hapus / ubah) =====

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

export interface TxSnapshot {
  entity: Entity;
  id: number;
  summary: string;
}

function fmtRp(n: number): string {
  return `Rp${n.toLocaleString('id-ID')}`;
}

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
        entity,
        id,
        summary: `produksi ${r.recipes} resep (${r.outputPieces} pcs @${r.piecesPerRecipe}/resep, upah ${fmtRp(r.wageRp)}) · ${r.prodDate}`,
      };
    }
    case 'stock_movement': {
      const r = (await db.select().from(stockMovement).where(eq(stockMovement.id, id)))[0];
      if (!r) return null;
      return {
        entity,
        id,
        summary: `mutasi ${r.fromLoc}→${r.toLoc} ${r.qty} biji · ${r.moveDate}`,
      };
    }
    case 'sale': {
      const r = (await db.select().from(sale).where(eq(sale.id, id)))[0];
      if (!r) return null;
      return {
        entity,
        id,
        summary: `jual ${r.canteen} ${r.qty} × ${fmtRp(r.priceRp)} = ${fmtRp(r.totalRp ?? r.qty * r.priceRp)} · ${r.saleDate}`,
      };
    }
    case 'cash_in': {
      const r = (await db.select().from(cashIn).where(eq(cashIn.id, id)))[0];
      if (!r) return null;
      return {
        entity,
        id,
        summary: `kas masuk ${r.canteen} ${fmtRp(r.amountRp)} (${r.method}) · ${r.receivedDate}`,
      };
    }
    case 'cash_out': {
      const r = (await db.select().from(cashOut).where(eq(cashOut.id, id)))[0];
      if (!r) return null;
      return {
        entity,
        id,
        summary: `${r.kind} [${r.category}] ${fmtRp(r.amountRp)} · ${r.outDate}`,
      };
    }
  }
}

export async function findById(id: number): Promise<TxSnapshot[]> {
  const entities: Entity[] = ['production', 'stock_movement', 'sale', 'cash_in', 'cash_out'];
  const found: TxSnapshot[] = [];
  for (const e of entities) {
    const snap = await getSnapshot(e, id);
    if (snap) found.push(snap);
  }
  return found;
}

export async function deleteRow(entity: Entity, id: number): Promise<boolean> {
  const db = getDbBot();
  const table = TABLE_BY_ENTITY[entity];
  const deleted = await db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
  return deleted.length > 0;
}

export async function getLastInserted(): Promise<TxSnapshot | null> {
  const db = getDbBot();
  const candidates: { snap: TxSnapshot; at: Date }[] = [];

  const p = (await db.select().from(production).orderBy(desc(production.createdAt)).limit(1))[0];
  if (p) {
    candidates.push({
      at: p.createdAt,
      snap: {
        entity: 'production',
        id: Number(p.id),
        summary: `produksi ${p.recipes} resep (${p.outputPieces} pcs @${p.piecesPerRecipe}/resep) · ${p.prodDate}`,
      },
    });
  }
  const m = (await db.select().from(stockMovement).orderBy(desc(stockMovement.createdAt)).limit(1))[0];
  if (m) {
    candidates.push({
      at: m.createdAt,
      snap: {
        entity: 'stock_movement',
        id: Number(m.id),
        summary: `mutasi ${m.fromLoc}→${m.toLoc} ${m.qty} biji · ${m.moveDate}`,
      },
    });
  }
  const s = (await db.select().from(sale).orderBy(desc(sale.createdAt)).limit(1))[0];
  if (s) {
    candidates.push({
      at: s.createdAt,
      snap: {
        entity: 'sale',
        id: Number(s.id),
        summary: `jual ${s.canteen} ${s.qty} × ${fmtRp(s.priceRp)} · ${s.saleDate}`,
      },
    });
  }
  const ci = (await db.select().from(cashIn).orderBy(desc(cashIn.createdAt)).limit(1))[0];
  if (ci) {
    candidates.push({
      at: ci.createdAt,
      snap: {
        entity: 'cash_in',
        id: Number(ci.id),
        summary: `kas masuk ${ci.canteen} ${fmtRp(ci.amountRp)} · ${ci.receivedDate}`,
      },
    });
  }
  const co = (await db.select().from(cashOut).orderBy(desc(cashOut.createdAt)).limit(1))[0];
  if (co) {
    candidates.push({
      at: co.createdAt,
      snap: {
        entity: 'cash_out',
        id: Number(co.id),
        summary: `${co.kind} [${co.category}] ${fmtRp(co.amountRp)} · ${co.outDate}`,
      },
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at.getTime() - a.at.getTime());
  return candidates[0]?.snap ?? null;
}

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

// ===== Pengaturan Master & Setting =====

export async function upsertLocation(loc: LocationSetting): Promise<void> {
  const db = getDbBot();
  await db
    .insert(locationRef)
    .values({
      code: loc.code,
      label: loc.label,
      isCanteen: true,
      isWarehouse: false,
      isBatch50: loc.is_batch50,
      priceRp: loc.price_rp ?? null,
    })
    .onConflictDoUpdate({
      target: locationRef.code,
      set: {
        label: loc.label,
        isBatch50: loc.is_batch50,
        priceRp: loc.price_rp ?? null,
        active: true,
      },
    });
  invalidateLocations();
}

export async function deactivateLocation(code: string): Promise<boolean> {
  const db = getDbBot();
  const r = await db
    .update(locationRef)
    .set({ active: false })
    .where(eq(locationRef.code, code))
    .returning({ code: locationRef.code });
  invalidateLocations();
  return r.length > 0;
}

export async function setOpeningBalance(inp: OpeningBalanceInput): Promise<void> {
  const sql = getSqlBot();
  await sql`
    INSERT INTO opening_balance (id, saldo_awal_rp, note, updated_at)
    VALUES (1, ${inp.saldo_awal_rp}, ${inp.note ?? null}, now())
    ON CONFLICT (id) DO UPDATE
      SET saldo_awal_rp = EXCLUDED.saldo_awal_rp,
          note = EXCLUDED.note,
          updated_at = now()
  `;
}

export async function updateIngredientPriceAction(inp: IngredientPriceUpdateInput): Promise<boolean> {
  const sql = getSqlBot();
  return dbUpdateIngredientPrice(sql, inp.name, inp.price_per_unit_rp);
}

export async function upsertWorkerAction(inp: WorkerSettingInput): Promise<void> {
  const sql = getSqlBot();
  await dbUpsertWorker(sql, {
    name: inp.name,
    role: inp.role,
    rateType: inp.rate_type,
    rateRp: inp.rate_rp,
    status: inp.status,
  });
}

export async function setWorkerStatusAction(name: string, status: 'aktif' | 'rencana_belum_final'): Promise<boolean> {
  const sql = getSqlBot();
  return dbSetWorkerStatus(sql, name, status);
}

export async function setMonthlyFixedCostAction(inp: MonthlyFixedCostInput): Promise<void> {
  const sql = getSqlBot();
  await dbSetMonthlyFixedCost(sql, inp.effective_month, inp.amount_rp, inp.note);
}

export async function setDefaultPiecesAction(inp: DefaultPiecesInput): Promise<void> {
  const sql = getSqlBot();
  await setAppSettingDefaultPieces(sql, inp.pieces_per_recipe);
}
