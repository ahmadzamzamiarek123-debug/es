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
import { validateBatches, type ParsedBatch } from './validate';

/** Buat id pendek acak (12 hex char cukup; bukan kriptografi kunci). */
function newId(): string {
  return randomBytes(6).toString('hex');
}

/** Simpan daftar batch tervalidasi; kembalikan id untuk callback_data. */
export async function savePending(batches: ParsedBatch[]): Promise<string> {
  const db = getDbBot();
  const id = newId();
  // Bersihkan entri kedaluwarsa (>24 jam) sekalian — murah & tanpa cron.
  await db
    .delete(pendingConfirm)
    .where(lt(pendingConfirm.createdAt, sql`now() - interval '24 hours'`));
  await db.insert(pendingConfirm).values({ id, payload: batches });
  return id;
}

export type PendingResult =
  | { ok: true; batches: ParsedBatch[] }
  | { ok: false; reason: 'notfound' | 'invalid' };

/**
 * Ambil + hapus pending (sekali pakai). Payload divalidasi ulang penuh —
 * bila tak lolos (mis. data korup), dianggap invalid dan tidak disimpan.
 */
export async function takePending(id: string): Promise<PendingResult> {
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
  );
  if (!result.ok) return { ok: false, reason: 'invalid' };
  return { ok: true, batches: result.batches };
}

/** Hapus pending tanpa memakai (tombol ❌ Batal). */
export async function discardPending(id: string): Promise<void> {
  const db = getDbBot();
  await db.delete(pendingConfirm).where(eq(pendingConfirm.id, id));
}
