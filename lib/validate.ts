// Validasi zod untuk hasil parsing (regex maupun Gemini).
// Output AI = DATA TAK TERPERCAYA → semua wajib lolos schema ini sebelum insert.
// Rentang wajar mengikuti CLAUDE.md §2 (batas contoh) — di luar itu ditolak,
// bukan diperbaiki diam-diam.
//
// CATATAN: daftar lokasi kini DINAMIS (tabel location_ref, lihat lib/locations.ts).
// zod hanya menjaga BENTUK (string tak kosong); keanggotaan lokasi/kantin dicek
// terhadap `LocationCtx` yang di-inject pemanggil (bukan enum statis lagi).

import { z } from "zod";
import type { LocationCtx } from "./locations";

// ===== Enum domain yang MASIH statis (samakan dengan ENUM Postgres) =====
export const PAYMENT_METHODS = ["cash", "transfer"] as const;
export const CASHOUT_KINDS = ["pengeluaran", "pengambilan"] as const;
export const EXPENSE_CATEGORIES = [
  "bahan",
  "gas_listrik",
  "plastik",
  "transport",
  "spp_ayah",
  "lainnya",
] as const;

// Siapa yang mengerjakan produksi. Upah Rp5.000/resep per orang yang ikut:
// berdua → Zummy+Aril (10.000/resep), zummy/aril → hanya dia (5.000/resep).
export const WORKERS = ["berdua", "zummy", "aril"] as const;

export const paymentMethodEnum = z.enum(PAYMENT_METHODS);
export const cashoutKindEnum = z.enum(CASHOUT_KINDS);
export const expenseCategoryEnum = z.enum(EXPENSE_CATEGORIES);
export const workerEnum = z.enum(WORKERS);

// Lokasi/kantin: hanya bentuk (string tak kosong). Keanggotaan dicek via ctx.
const locString = z.string().min(1, "lokasi belum jelas");

// Tanggal 'YYYY-MM-DD' yang benar-benar valid (bukan sekadar pola).
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "tanggal harus format YYYY-MM-DD")
  .refine((s) => {
    const parts = s.split("-").map(Number);
    const y = parts[0] ?? 0;
    const m = parts[1] ?? 0;
    const d = parts[2] ?? 0;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, "tanggal tidak nyata");

// Catatan bebas opsional; batasi panjang agar tidak jadi vektor spam.
const note = z.string().trim().max(280).optional();

// Uang selalu integer rupiah (tanpa desimal/float). CLAUDE.md §0.3.
const rupiahInt = z
  .number()
  .int("nominal harus bilangan bulat rupiah (tanpa desimal)");

// ===== 1. Produksi =====
// recipes 1–50 (CLAUDE.md). output_pieces & upah dihitung DB, jangan dikirim.
export const productionSchema = z.object({
  prod_date: isoDate,
  recipes: z.number().int().min(1, "resep minimal 1").max(50, "resep maksimal 50"),
  worker: workerEnum.default("berdua"),
  note,
});

// ===== 2. Mutasi stok (BUKAN penjualan) =====
export const stockMovementSchema = z
  .object({
    move_date: isoDate,
    from_loc: locString,
    to_loc: locString,
    qty: z
      .number({ invalid_type_error: "sebutkan jumlah biji yang dikirim (mis. kirim mts1 100)", required_error: "sebutkan jumlah biji yang dikirim (mis. kirim mts1 100)" })
      .int()
      .min(1, "qty minimal 1")
      .max(2000, "qty tak wajar (>2000)"),
    note,
  })
  .refine((r) => r.from_loc !== r.to_loc, {
    message: "lokasi asal & tujuan tidak boleh sama",
    path: ["to_loc"],
  });

// ===== 3. Penjualan =====
// price_rp 100–5000 (CLAUDE.md). qty 0–2000. Aturan batch 50 dicek terpisah
// di bawah (lewat checkBatch50) agar pesan errornya jelas & bisa minta konfirmasi.
export const saleSchema = z.object({
  sale_date: isoDate,
  canteen: locString,
  qty: z
    .number({ invalid_type_error: "sebutkan jumlah biji yang terjual (mis. jual mts1 79)", required_error: "sebutkan jumlah biji yang terjual (mis. jual mts1 79)" })
    .int()
    .min(0, "qty tak boleh negatif")
    .max(2000, "qty tak wajar (>2000)"),
  price_rp: z
    .number({ invalid_type_error: "harga per biji belum jelas (mis. jual mts1 79 @1300)", required_error: "harga per biji belum jelas (mis. jual mts1 79 @1300)" })
    .int()
    .min(100, "harga tak wajar (<100)")
    .max(5000, "harga tak wajar (>5000)"),
  note,
});

// ===== 4. Kas masuk =====
// amount_rp > 0 & < 100 juta (CLAUDE.md).
export const cashInSchema = z.object({
  received_date: isoDate,
  canteen: locString,
  amount_rp: rupiahInt
    .refine((v) => v > 0, "jumlah harus > 0")
    .refine((v) => v < 100_000_000, "jumlah tak wajar (>= 100 juta)"),
  method: paymentMethodEnum.default("cash"),
  note,
});

// ===== 5. Pengeluaran & Pengambilan =====
export const cashOutSchema = z
  .object({
    out_date: isoDate,
    kind: cashoutKindEnum,
    category: expenseCategoryEnum,
    amount_rp: rupiahInt
      .refine((v) => v > 0, "jumlah harus > 0")
      .refine((v) => v < 100_000_000, "jumlah tak wajar (>= 100 juta)"),
    note,
  })
  // Uang MTS2 diambil ayah = kind 'pengambilan' + category 'spp_ayah'.
  // Kategori spp_ayah hanya masuk akal untuk pengambilan, bukan pengeluaran usaha.
  .refine((r) => !(r.category === "spp_ayah" && r.kind !== "pengambilan"), {
    message: "kategori spp_ayah harus berjenis 'pengambilan'",
    path: ["kind"],
  });

// ===== Schema untuk /setting (kelola lokasi & saldo awal) =====

// Kode lokasi: huruf kecil + angka, ringkas & aman jadi kunci (mis. 'mts1').
export const locationSettingSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,19}$/, "kode: huruf/angka, 2–20 karakter, diawali huruf"),
  label: z.string().trim().min(1, "nama tampilan wajib").max(40),
  // Harga jual kita per biji (uang kita), 100–5000. Opsional (boleh diisi nanti).
  price_rp: z
    .number()
    .int()
    .min(100, "harga tak wajar (<100)")
    .max(5000, "harga tak wajar (>5000)")
    .nullable()
    .optional(),
  is_batch50: z.boolean().default(false),
});
export type LocationSetting = z.infer<typeof locationSettingSchema>;

// Saldo awal (rupiah, integer, >= 0). Baseline modal (kas + nilai bahan awal).
export const openingBalanceSchema = z.object({
  saldo_awal_rp: rupiahInt
    .refine((v) => v >= 0, "saldo awal tak boleh negatif")
    .refine((v) => v < 1_000_000_000, "saldo awal tak wajar (>= 1 miliar)"),
  note: note,
});
export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;

// ===== Tipe TS turunan (z.infer) =====
export type Production = z.infer<typeof productionSchema>;
export type StockMovement = z.infer<typeof stockMovementSchema>;
export type Sale = z.infer<typeof saleSchema>;
export type CashIn = z.infer<typeof cashInSchema>;
export type CashOut = z.infer<typeof cashOutSchema>;

export type Entity =
  | "production"
  | "stock_movement"
  | "sale"
  | "cash_in"
  | "cash_out";

// Kontrak JSON hasil parse: selalu { entity, rows[] }.
export type ParsedBatch =
  | { entity: "production"; rows: Production[] }
  | { entity: "stock_movement"; rows: StockMovement[] }
  | { entity: "sale"; rows: Sale[] }
  | { entity: "cash_in"; rows: CashIn[] }
  | { entity: "cash_out"; rows: CashOut[] };

// Peta entity → schema baris, dipakai validasi generik.
const ROW_SCHEMA = {
  production: productionSchema,
  stock_movement: stockMovementSchema,
  sale: saleSchema,
  cash_in: cashInSchema,
  cash_out: cashOutSchema,
} as const;

export type ValidateResult =
  | { ok: true; batch: ParsedBatch }
  | { ok: false; errors: string[] };

/**
 * Validasi tambahan khusus penjualan SMA/SMK: qty wajib kelipatan 50.
 * Dikembalikan sebagai daftar pesan (kosong = lolos) supaya bot bisa
 * minta konfirmasi ulang, bukan mengoreksi diam-diam.
 */
export function checkBatch50(sale: Sale, batch50Set: Set<string>): string[] {
  const errors: string[] = [];
  if (batch50Set.has(sale.canteen) && sale.qty % 50 !== 0) {
    errors.push(
      `penjualan ${sale.canteen.toUpperCase()} pakai batch 50 → qty harus kelipatan 50 (dapat ${sale.qty})`,
    );
  }
  return errors;
}

/** Pesan ramah saat sebuah kode lokasi tak dikenal / bukan kantin. */
function unknownLocMsg(code: string, ctx: LocationCtx, mustBeCanteen: boolean): string {
  if (ctx.warehouseSet.has(code)) {
    return mustBeCanteen
      ? `'${code}' itu gudang, bukan kantin — tidak bisa untuk penjualan/kas`
      : `'${code}' tidak bisa dipakai di sini`;
  }
  if (mustBeCanteen && ctx.locationSet.has(code)) {
    return `'${code}' bukan kantin`;
  }
  return `lokasi '${code}' belum terdaftar (tambahkan dulu lewat /setting)`;
}

/**
 * Validasi satu batch hasil parse. Menerima bentuk longgar (unknown),
 * mengembalikan batch bertipe kuat bila lolos, atau daftar error yang
 * ramah untuk ditampilkan ke chat (tanpa membocorkan detail internal).
 * `ctx` = daftar lokasi/kantin/batch50 aktif (dari lib/locations.ts).
 */
export function validateBatch(
  input: { entity: unknown; rows: unknown },
  ctx: LocationCtx,
): ValidateResult {
  const entityParse = z
    .enum(["production", "stock_movement", "sale", "cash_in", "cash_out"])
    .safeParse(input.entity);
  if (!entityParse.success) {
    return { ok: false, errors: ["jenis catatan tidak dikenali"] };
  }
  const entity = entityParse.data;

  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return { ok: false, errors: ["tidak ada baris data untuk disimpan"] };
  }
  // Batas jumlah baris per pesan agar tidak kebanjiran (mis. AI ngawur).
  if (input.rows.length > 50) {
    return { ok: false, errors: ["terlalu banyak baris dalam satu pesan (maks 50)"] };
  }

  const schema = ROW_SCHEMA[entity];
  const validRows: unknown[] = [];
  const errors: string[] = [];

  input.rows.forEach((row, i) => {
    const res = schema.safeParse(row);
    if (!res.success) {
      const msgs = res.error.issues.map((issue) => issue.message);
      errors.push(`baris ${i + 1}: ${msgs.join(", ")}`);
      return;
    }
    // Cek keanggotaan lokasi/kantin terhadap ctx (dinamis).
    if (entity === "stock_movement") {
      const m = res.data as StockMovement;
      if (!ctx.locationSet.has(m.from_loc)) {
        errors.push(`baris ${i + 1}: ${unknownLocMsg(m.from_loc, ctx, false)}`);
        return;
      }
      if (!ctx.locationSet.has(m.to_loc)) {
        errors.push(`baris ${i + 1}: ${unknownLocMsg(m.to_loc, ctx, false)}`);
        return;
      }
    }
    if (entity === "sale") {
      const s = res.data as Sale;
      if (!ctx.canteenSet.has(s.canteen)) {
        errors.push(`baris ${i + 1}: ${unknownLocMsg(s.canteen, ctx, true)}`);
        return;
      }
      const b50 = checkBatch50(s, ctx.batch50Set);
      if (b50.length) {
        errors.push(`baris ${i + 1}: ${b50.join(", ")}`);
        return;
      }
    }
    if (entity === "cash_in") {
      const c = res.data as CashIn;
      if (!ctx.canteenSet.has(c.canteen)) {
        errors.push(`baris ${i + 1}: ${unknownLocMsg(c.canteen, ctx, true)}`);
        return;
      }
    }
    validRows.push(res.data);
  });

  if (errors.length) return { ok: false, errors };

  // Cast aman: tiap baris sudah lolos schema entity yang sesuai.
  return { ok: true, batch: { entity, rows: validRows } as ParsedBatch };
}

export type ValidateManyResult =
  | { ok: true; batches: ParsedBatch[] }
  | { ok: false; errors: string[] };

/**
 * Validasi BEBERAPA batch sekaligus (hasil pesan multi-operasi).
 * Semua-atau-tidak: satu operasi tak valid → seluruh pesan ditolak dengan
 * pesan per operasi, supaya user tidak setengah tersimpan tanpa sadar.
 */
export function validateBatches(
  inputs: { entity: unknown; rows: unknown }[],
  ctx: LocationCtx,
): ValidateManyResult {
  if (inputs.length === 0) {
    return { ok: false, errors: ["tidak ada operasi yang dikenali"] };
  }
  // Batas operasi per pesan agar konfirmasi tetap terbaca.
  if (inputs.length > 10) {
    return { ok: false, errors: ["terlalu banyak operasi dalam satu pesan (maks 10)"] };
  }
  const batches: ParsedBatch[] = [];
  const errors: string[] = [];
  inputs.forEach((input, i) => {
    const res = validateBatch(input, ctx);
    if (res.ok) {
      batches.push(res.batch);
    } else {
      errors.push(...res.errors.map((e) => `operasi ${i + 1}: ${e}`));
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, batches };
}
