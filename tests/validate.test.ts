import { describe, it, expect } from "vitest";
import {
  validateBatch,
  checkBatch50,
  locationSettingSchema,
  openingBalanceSchema,
  ingredientPriceUpdateSchema,
  workerSettingSchema,
  monthlyFixedCostSchema,
  defaultPiecesSchema,
} from "../lib/validate";
import { buildLocationCtx, type LocationInfo, type LocationCtx } from "../lib/locations";

function loc(
  code: string,
  label: string,
  opts: Partial<LocationInfo> = {},
): LocationInfo {
  return {
    code,
    label,
    sortOrder: 0,
    isCanteen: false,
    isWarehouse: false,
    isBatch50: false,
    priceRp: null,
    color: null,
    icon: null,
    active: true,
    ...opts,
  };
}

const CTX: LocationCtx = buildLocationCtx([
  loc("rumah", "Rumah", { isWarehouse: true }),
  loc("mts1", "MTS1", { isCanteen: true, priceRp: 1300 }),
  loc("mts2", "MTS2", { isCanteen: true, priceRp: 1300 }),
  loc("sma", "SMA", { isCanteen: true, isBatch50: true, priceRp: 1300 }),
  loc("smk", "SMK", { isCanteen: true, isBatch50: true, priceRp: 1300 }),
]);
const BATCH50 = CTX.batch50Set;

describe("validateBatch — produksi", () => {
  it("resep 6 lolos", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 6, pieces_per_recipe: 85, workers: ["adek"] }],
    }, CTX);
    expect(r.ok).toBe(true);
  });

  it("resep 0 ditolak (min 1)", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 0 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("resep 999 ditolak (>50)", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 999 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("validateBatch — pengeluaran vs pengambilan (gaji ayah vs SPP)", () => {
  it("gaji_ayah dengan kind 'pengeluaran' lolos", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "gaji_ayah", amount_rp: 50000 }],
    }, CTX);
    expect(r.ok).toBe(true);
  });

  it("gaji_ayah dengan kind 'pengambilan' ditolak", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengambilan", category: "gaji_ayah", amount_rp: 50000 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("spp_ayah dengan kind 'pengambilan' lolos", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengambilan", category: "spp_ayah", amount_rp: 31500 }],
    }, CTX);
    expect(r.ok).toBe(true);
  });

  it("spp_ayah dengan kind 'pengeluaran' ditolak", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "spp_ayah", amount_rp: 31500 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("Master Data Zod Schemas", () => {
  it("ingredientPriceUpdateSchema", () => {
    expect(ingredientPriceUpdateSchema.safeParse({ name: "creamer", price_per_unit_rp: 55 }).success).toBe(true);
    expect(ingredientPriceUpdateSchema.safeParse({ name: "skm", price_per_unit_rp: 24.8 }).success).toBe(true);
    expect(ingredientPriceUpdateSchema.safeParse({ name: "", price_per_unit_rp: 55 }).success).toBe(false);
    expect(ingredientPriceUpdateSchema.safeParse({ name: "gula", price_per_unit_rp: 0 }).success).toBe(false);
  });

  it("workerSettingSchema", () => {
    expect(workerSettingSchema.safeParse({
      name: "bibi",
      role: "produksi",
      rate_type: "per_pcs",
      rate_rp: 150,
      status: "aktif",
    }).success).toBe(true);
    expect(workerSettingSchema.safeParse({
      name: "ayah",
      role: "antar",
      rate_type: "per_hari",
      rate_rp: 10000,
      status: "rencana_belum_final",
    }).success).toBe(true);
  });

  it("monthlyFixedCostSchema", () => {
    expect(monthlyFixedCostSchema.safeParse({ effective_month: "2026-08", amount_rp: 60000 }).success).toBe(true);
    expect(monthlyFixedCostSchema.safeParse({ effective_month: "2026/08", amount_rp: 60000 }).success).toBe(false);
    expect(monthlyFixedCostSchema.safeParse({ effective_month: "2026-08", amount_rp: -100 }).success).toBe(false);
  });

  it("defaultPiecesSchema", () => {
    expect(defaultPiecesSchema.safeParse({ pieces_per_recipe: 85 }).success).toBe(true);
    expect(defaultPiecesSchema.safeParse({ pieces_per_recipe: 0 }).success).toBe(false);
    expect(defaultPiecesSchema.safeParse({ pieces_per_recipe: 250 }).success).toBe(false);
  });
});

describe("aturan batch 50 (SMA/SMK)", () => {
  it("SMA qty 50 lolos", () => {
    expect(checkBatch50({ sale_date: "2026-07-14", canteen: "sma", qty: 50, price_rp: 1300 }, BATCH50)).toEqual([]);
  });

  it("SMA qty 30 ditolak", () => {
    const errs = checkBatch50({ sale_date: "2026-07-14", canteen: "sma", qty: 30, price_rp: 1300 }, BATCH50);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("/setting — lokasi & saldo awal", () => {
  it("kode + nama + harga valid lolos", () => {
    const r = locationSettingSchema.safeParse({
      code: "SDN1",
      label: "SDN 1 Makmur",
      price_rp: 1300,
      is_batch50: false,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("sdn1");
  });

  it("saldo awal valid", () => {
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: 500000 }).success).toBe(true);
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: -1 }).success).toBe(false);
  });
});
