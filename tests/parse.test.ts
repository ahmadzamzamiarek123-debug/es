// Uji parser regex (tanpa memanggil Gemini). Memastikan kalimat rapi → JSON benar.
//
// Lokasi kini DINAMIS (tabel location_ref). Parser menerima LocationCtx, jadi
// test membangun ctx dummy via buildLocationCtx — TIDAK menyentuh DB. Harga
// default disuntik di sini (di produksi berasal dari /setting): kantin = 1300
// (omzet kita), SMA/SMK batch 50.
import { describe, it, expect } from "vitest";
import { parseWithRegex, parseMultiWithRegex, parseRupiah } from "../lib/parse";
import { buildLocationCtx, type LocationInfo, type LocationCtx } from "../lib/locations";
import { todayJakarta } from "../lib/dates";

/** Lokasi contoh untuk uji (meniru hasil /setting owner). */
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

describe("parseWithRegex", () => {
  const today = todayJakarta();

  it("produksi (default berdua)", () => {
    expect(parseWithRegex("produksi 6 resep", CTX)).toEqual({
      entity: "production",
      rows: [{ prod_date: today, recipes: 6, worker: "berdua" }],
    });
  });

  it("produksi sendiri → worker zummy", () => {
    const r = parseWithRegex("produksi 6 resep sendiri", CTX);
    expect(r?.rows[0]).toMatchObject({ recipes: 6, worker: "zummy" });
  });

  it("produksi sama aril → worker berdua", () => {
    const r = parseWithRegex("produksi 4 resep sama aril", CTX);
    expect(r?.rows[0]).toMatchObject({ recipes: 4, worker: "berdua" });
  });

  it("mutasi kirim rumah->mts1", () => {
    expect(parseWithRegex("kirim rumah->mts1 100", CTX)).toEqual({
      entity: "stock_movement",
      rows: [{ move_date: today, from_loc: "rumah", to_loc: "mts1", qty: 100 }],
    });
  });

  it("mutasi lempar antar kantin (bukan penjualan)", () => {
    const r = parseWithRegex("lempar mts2 -> sma 15", CTX);
    expect(r?.entity).toBe("stock_movement");
    expect(r?.rows[0]).toMatchObject({ from_loc: "mts2", to_loc: "sma", qty: 15 });
  });

  it("penjualan dengan harga default kantin", () => {
    const r = parseWithRegex("jual mts1 100", CTX);
    expect(r?.entity).toBe("sale");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", qty: 100, price_rp: 1300 });
  });

  it("penjualan SMA default kantin + batch 50", () => {
    const r = parseWithRegex("jual sma batch 50", CTX);
    expect(r?.entity).toBe("sale");
    expect(r?.rows[0]).toMatchObject({ canteen: "sma", qty: 50, price_rp: 1300, note: "batch 50" });
  });

  it("penjualan dengan harga eksplisit @800", () => {
    const r = parseWithRegex("jual smk 50 @800", CTX);
    expect(r?.rows[0]).toMatchObject({ canteen: "smk", qty: 50, price_rp: 800 });
  });

  it("kas masuk", () => {
    const r = parseWithRegex("uang mts1 90rb", CTX);
    expect(r?.entity).toBe("cash_in");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", amount_rp: 90000 });
  });

  it("pengambilan ayah → cash_out pengambilan/spp_ayah", () => {
    const r = parseWithRegex("ambil ayah 31500 spp", CTX);
    expect(r?.entity).toBe("cash_out");
    expect(r?.rows[0]).toMatchObject({
      kind: "pengambilan",
      category: "spp_ayah",
      amount_rp: 31500,
    });
  });

  it("pengeluaran beli bahan", () => {
    const r = parseWithRegex("beli bahan 20rb", CTX);
    expect(r?.entity).toBe("cash_out");
    expect(r?.rows[0]).toMatchObject({
      kind: "pengeluaran",
      category: "bahan",
      amount_rp: 20000,
    });
  });

  it("mutasi 'mts1 kirim 100' (tujuan di depan, asal rumah)", () => {
    const r = parseWithRegex("mts1 kirim 100", CTX);
    expect(r?.entity).toBe("stock_movement");
    expect(r?.rows[0]).toMatchObject({ from_loc: "rumah", to_loc: "mts1", qty: 100 });
  });

  it("mutasi 'kirim 50 ke sma' (asal rumah)", () => {
    const r = parseWithRegex("kirim 50 ke sma", CTX);
    expect(r?.entity).toBe("stock_movement");
    expect(r?.rows[0]).toMatchObject({ from_loc: "rumah", to_loc: "sma", qty: 50 });
  });

  it("penjualan dengan 'tanggal N' → tanggal bulan berjalan", () => {
    const r = parseWithRegex("tanggal 14 jual mts1 79", CTX);
    expect(r?.entity).toBe("sale");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", qty: 79 });
    // sale_date harus berakhiran -14 (hari ke-14), bukan hari ini
    expect((r?.rows[0] as { sale_date: string }).sale_date).toMatch(/-14$/);
  });

  it("kalimat bebas → null (nanti fallback Gemini)", () => {
    expect(parseWithRegex("tadi pagi kayaknya laku lumayan deh", CTX)).toBeNull();
  });
});

describe("parseMultiWithRegex", () => {
  it("beberapa operasi dipisah koma", () => {
    const r = parseMultiWithRegex("mts1 kirim 100, sma kirim 50", CTX);
    expect(r).not.toBeNull();
    expect(r).toHaveLength(2);
    expect(r?.[0]?.rows[0]).toMatchObject({ to_loc: "mts1", qty: 100 });
    expect(r?.[1]?.rows[0]).toMatchObject({ to_loc: "sma", qty: 50 });
  });

  it("campuran jenis: jual + kas masuk", () => {
    const r = parseMultiWithRegex("jual mts1 100, uang mts1 90rb", CTX);
    expect(r).toHaveLength(2);
    expect(r?.[0]?.entity).toBe("sale");
    expect(r?.[1]?.entity).toBe("cash_in");
  });

  it("satu potongan gagal → seluruhnya null (fallback Gemini)", () => {
    expect(parseMultiWithRegex("jual mts1 100, entah apa ini", CTX)).toBeNull();
  });
});
