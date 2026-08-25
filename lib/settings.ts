/**
 * Pengelola pengaturan aplikasi (tabel app_setting).
 */
import { neon } from '@neondatabase/serverless';

type Sql = ReturnType<typeof neon>;

const TTL_MS = 30_000;
let _cachedPieces: { at: number; val: number } | null = null;

export async function getDefaultPiecesPerRecipe(sql: Sql): Promise<number> {
  if (_cachedPieces && Date.now() - _cachedPieces.at < TTL_MS) {
    return _cachedPieces.val;
  }
  try {
    const rows = (await sql`
      SELECT value FROM app_setting WHERE key = 'default_pieces_per_recipe'
    `) as { value: string }[];
    const v = parseInt(rows[0]?.value ?? '85', 10);
    const val = Number.isFinite(v) && v > 0 ? v : 85;
    _cachedPieces = { at: Date.now(), val };
    return val;
  } catch {
    return 85;
  }
}

export async function setDefaultPiecesPerRecipe(sql: Sql, pieces: number): Promise<void> {
  await sql`
    INSERT INTO app_setting (key, value, updated_at)
    VALUES ('default_pieces_per_recipe', ${pieces.toString()}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now()
  `;
  _cachedPieces = { at: Date.now(), val: pieces };
}

export function invalidateSettings(): void {
  _cachedPieces = null;
}
