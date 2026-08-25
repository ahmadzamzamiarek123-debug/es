/**
 * Pending confirm — state konfirmasi bot yang aman untuk serverless.
 */
import { randomBytes } from 'crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { getDbBot } from './db';
import { pendingConfirm } from './schema';
import {
  validateBatches,
  locationSettingSchema,
  openingBalanceSchema,
  ingredientPriceUpdateSchema,
  workerSettingSchema,
  monthlyFixedCostSchema,
  defaultPiecesSchema,
  type ParsedBatch,
  type LocationSetting,
  type OpeningBalanceInput,
  type IngredientPriceUpdateInput,
  type WorkerSettingInput,
  type MonthlyFixedCostInput,
  type DefaultPiecesInput,
} from './validate';
import type { LocationCtx } from './locations';

function newId(): string {
  return randomBytes(6).toString('hex');
}

async function purgeExpired(db: ReturnType<typeof getDbBot>): Promise<void> {
  await db
    .delete(pendingConfirm)
    .where(lt(pendingConfirm.createdAt, sql`now() - interval '24 hours'`));
}

export async function savePending(batches: ParsedBatch[]): Promise<string> {
  const db = getDbBot();
  const id = newId();
  await purgeExpired(db);
  await db.insert(pendingConfirm).values({ id, payload: batches });
  return id;
}

export type PendingResult =
  | { ok: true; batches: ParsedBatch[] }
  | { ok: false; reason: 'notfound' | 'invalid' };

export async function takePending(
  id: string,
  ctx: LocationCtx,
): Promise<PendingResult> {
  const db = getDbBot();
  const rows = await db
    .delete(pendingConfirm)
    .where(eq(pendingConfirm.id, id))
    .returning({ payload: pendingConfirm.payload });
  const payload = rows[0]?.payload;
  if (!payload) return { ok: false, reason: 'notfound' };

  if (!Array.isArray(payload)) return { ok: false, reason: 'invalid' };
  const result = validateBatches(
    payload as { entity: unknown; rows: unknown }[],
    ctx,
  );
  if (!result.ok) return { ok: false, reason: 'invalid' };
  return { ok: true, batches: result.batches };
}

export async function discardPending(id: string): Promise<void> {
  const db = getDbBot();
  await db.delete(pendingConfirm).where(eq(pendingConfirm.id, id));
}

// ===== Pending khusus /setting dan Master Data =====

export type SettingPayload =
  | { kind: 'location'; data: unknown }
  | { kind: 'opening_balance'; data: unknown }
  | { kind: 'ingredient_price'; data: unknown }
  | { kind: 'worker_setting'; data: unknown }
  | { kind: 'worker_status'; data: { name: string; status: 'aktif' | 'rencana_belum_final' } }
  | { kind: 'monthly_fixed_cost'; data: unknown }
  | { kind: 'default_pieces'; data: unknown };

export async function saveSettingPending(payload: SettingPayload): Promise<string> {
  const db = getDbBot();
  const id = newId();
  await purgeExpired(db);
  await db.insert(pendingConfirm).values({ id, payload });
  return id;
}

export type SettingPendingResult =
  | { ok: true; kind: 'location'; data: LocationSetting }
  | { ok: true; kind: 'opening_balance'; data: OpeningBalanceInput }
  | { ok: true; kind: 'ingredient_price'; data: IngredientPriceUpdateInput }
  | { ok: true; kind: 'worker_setting'; data: WorkerSettingInput }
  | { ok: true; kind: 'worker_status'; data: { name: string; status: 'aktif' | 'rencana_belum_final' } }
  | { ok: true; kind: 'monthly_fixed_cost'; data: MonthlyFixedCostInput }
  | { ok: true; kind: 'default_pieces'; data: DefaultPiecesInput }
  | { ok: false; reason: 'notfound' | 'invalid' };

export async function takeSettingPending(id: string): Promise<SettingPendingResult> {
  const db = getDbBot();
  const rows = await db
    .delete(pendingConfirm)
    .where(eq(pendingConfirm.id, id))
    .returning({ payload: pendingConfirm.payload });
  const payload = rows[0]?.payload as SettingPayload | undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'notfound' };
  }

  if (payload.kind === 'location') {
    const p = locationSettingSchema.safeParse(payload.data);
    if (!p.success) return { ok: false, reason: 'invalid' };
    return { ok: true, kind: 'location', data: p.data };
  }

  if (payload.kind === 'opening_balance') {
    const p = openingBalanceSchema.safeParse(payload.data);
    if (!p.success) return { ok: false, reason: 'invalid' };
    return { ok: true, kind: 'opening_balance', data: p.data };
  }

  if (payload.kind === 'ingredient_price') {
    const p = ingredientPriceUpdateSchema.safeParse(payload.data);
    if (!p.success) return { ok: false, reason: 'invalid' };
    return { ok: true, kind: 'ingredient_price', data: p.data };
  }

  if (payload.kind === 'worker_setting') {
    const p = workerSettingSchema.safeParse(payload.data);
    if (!p.success) return { ok: false, reason: 'invalid' };
    return { ok: true, kind: 'worker_setting', data: p.data };
  }

  if (payload.kind === 'worker_status') {
    const d = payload.data;
    if (d && typeof d.name === 'string' && (d.status === 'aktif' || d.status === 'rencana_belum_final')) {
      return { ok: true, kind: 'worker_status', data: d };
    }
    return { ok: false, reason: 'invalid' };
  }

  if (payload.kind === 'monthly_fixed_cost') {
    const p = monthlyFixedCostSchema.safeParse(payload.data);
    if (!p.success) return { ok: false, reason: 'invalid' };
    return { ok: true, kind: 'monthly_fixed_cost', data: p.data };
  }

  if (payload.kind === 'default_pieces') {
    const p = defaultPiecesSchema.safeParse(payload.data);
    if (!p.success) return { ok: false, reason: 'invalid' };
    return { ok: true, kind: 'default_pieces', data: p.data };
  }

  return { ok: false, reason: 'invalid' };
}
