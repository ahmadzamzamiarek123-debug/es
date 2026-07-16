// Validasi zod untuk hasil parsing (regex maupun Gemini).
// Output AI = DATA TAK TERPERCAYA → semua wajib lolos schema ini sebelum insert.
// Rentang wajar mengikuti CLAUDE.md §2 (batas contoh) — di luar itu ditolak,
// bukan diperbaiki diam-diam.

import { z } from "zod";

// ===== Enum domain (samakan dengan ENUM Postgres di 0001_init.sql) =====
export const LOCATIONS = ["rumah", "mts1", "mts2", "smp", "sma", "smk"] as const;
export const CANTEENS = ["mts1", "mts2", "smp", "sma", "smk"] as const; // tanpa 'rumah'
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

// Kantin yang memakai model batch 50 (kulkas, stok fisik tak dihitung).
export const BATCH50_CANTEENS = ["sma", "smk"] as const;

// Siapa yang mengerjakan produksi. Upah Rp3.000/resep per orang yang ikut:
// berdua → Zummy+Aril (6000/resep), zummy/aril → hanya dia (3000/resep).
export const WORKERS = ["berdua", "zummy", "aril"] as const;

export const locationEnum = z.enum(LOCATIONS);
export const canteenEnum = z.enum(CANTEENS);
export const paymentMethodEnum = z.enum(PAYMENT_METHODS);
export const cashoutKindEnum = z.enum(CASHOUT_KINDS);
export const expenseCategoryEnum = z.enum(EXPENSE_CATEGORIES);
export const workerEnum = z.enum(WORKERS);

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
    from_loc: locationEnum,
    to_loc: locationEnum,
    qty: z.number().int().min(1, "qty minimal 1").max(2000, "qty tak wajar (>2000)"),
    note,
  })
  .refine((r) => r.from_loc !== r.to_loc, {
    message: "lokasi asal & tujuan tidak boleh sama",
    path: ["to_loc"],
  });

// ===== 3. Penjualan =====
// price_rp 100–5000 (CLAUDE.md). qty 0–2000. Aturan batch 50 dicek terpisah
// di bawah (lewat validateSale) agar pesan errornya jelas & bisa minta konfirmasi.
export const saleSchema = z.object({
  sale_date: isoDate,
  canteen: canteenEnum,
  qty: z.number().int().min(0, "qty tak boleh negatif").max(2000, "qty tak wajar (>2000)"),
  price_rp: z
    .number()
    .int()
    .min(100, "harga tak wajar (<100)")
    .max(5000, "harga tak wajar (>5000)"),
  note,
});

// ===== 4. Kas masuk =====
// amount_rp > 0 & < 100 juta (CLAUDE.md).
export const cashInSchema = z.object({
  received_date: isoDate,
  canteen: canteenEnum,
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
 * Apakah kantin memakai model batch 50 (SMA/SMK)?
 */
export function isBatch50Canteen(canteen: string): boolean {
  return (BATCH50_CANTEENS as readonly string[]).includes(canteen);
}

/**
 * Validasi tambahan khusus penjualan SMA/SMK: qty wajib kelipatan 50.
 * Dikembalikan sebagai daftar pesan (kosong = lolos) supaya bot bisa
 * minta konfirmasi ulang, bukan mengoreksi diam-diam.
 */
export function checkBatch50(sale: Sale): string[] {
  const errors: string[] = [];
  if (isBatch50Canteen(sale.canteen) && sale.qty % 50 !== 0) {
    errors.push(
      `penjualan ${sale.canteen.toUpperCase()} pakai batch 50 → qty harus kelipatan 50 (dapat ${sale.qty})`,
    );
  }
  return errors;
}

/**
 * Validasi satu batch hasil parse. Menerima bentuk longgar (unknown),
 * mengembalikan batch bertipe kuat bila lolos, atau daftar error yang
 * ramah untuk ditampilkan ke chat (tanpa membocorkan detail internal).
 */
export function validateBatch(input: {
  entity: unknown;
  rows: unknown;
}): ValidateResult {
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
    // Aturan domain lintas-field untuk penjualan.
    if (entity === "sale") {
      const b50 = checkBatch50(res.data as Sale);
      if (b50.length) {
        errors.push(`baris ${i + 1}: ${b50.join(", ")}`);
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
    const res = validateBatch(input);
    if (res.ok) {
      batches.push(res.batch);
    } else {
      errors.push(...res.errors.map((e) => `operasi ${i + 1}: ${e}`));
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, batches };
}
