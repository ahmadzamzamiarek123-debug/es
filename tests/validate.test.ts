// Uji validasi zod: nilai wajar lolos, nilai di luar rentang ditolak, dan
// aturan domain (batch 50, spp_ayah) ditegakkan.
import { describe, it, expect } from "vitest";
import { validateBatch, checkBatch50 } from "../lib/validate";

describe("validateBatch — produksi", () => {
  it("resep 6 lolos", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 6 }],
    });
    expect(r.ok).toBe(true);
  });

  it("resep 0 ditolak (min 1)", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 0 }],
    });
    expect(r.ok).toBe(false);
  });

  it("resep 999 ditolak (>50)", () => {
    const r = validateBatch({
      entity: "production",
      rows: [{ prod_date: "2026-07-14", recipes: 999 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateBatch — penjualan & harga", () => {
  it("harga di luar rentang (>5000) ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "mts1", qty: 10, price_rp: 999999 }],
    });
    expect(r.ok).toBe(false);
  });

  it("harga terlalu rendah (<100) ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "mts1", qty: 10, price_rp: 5 }],
    });
    expect(r.ok).toBe(false);
  });

  it("canteen 'rumah' ditolak", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "rumah", qty: 10, price_rp: 900 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("aturan batch 50 (SMA/SMK)", () => {
  it("SMA qty 50 lolos", () => {
    expect(checkBatch50({ sale_date: "2026-07-14", canteen: "sma", qty: 50, price_rp: 800 })).toEqual([]);
  });

  it("SMA qty 30 (bukan kelipatan 50) ditolak", () => {
    const errs = checkBatch50({ sale_date: "2026-07-14", canteen: "sma", qty: 30, price_rp: 800 });
    expect(errs.length).toBeGreaterThan(0);
  });

  it("MTS1 qty 30 boleh (bukan kantin batch 50)", () => {
    expect(checkBatch50({ sale_date: "2026-07-14", canteen: "mts1", qty: 30, price_rp: 900 })).toEqual([]);
  });

  it("validateBatch menolak penjualan SMK non-kelipatan-50", () => {
    const r = validateBatch({
      entity: "sale",
      rows: [{ sale_date: "2026-07-14", canteen: "smk", qty: 33, price_rp: 900 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("uang MTS2 diambil ayah", () => {
  it("pengambilan + spp_ayah lolos", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengambilan", category: "spp_ayah", amount_rp: 31500 }],
    });
    expect(r.ok).toBe(true);
  });

  it("spp_ayah tapi kind 'pengeluaran' ditolak", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "spp_ayah", amount_rp: 31500 }],
    });
    expect(r.ok).toBe(false);
  });

  it("amount_rp 0 ditolak (harus > 0)", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "bahan", amount_rp: 0 }],
    });
    expect(r.ok).toBe(false);
  });

  it("amount_rp >= 100 juta ditolak", () => {
    const r = validateBatch({
      entity: "cash_out",
      rows: [{ out_date: "2026-07-14", kind: "pengeluaran", category: "bahan", amount_rp: 100_000_000 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateBatch — kas masuk", () => {
  it("desimal (float) ditolak — uang harus integer", () => {
    const r = validateBatch({
      entity: "cash_in",
      rows: [{ received_date: "2026-07-14", canteen: "mts1", amount_rp: 900.5, method: "cash" }],
    });
    expect(r.ok).toBe(false);
  });

  it("tanggal tidak nyata ditolak", () => {
    const r = validateBatch({
      entity: "cash_in",
      rows: [{ received_date: "2026-13-40", canteen: "mts1", amount_rp: 90000, method: "cash" }],
    });
    expect(r.ok).toBe(false);
  });
});
