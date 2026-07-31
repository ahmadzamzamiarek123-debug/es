// Uji validasi zod: nilai wajar lolos, nilai di luar rentang ditolak, dan
// aturan domain (batch 50, spp_ayah) ditegakkan.
//
// Lokasi kini DINAMIS: validateBatch menerima LocationCtx & checkBatch50
// menerima batch50Set. Test membangun ctx dummy via buildLocationCtx (tanpa DB).
import { describe, it, expect } from "vitest";
import { validateBatch, checkBatch50, locationSettingSchema, openingBalanceSchema } from "../lib/validate";
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
      rows: [{ prod_date: "2026-07-14", recipes: 6, worker: "berdua" }],
    }, CTX);
    expect(r.ok).toBe(true);
  });

  it("resep 0 ditolak (min 1)", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 0, worker: "berdua" }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("resep 999 ditolak (>50)", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 999, worker: "berdua" }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("validateBatch — penjualan & harga", () => {
  it("harga di luar rentang (>5000) ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "mts1", qty: 10, price_rp: 999999 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("harga terlalu rendah (<100) ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "mts1", qty: 10, price_rp: 5 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("canteen 'rumah' (gudang) ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "rumah", qty: 10, price_rp: 1300 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("canteen belum terdaftar ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "sdxyz", qty: 10, price_rp: 1300 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("aturan batch 50 (SMA/SMK)", () => {
  it("SMA qty 50 lolos", () => {
    expect(checkBatch50({ sale_date: "2026-07-14", canteen: "sma", qty: 50, price_rp: 1300 }, BATCH50)).toEqual([]);
  });

  it("SMA qty 30 (bukan kelipatan 50) ditolak", () => {
    const errs = checkBatch50({ sale_date: "2026-07-14", canteen: "sma", qty: 30, price_rp: 1300 }, BATCH50);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("MTS1 qty 30 boleh (bukan kantin batch 50)", () => {
    expect(checkBatch50({ sale_date: "2026-07-14", canteen: "mts1", qty: 30, price_rp: 1300 }, BATCH50)).toEqual([]);
  });

  it("validateBatch menolak penjualan SMK non-kelipatan-50", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "smk", qty: 33, price_rp: 1300 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("pengambilan ayah (owner draw manual)", () => {
  it("pengambilan + spp_ayah lolos", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengambilan", category: "spp_ayah", amount_rp: 31500 }],
    }, CTX);
    expect(r.ok).toBe(true);
  });

  it("spp_ayah tapi kind 'pengeluaran' ditolak", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "spp_ayah", amount_rp: 31500 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("amount_rp 0 ditolak (harus > 0)", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "bahan", amount_rp: 0 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("amount_rp >= 100 juta ditolak", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "bahan", amount_rp: 100_000_000 }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("validateBatch — kas masuk", () => {
  it("desimal (float) ditolak — uang harus integer", () => {
    const r = validateBatch({
      entity: "cash_in",
      rows: [{ received_date: "2026-07-14", canteen: "mts1", amount_rp: 900.5, method: "cash" }],
    }, CTX);
    expect(r.ok).toBe(false);
  });

  it("tanggal tidak nyata ditolak", () => {
    const r = validateBatch({
      entity: "cash_in",
      rows: [{ received_date: "2026-13-40", canteen: "mts1", amount_rp: 90000, method: "cash" }],
    }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe("/setting — lokasi", () => {
  it("kode + nama + harga valid lolos", () => {
    const r = locationSettingSchema.safeParse({
      code: "SDN1",
      label: "SDN 1 Makmur",
      price_rp: 1300,
      is_batch50: false,
    });
    expect(r.success).toBe(true);
    // code dinormalkan ke huruf kecil.
    if (r.success) expect(r.data.code).toBe("sdn1");
  });

  it("kode diawali angka ditolak", () => {
    const r = locationSettingSchema.safeParse({ code: "1sd", label: "X" });
    expect(r.success).toBe(false);
  });

  it("harga di luar rentang ditolak", () => {
    const r = locationSettingSchema.safeParse({ code: "sd1", label: "SD 1", price_rp: 99 });
    expect(r.success).toBe(false);
  });

  it("harga boleh null (diisi nanti)", () => {
    const r = locationSettingSchema.safeParse({ code: "sd1", label: "SD 1", price_rp: null });
    expect(r.success).toBe(true);
  });
});

describe("/setting — saldo awal", () => {
  it("nominal >= 0 lolos", () => {
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: 500000 }).success).toBe(true);
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: 0 }).success).toBe(true);
  });

  it("negatif ditolak", () => {
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: -1 }).success).toBe(false);
  });

  it("float ditolak — uang harus integer", () => {
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: 500000.5 }).success).toBe(false);
  });

  it(">= 1 miliar ditolak", () => {
    expect(openingBalanceSchema.safeParse({ saldo_awal_rp: 1_000_000_000 }).success).toBe(false);
  });
});
