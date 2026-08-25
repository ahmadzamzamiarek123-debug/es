// Validasi zod untuk hasil parsing (regex maupun Gemini) dan pengaturan data master.
// Output AI = DATA TAK TERPERCAYA → semua wajib lolos schema ini sebelum insert.
// Rentang wajar mengikuti batas yang logis — di luar itu ditolak, bukan diperbaiki diam-diam.

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
  "gaji_ayah",
  "lainnya",
] as const;

export const paymentMethodEnum = z.enum(PAYMENT_METHODS);
export const cashoutKindEnum = z.enum(CASHOUT_KINDS);
export const expenseCategoryEnum = z.enum(EXPENSE_CATEGORIES);

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

// Uang selalu integer rupiah (tanpa desimal/float).
const rupiahInt = z
  .number()
  .int("nominal harus bilangan bulat rupiah (tanpa desimal)");

// ===== 1. Produksi =====
export const productionSchema = z.object({
  prod_date: isoDate,
  recipes: z.number().int().min(1, "resep minimal 1").max(50, "resep maksimal 50"),
  // Yield per resep (opsional; default 85 jika tidak disebut)
  pieces_per_recipe: z
    .number()
    .int()
    .min(1, "pcs per resep minimal 1")
    .max(200, "pcs per resep maksimal 200")
    .optional(),
  // Daftar nama pekerja yang ikut (misal ['adek', 'diri_sendiri'])
  workers: z.array(z.string()).optional(),
  note,
});

// ===== 2. Mutasi stok (BUKAN penjualan) =====
export const stockMovementSchema = z
  .object({
    move_date: isoDate,
    from_loc: locString,
    to_loc: locString,
    qty: z
      .number({
        invalid_type_error: "sebutkan jumlah biji yang dikirim (mis. kirim mts1 100)",
        required_error: "sebutkan jumlah biji yang dikirim (mis. kirim mts1 100)",
      })
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
export const saleSchema = z.object({
  sale_date: isoDate,
  canteen: locString,
  qty: z
    .number({
      invalid_type_error: "sebutkan jumlah biji yang terjual (mis. jual mts1 79)",
      required_error: "sebutkan jumlah biji yang terjual (mis. jual mts1 79)",
    })
    .int()
    .min(0, "qty tak boleh negatif")
    .max(2000, "qty tak wajar (>2000)"),
  price_rp: z
    .number({
      invalid_type_error: "harga per biji belum jelas (mis. jual mts1 79 @1300)",
      required_error: "harga per biji belum jelas (mis. jual mts1 79 @1300)",
    })
    .int()
    .min(100, "harga tak wajar (<100)")
    .max(5000, "harga tak wajar (>5000)"),
  note,
});

// ===== 4. Kas masuk =====
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
  // Aturan domain: spp_ayah = pengambilan (owner draw), gaji_ayah = pengeluaran (biaya usaha)
  .refine((r) => !(r.category === "spp_ayah" && r.kind !== "pengambilan"), {
    message: "kategori spp_ayah harus berjenis 'pengambilan'",
    path: ["kind"],
  })
  .refine((r) => !(r.category === "gaji_ayah" && r.kind !== "pengeluaran"), {
    message: "kategori gaji_ayah harus berjenis 'pengeluaran'",
    path: ["kind"],
  });

// ===== Schema untuk /setting dan Pengaturan Master Data =====

// 1. Lokasi / Kantin
export const locationSettingSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,19}$/, "kode: huruf/angka, 2–20 karakter, diawali huruf"),
  label: z.string().trim().min(1, "nama tampilan wajib").max(40),
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

// 2. Saldo Awal (Modal)
export const openingBalanceSchema = z.object({
  saldo_awal_rp: rupiahInt
    .refine((v) => v >= 0, "saldo awal tak boleh negatif")
    .refine((v) => v < 1_000_000_000, "saldo awal tak wajar (>= 1 miliar)"),
  note: note,
});
export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;

// 3. Update Harga Bahan (per unit/satuan)
export const ingredientPriceUpdateSchema = z.object({
  name: z.string().trim().min(1, "nama bahan wajib"),
  price_per_unit_rp: z
    .number()
    .min(0.0001, "harga harus lebih dari 0")
    .max(1_000_000, "harga satuan terlalu tinggi"),
  raw_text: z.string().optional(), // misal "55rb per kilo"
});
export type IngredientPriceUpdateInput = z.infer<typeof ingredientPriceUpdateSchema>;

// 4. Pengaturan Karyawan / Worker
export const workerSettingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "nama pekerja wajib")
    .max(30),
  role: z.enum(["produksi", "antar"]).default("produksi"),
  rate_type: z.enum(["per_resep", "per_pcs", "per_hari"]).default("per_resep"),
  rate_rp: z.number().int().min(0, "rate gaji tidak boleh negatif"),
  status: z.enum(["aktif", "rencana_belum_final"]).default("aktif"),
});
export type WorkerSettingInput = z.infer<typeof workerSettingSchema>;

// 5. Pengaturan Biaya Tetap Bulanan
export const monthlyFixedCostSchema = z.object({
  effective_month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "format bulan harus YYYY-MM"),
  amount_rp: rupiahInt
    .refine((v) => v >= 0, "biaya tetap tidak boleh negatif")
    .refine((v) => v < 50_000_000, "nominal biaya tetap terlalu besar"),
  note: note,
});
export type MonthlyFixedCostInput = z.infer<typeof monthlyFixedCostSchema>;

// 6. Pengaturan Default Pieces per Resep
export const defaultPiecesSchema = z.object({
  pieces_per_recipe: z
    .number()
    .int()
    .min(1, "pcs per resep minimal 1")
    .max(200, "pcs per resep maksimal 200"),
});
export type DefaultPiecesInput = z.infer<typeof defaultPiecesSchema>;

// ===== Tipe TS turunan =====
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

export type ParsedBatch =
  | { entity: "production"; rows: Production[] }
  | { entity: "stock_movement"; rows: StockMovement[] }
  | { entity: "sale"; rows: Sale[] }
  | { entity: "cash_in"; rows: CashIn[] }
  | { entity: "cash_out"; rows: CashOut[] };

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

export function checkBatch50(sale: Sale, batch50Set: Set<string>): string[] {
  const errors: string[] = [];
  if (batch50Set.has(sale.canteen) && sale.qty % 50 !== 0) {
    errors.push(
      `penjualan ${sale.canteen.toUpperCase()} pakai batch 50 → qty harus kelipatan 50 (dapat ${sale.qty})`,
    );
  }
  return errors;
}

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
  return { ok: true, batch: { entity, rows: validRows } as ParsedBatch };
}

export type ValidateManyResult =
  | { ok: true; batches: ParsedBatch[] }
  | { ok: false; errors: string[] };

export function validateBatches(
  inputs: { entity: unknown; rows: unknown }[],
  ctx: LocationCtx,
): ValidateManyResult {
  if (inputs.length === 0) {
    return { ok: false, errors: ["tidak ada operasi yang dikenali"] };
  }
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
