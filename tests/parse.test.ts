// Uji parser regex (tanpa memanggil Gemini). Memastikan kalimat rapi → JSON benar.
import { describe, it, expect } from "vitest";
import { parseWithRegex, parseRupiah } from "../lib/parse";
import { todayJakarta } from "../lib/dates";

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

  it("produksi", () => {
    expect(parseWithRegex("produksi 6 resep")).toEqual({
      entity: "production",
      rows: [{ prod_date: today, recipes: 6 }],
    });
  });

  it("mutasi kirim rumah->mts1", () => {
    expect(parseWithRegex("kirim rumah->mts1 100")).toEqual({
      entity: "stock_movement",
      rows: [{ move_date: today, from_loc: "rumah", to_loc: "mts1", qty: 100 }],
    });
  });

  it("mutasi lempar antar kantin (bukan penjualan)", () => {
    const r = parseWithRegex("lempar mts2 -> sma 15");
    expect(r?.entity).toBe("stock_movement");
    expect(r?.rows[0]).toMatchObject({ from_loc: "mts2", to_loc: "sma", qty: 15 });
  });

  it("penjualan dengan harga default kantin", () => {
    const r = parseWithRegex("jual mts1 100");
    expect(r?.entity).toBe("sale");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", qty: 100, price_rp: 900 });
  });

  it("penjualan SMA default 800 + batch 50", () => {
    const r = parseWithRegex("jual sma batch 50");
    expect(r?.entity).toBe("sale");
    expect(r?.rows[0]).toMatchObject({ canteen: "sma", qty: 50, price_rp: 800 });
  });

  it("penjualan dengan harga eksplisit @800", () => {
    const r = parseWithRegex("jual smk 50 @800");
    expect(r?.rows[0]).toMatchObject({ canteen: "smk", qty: 50, price_rp: 800 });
  });

  it("kas masuk", () => {
    const r = parseWithRegex("uang mts1 90rb");
    expect(r?.entity).toBe("cash_in");
    expect(r?.rows[0]).toMatchObject({ canteen: "mts1", amount_rp: 90000 });
  });

  it("pengambilan ayah → cash_out pengambilan/spp_ayah", () => {
    const r = parseWithRegex("ambil ayah 31500 spp");
    expect(r?.entity).toBe("cash_out");
    expect(r?.rows[0]).toMatchObject({
      kind: "pengambilan",
      category: "spp_ayah",
      amount_rp: 31500,
    });
  });

  it("pengeluaran beli bahan", () => {
    const r = parseWithRegex("beli bahan 20rb");
    expect(r?.entity).toBe("cash_out");
    expect(r?.rows[0]).toMatchObject({
      kind: "pengeluaran",
      category: "bahan",
      amount_rp: 20000,
    });
  });

  it("kalimat bebas → null (nanti fallback Gemini)", () => {
    expect(parseWithRegex("tadi pagi kayaknya laku lumayan deh")).toBeNull();
  });
});
