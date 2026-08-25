/**
 * Sistem HPP (Harga Pokok Produksi) dinamis.
 *
 * HPP dihitung dari:
 * 1. Total biaya bahan per 1 resep = SUM(ingredient_master.price_per_unit_rp * recipe_ingredient.qty_per_recipe)
 * 2. Total upah produksi variabel per 1 resep (dari pekerja produksi aktif)
 * 3. HPP per pcs = HPP per resep / default_pieces_per_recipe
 */
import { neon } from '@neondatabase/serverless';
import { getDefaultPiecesPerRecipe } from './settings';

type Sql = ReturnType<typeof neon>;

export interface IngredientDetail {
  id: number;
  name: string;
  unit: string;
  pricePerUnitRp: number;
  qtyPerRecipe: number;
  costPerRecipeRp: number;
}

export interface HppSummary {
  ingredients: IngredientDetail[];
  totalBahanPerRecipeRp: number;
  upahProduksiPerRecipeRp: number;
  totalHppPerRecipeRp: number;
  piecesPerRecipe: number;
  hppPerPcsRp: number;
  hppBahanOnlyPerPcsRp: number;
}

const TTL_MS = 30_000;
let _cachedHpp: { at: number; val: HppSummary } | null = null;

export async function getHppSummary(sql: Sql, fresh = false): Promise<HppSummary> {
  if (!fresh && _cachedHpp && Date.now() - _cachedHpp.at < TTL_MS) {
    return _cachedHpp.val;
  }

  const rowsPromise = sql`
    SELECT 
      im.id,
      im.name,
      im.unit,
      im.price_per_unit_rp::float AS price_per_unit_rp,
      COALESCE(ri.qty_per_recipe::float, 0) AS qty_per_recipe
    FROM ingredient_master im
    LEFT JOIN recipe_ingredient ri ON ri.ingredient_id = im.id
    ORDER BY im.id
  ` as unknown as Promise<{ id: number; name: string; unit: string; price_per_unit_rp: number; qty_per_recipe: number }[]>;

  const workerRowsPromise = sql`
    SELECT rate_rp, rate_type
    FROM worker
    WHERE active = true AND role = 'produksi' AND status = 'aktif'
  ` as unknown as Promise<{ rate_rp: number; rate_type: string }[]>;

  const [rows, workerRows, pieces] = await Promise.all([
    rowsPromise,
    workerRowsPromise,
    getDefaultPiecesPerRecipe(sql),
  ]);

  let totalBahanPerRecipeRp = 0;
  const ingredients: IngredientDetail[] = rows.map((r) => {
    const cost = r.price_per_unit_rp * r.qty_per_recipe;
    totalBahanPerRecipeRp += cost;
    return {
      id: r.id,
      name: r.name,
      unit: r.unit,
      pricePerUnitRp: r.price_per_unit_rp,
      qtyPerRecipe: r.qty_per_recipe,
      costPerRecipeRp: Math.round(cost),
    };
  });

  // Hitung upah produksi variabel per resep dari pekerja aktif yang digaji per resep
  let upahProduksiPerRecipeRp = 0;
  for (const w of workerRows) {
    if (w.rate_type === 'per_resep') {
      upahProduksiPerRecipeRp += w.rate_rp;
    } else if (w.rate_type === 'per_pcs') {
      upahProduksiPerRecipeRp += w.rate_rp * pieces;
    }
  }

  const totalHppPerRecipeRp = Math.round(totalBahanPerRecipeRp + upahProduksiPerRecipeRp);
  const hppPerPcsRp = pieces > 0 ? Math.round(totalHppPerRecipeRp / pieces) : 0;
  const hppBahanOnlyPerPcsRp = pieces > 0 ? Math.round(totalBahanPerRecipeRp / pieces) : 0;

  const result: HppSummary = {
    ingredients,
    totalBahanPerRecipeRp: Math.round(totalBahanPerRecipeRp),
    upahProduksiPerRecipeRp,
    totalHppPerRecipeRp,
    piecesPerRecipe: pieces,
    hppPerPcsRp,
    hppBahanOnlyPerPcsRp,
  };

  _cachedHpp = { at: Date.now(), val: result };
  return result;
}

export async function updateIngredientPrice(
  sql: Sql,
  name: string,
  pricePerUnitRp: number,
): Promise<boolean> {
  const r = (await sql`
    UPDATE ingredient_master
    SET price_per_unit_rp = ${pricePerUnitRp},
        updated_at = now()
    WHERE lower(name) = lower(${name.trim()})
    RETURNING id, name
  `) as Record<string, unknown>[];
  invalidateHpp();
  return r.length > 0;
}

export function invalidateHpp(): void {
  _cachedHpp = null;
}

// Alias nama bahan umum untuk pengenalan kata kunci percakapan
export const INGREDIENT_ALIASES: Record<string, string> = {
  air: 'air',
  gula: 'gula',
  'gula pasir': 'gula',
  skm: 'skm',
  'susu kental manis': 'skm',
  'kental manis': 'skm',
  maizena: 'maizena',
  'tepung maizena': 'maizena',
  uht: 'uht',
  'susu uht': 'uht',
  creamer: 'creamer',
  krimer: 'creamer',
  bubuk: 'creamer',
  perisa: 'perisa',
  pasta: 'perisa',
  essen: 'perisa',
  glaze: 'glaze',
  coklat: 'glaze',
  plastik: 'plastik',
  bungkus: 'plastik',
  kemasan: 'plastik',
};

/**
 * Cari nama kanonik bahan dari teks bebas
 */
export function matchIngredientName(text: string): string | null {
  const t = text.trim().toLowerCase();
  for (const [alias, canonical] of Object.entries(INGREDIENT_ALIASES)) {
    const reg = new RegExp(`(?:^|\\b)${alias}(?:\\b|$)`, 'i');
    if (reg.test(t)) return canonical;
  }
  return null;
}
