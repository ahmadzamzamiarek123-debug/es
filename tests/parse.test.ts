import { describe, it, expect } from "vitest";
import {
  parseWithRegex,
  parseMultiWithRegex,
  parseRupiah,
  parseIngredientPriceUpdate,
  parseMonthlyFixedCost,
  parseDefaultPieces,
  parseWorkerSetting,
  parseWorkerStatusActivation,
} from "../lib/parse";
import { buildLocationCtx, type LocationInfo, type LocationCtx } from "../lib/locations";
import { buildWorkerCtx, type WorkerInfo, type WorkerCtx } from "../lib/workers";
import { todayJakarta, currentMonthJakarta } from "../lib/dates";

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
  loc("smp", "SMP", { isCanteen: true, priceRp: 1300 }),
  loc("sma", "SMA", { isCanteen: true, isBatch50: true, priceRp: 1300 }),
  loc("smk", "SMK", { isCanteen: true, isBatch50: true, priceRp: 1300 }),
]);

const WORKERS_LIST: WorkerInfo[] = [
  { id: 1, name: "adek", role: "produksi", rateType: "per_resep", rateRp: 5000, active: true, status: "aktif" },
  { id: 2, name: "diri_sendiri", role: "produksi", rateType: "per_resep", rateRp: 10000, active: true, status: "aktif" },
  { id: 3, name: "ayah", role: "antar", rateType: "per_hari", rateRp: 10000, active: true, status: "rencana_belum_final" },
];
const W_CTX: WorkerCtx = buildWorkerCtx(WORKERS_LIST);

describe("parseRupiah", () => {
  it("mengurai berbagai bentuk nominal", () => {
    expect(parseRupiah("20rb")).toBe(20000);
    expect(parseRupiah("90 ribu")).toBe(90000);
    expect(parseRupiah("20k")).toBe(20000);
    expect(parseRupiah("1,5jt")).toBe(1500000);
    expect(parseRupiah("1.5 juta")).toBe(1500000);
    expect(parseRupiah("31500")).toBe(31500);
    expect(parseRupiah("Rp90.000")).toBe(90000);
    expect(parseRupiah("abc")).toBeNull();
  });
});

describe("parseWithRegex — Produksi & Yield & Worker", () => {
  const today = todayJakarta();

  it("produksi standar", () => {
    const r = parseWithRegex("produksi 4 resep", CTX, W_CTX);
    expect(r).toEqual({
      entity: "production",
      rows: [{ prod_date: today, recipes: 4, pieces_per_recipe: undefined, workers: undefined }],
    });
  });

  it("produksi dengan yield custom dan pekerja eksplisit", () => {
    const r = parseWithRegex("produksi 4 resep hasil 340 sama adek", CTX, W_CTX);
    expect(r?.entity).toBe("production");
    expect(r?.rows[0]).toMatchObject({
      recipes: 4,
      pieces_per_recipe: 85,
      workers: ["adek"],
    });
  });

  it("produksi sendiri", () => {
    const r = parseWithRegex("produksi 6 resep sendiri", CTX, W_CTX);
    expect(r?.entity).toBe("production");
    expect(r?.rows[0]).toMatchObject({
      recipes: 6,
      workers: ["diri_sendiri"],
    });
  });
});

describe("parseWithRegex — Transaksi & Gaji Ayah", () => {
  const today = todayJakarta();

  it("gaji ayah (pengeluaran)", () => {
    const r = parseWithRegex("gaji ayah 50rb", CTX);
    expect(r?.entity).toBe("cash_out");
    expect(r?.rows[0]).toMatchObject({
      kind: "pengeluaran",
      category: "gaji_ayah",
      amount_rp: 50000,
    });
  });

  it("ambil ayah spp (pengambilan)", () => {
    const r = parseWithRegex("ambil ayah 31500 spp", CTX);
    expect(r?.entity).toBe("cash_out");
    expect(r?.rows[0]).toMatchObject({
      kind: "pengambilan",
      category: "spp_ayah",
      amount_rp: 31500,
    });
  });

  it("mutasi kirim rumah->mts1", () => {
    expect(parseWithRegex("kirim rumah->mts1 100", CTX)).toEqual({
      entity: "stock_movement",
      rows: [{ move_date: today, from_loc: "rumah", to_loc: "mts1", qty: 100 }],
    });
  });

  it("penjualan dengan harga default kantin", () => {
    const r = parseWithRegex("jual mts1 100", CTX);
    expect(r?.entity).toBe("sale");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", qty: 100, price_rp: 1300 });
  });

  it("kas masuk", () => {
    const r = parseWithRegex("uang mts1 90rb", CTX);
    expect(r?.entity).toBe("cash_in");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", amount_rp: 90000 });
  });
});

describe("Master Data Parser", () => {
  it("parseIngredientPriceUpdate — per kilo, per gram, per pcs", () => {
    const creamer = parseIngredientPriceUpdate("harga creamer sekarang 55rb per kilo");
    expect(creamer).toMatchObject({ name: "creamer", price_per_unit_rp: 55 });

    const gula = parseIngredientPriceUpdate("harga gula 18rb/kg");
    expect(gula).toMatchObject({ name: "gula", price_per_unit_rp: 18 });

    const skm = parseIngredientPriceUpdate("harga skm 62rb per 2.5kg");
    expect(skm).toMatchObject({ name: "skm", price_per_unit_rp: 24.8 });

    const plastik = parseIngredientPriceUpdate("harga plastik 40rb per 800 pcs");
    expect(plastik).toMatchObject({ name: "plastik", price_per_unit_rp: 50 });
  });

  it("parseMonthlyFixedCost", () => {
    const r = parseMonthlyFixedCost("biaya tetap bulan ini 65rb");
    expect(r).toMatchObject({ effective_month: currentMonthJakarta(), amount_rp: 65000 });

    const r2 = parseMonthlyFixedCost("biaya listrik gas 60rb");
    expect(r2).toMatchObject({ effective_month: currentMonthJakarta(), amount_rp: 60000 });
  });

  it("parseDefaultPieces", () => {
    const r = parseDefaultPieces("ganti default pcs per resep jadi 88");
    expect(r).toMatchObject({ pieces_per_recipe: 88 });

    const r2 = parseDefaultPieces("default pcs per resep 90");
    expect(r2).toMatchObject({ pieces_per_recipe: 90 });
  });

  it("parseWorkerSetting", () => {
    const r = parseWorkerSetting("tambah karyawan baru bibi, produksi, per pcs 150");
    expect(r).toMatchObject({
      name: "bibi",
      role: "produksi",
      rate_type: "per_pcs",
      rate_rp: 150,
      status: "aktif",
    });

    const r2 = parseWorkerSetting("gaji adek, produksi, per resep 6000");
    expect(r2).toMatchObject({
      name: "adek",
      role: "produksi",
      rate_type: "per_resep",
      rate_rp: 6000,
    });
  });

  it("parseWorkerStatusActivation", () => {
    const r = parseWorkerStatusActivation("ayah mulai digaji");
    expect(r).toMatchObject({ name: "ayah", status: "aktif" });
  });
});

describe("parseMultiWithRegex", () => {
  it("beberapa operasi dipisah koma", () => {
    const r = parseMultiWithRegex("mts1 kirim 100, sma kirim 50", CTX);
    expect(r).toHaveLength(2);
    expect(r?.[0]?.rows[0]).toMatchObject({ to_loc: "mts1", qty: 100 });
    expect(r?.[1]?.rows[0]).toMatchObject({ to_loc: "sma", qty: 50 });
  });
});
