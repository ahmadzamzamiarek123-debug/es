/**
 * SUMBER TUNGGAL data lokasi (menggantikan semua salinan LOC_LABEL, DEFAULT_PRICE,
 * BATCH50_CANTEENS, LOC_ALIAS yang dulu tersebar di banyak file).
 *
 * Lokasi kini DATA (tabel location_ref), bukan konstanta kode. Modul ini membaca
 * tabel itu dan menyediakan:
 *   - getLocations(sql)        : daftar lokasi (dengan cache TTL pendek)
 *   - getLocationsFresh(sql)   : paksa baca DB (dipakai jalur TULIS bot agar
 *                                validasi input pakai daftar terbaru)
 *   - invalidateLocations()    : buang cache (dipanggil setelah /setting menulis)
 *   - buildLocationCtx(locs)   : set/map turunan untuk parser & validator
 *   - labelMapOf/colorMapOf/iconMapOf : untuk tampilan (bot & web)
 *
 * Keamanan: `sql` = tagged-template neon berparameter (getSqlWeb/getSqlBot).
 * Tidak ada string-concat. location_ref di-GRANT SELECT ke web_reader & bot_writer.
 */
import { neon } from "@neondatabase/serverless";

type Sql = ReturnType<typeof neon>;

export interface LocationInfo {
  code: string;
  label: string;
  sortOrder: number;
  isCanteen: boolean;
  isWarehouse: boolean;
  isBatch50: boolean;
  priceRp: number | null;
  color: string | null;
  icon: string | null;
  active: boolean;
}

function mapRow(r: Record<string, unknown>): LocationInfo {
  const price = r.price_rp;
  return {
    code: String(r.code),
    label: String(r.label),
    sortOrder: typeof r.sort_order === "number" ? r.sort_order : parseInt(String(r.sort_order ?? 0), 10) || 0,
    isCanteen: r.is_canteen === true,
    isWarehouse: r.is_warehouse === true,
    isBatch50: r.is_batch50 === true,
    priceRp: price === null || price === undefined ? null : Number(price),
    color: r.color == null ? null : String(r.color),
    icon: r.icon == null ? null : String(r.icon),
    active: r.active === true,
  };
}

async function fetchLocations(sql: Sql): Promise<LocationInfo[]> {
  const rows = (await sql`
    SELECT code, label, sort_order, is_canteen, is_warehouse, is_batch50,
           price_rp, color, icon, active
    FROM location_ref
    ORDER BY sort_order, code
  `) as Record<string, unknown>[];
  return rows.map(mapRow);
}

// ===== Cache modul (per-instance serverless) =====
// TTL pendek: cukup memangkas query berulang dalam satu request, tapi perubahan
// via /setting cepat terlihat. Jalur tulis bot pakai getLocationsFresh (bypass).
const TTL_MS = 30_000;
let _cache: { at: number; rows: LocationInfo[] } | null = null;

export async function getLocations(sql: Sql): Promise<LocationInfo[]> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.rows;
  const rows = await fetchLocations(sql);
  _cache = { at: Date.now(), rows };
  return rows;
}

/** Paksa baca DB (abaikan cache) & segarkan cache. Untuk validasi input tulis. */
export async function getLocationsFresh(sql: Sql): Promise<LocationInfo[]> {
  const rows = await fetchLocations(sql);
  _cache = { at: Date.now(), rows };
  return rows;
}

/** Buang cache (panggil setelah upsertLocation/setOpeningBalance mengubah data). */
export function invalidateLocations(): void {
  _cache = null;
}

// ===== Konteks untuk parser & validator =====

export interface LocationCtx {
  /** Semua kode AKTIF (valid sebagai lokasi input). */
  locationSet: Set<string>;
  /** Kode aktif yang merupakan kantin (tujuan jual/kas — bukan gudang). */
  canteenSet: Set<string>;
  /** Kode aktif dengan model batch 50 (kulkas). */
  batch50Set: Set<string>;
  /** Kode gudang (is_warehouse) — biasanya 'rumah'. */
  warehouseSet: Set<string>;
  /** Harga jual default per kode (rupiah/biji) untuk yang punya. */
  defaultPrice: Map<string, number>;
  /** Alias ketikan → kode kanonik (mis. "mts 1" → "mts1", "gudang" → "rumah"). */
  aliasMap: Map<string, string>;
}

/**
 * Bangun alias otomatis dari daftar lokasi (tanpa hardcode nama sekolah):
 *   - kode itu sendiri & label huruf kecil
 *   - varian berspasi untuk kode "huruf+angka" (mts1 → "mts 1")
 *   - "gudang" → kode gudang (is_warehouse)
 */
function buildAliasMap(locs: LocationInfo[]): Map<string, string> {
  const alias = new Map<string, string>();
  for (const l of locs) {
    alias.set(l.code.toLowerCase(), l.code);
    alias.set(l.label.toLowerCase(), l.code);
    const m = l.code.match(/^([a-z]+)(\d+)$/i);
    if (m) alias.set(`${m[1]!.toLowerCase()} ${m[2]}`, l.code);
    if (l.isWarehouse) alias.set("gudang", l.code);
  }
  return alias;
}

export function buildLocationCtx(locs: LocationInfo[]): LocationCtx {
  const active = locs.filter((l) => l.active);
  const locationSet = new Set(active.map((l) => l.code));
  const canteenSet = new Set(active.filter((l) => l.isCanteen).map((l) => l.code));
  const batch50Set = new Set(active.filter((l) => l.isBatch50).map((l) => l.code));
  const warehouseSet = new Set(locs.filter((l) => l.isWarehouse).map((l) => l.code));
  const defaultPrice = new Map<string, number>();
  for (const l of active) {
    if (l.priceRp !== null) defaultPrice.set(l.code, l.priceRp);
  }
  return {
    locationSet,
    canteenSet,
    batch50Set,
    warehouseSet,
    defaultPrice,
    aliasMap: buildAliasMap(active),
  };
}

/** Muat konteks lokasi langsung dari DB (fresh=true untuk jalur tulis bot). */
export async function loadLocationCtx(sql: Sql, fresh = false): Promise<LocationCtx> {
  const locs = fresh ? await getLocationsFresh(sql) : await getLocations(sql);
  return buildLocationCtx(locs);
}

// ===== Tampilan (label / warna / ikon) =====

// Palet warna deterministik untuk lokasi tanpa `color` (biar grafik stabil).
const PALETTE = [
  "#2563eb", "#16a34a", "#f59e0b", "#dc2626",
  "#7c3aed", "#0891b2", "#db2777", "#65a30d",
];

export function fallbackColor(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

function fallbackIcon(l: LocationInfo): string {
  if (l.isWarehouse) return "🏠";
  if (l.isBatch50) return "🧊";
  return "🏫";
}

/** Peta code → label (fallback: kode di-UPPERCASE). */
export function labelMapOf(locs: LocationInfo[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of locs) m[l.code] = l.label;
  return m;
}

/** Peta code → warna (fallback: palet deterministik). */
export function colorMapOf(locs: LocationInfo[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of locs) m[l.code] = l.color ?? fallbackColor(l.code);
  return m;
}

/** Peta code → ikon (fallback: gudang/kulkas/sekolah). */
export function iconMapOf(locs: LocationInfo[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of locs) m[l.code] = l.icon ?? fallbackIcon(l);
  return m;
}
