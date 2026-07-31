/**
 * Pending confirm — state konfirmasi bot yang aman untuk serverless.
 *
 * Alur: pesan → parse → validasi → simpan batch ke pending_confirm dengan id
 * pendek acak → tombol ✅ Simpan hanya membawa id (jauh di bawah batas 64 byte
 * callback_data Telegram). Saat ditekan: ambil payload → VALIDASI ULANG zod
 * (defense in depth; payload dianggap tak tepercaya walau kita yang menulis)
 * → insert → hapus pending.
 *
 * Entri kedaluwarsa (>24 jam) dibersihkan oportunistik tiap kali menyimpan
 * pending baru — tanpa cron, cocok untuk serverless.
 */
import { randomBytes } from 'crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { getDbBot } from './db';
import { pendingConfirm } from './schema';
import {
  validateBatches,
  locationSettingSchema,
  openingBalanceSchema,
  type ParsedBatch,
  type LocationSetting,
  type OpeningBalanceInput,
} from './validate';
import type { LocationCtx } from './locations';

/** Buat id pendek acak (12 hex char cukup; bukan kriptografi kunci). */
function newId(): string {
  return randomBytes(6).toString('hex');
}

/** Bersihkan entri kedaluwarsa (>24 jam) — murah & tanpa cron. */
async function purgeExpired(db: ReturnType<typeof getDbBot>): Promise<void> {
  await db
    .delete(pendingConfirm)
    .where(lt(pendingConfirm.createdAt, sql`now() - interval '24 hours'`));
}

/** Simpan daftar batch tervalidasi; kembalikan id untuk callback_data. */
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

/**
 * Ambil + hapus pending (sekali pakai). Payload divalidasi ulang penuh —
 * bila tak lolos (mis. data korup), dianggap invalid dan tidak disimpan.
 * `ctx` = daftar lokasi/kantin terbaru (validasi ulang keanggotaan lokasi).
 */
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

/** Hapus pending tanpa memakai (tombol ❌ Batal). */
export async function discardPending(id: string): Promise<void> {
  const db = getDbBot();
  await db.delete(pendingConfirm).where(eq(pendingConfirm.id, id));
}

// ===== Pending khusus /setting (lokasi & saldo awal) =====
// Disimpan di tabel yang sama tapi payload berupa OBJEK bertag (bukan array),
// jadi tidak bentrok dengan pending transaksi. Divalidasi ulang zod saat dipakai.

type SettingPayload =
  | { kind: 'location'; data: unknown }
  | { kind: 'opening_balance'; data: unknown };

/** Simpan konfirmasi setting; kembalikan id pendek untuk callback_data. */
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
  | { ok: false; reason: 'notfound' | 'invalid' };

/** Ambil + hapus konfirmasi setting; validasi ulang zod sesuai jenisnya. */
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
  return { ok: false, reason: 'invalid' };
}
