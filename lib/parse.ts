// Parser input bot: REGEX/COMMAND DULU (hemat kuota Gemini), Gemini hanya
// fallback untuk kalimat bebas. Output selalu bentuk longgar { entity, rows }
// yang HARUS divalidasi oleh lib/validate.ts sebelum dipakai.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { todayJakarta, resolveRelativeDate, currentMonthJakarta } from "./dates";
import type { Entity, IngredientPriceUpdateInput, WorkerSettingInput, MonthlyFixedCostInput, DefaultPiecesInput } from "./validate";
import type { LocationCtx } from "./locations";
import type { WorkerCtx } from "./workers";
import { matchIngredientName } from "./hpp";

export interface RawBatch {
  entity: Entity;
  rows: Record<string, unknown>[];
}

/** Normalisasi ketikan lokasi → kode kanonik lewat alias ctx (dinamis). */
function normalizeLoc(s: string, ctx: LocationCtx): string | null {
  const key = s.trim().toLowerCase();
  const alias = ctx.aliasMap.get(key);
  if (alias) return alias;
  if (ctx.locationSet.has(key)) return key;
  return null;
}

/** Gudang default (sumber kiriman bila asal tak disebut) = gudang pertama. */
function defaultWarehouse(ctx: LocationCtx): string | null {
  for (const code of ctx.warehouseSet) return code;
  return null;
}

/**
 * Ubah teks nominal rupiah jadi integer / float.
 * Mendukung: "20rb", "20 ribu", "1.5jt", "31500", "Rp90.000", "2.5kg", dll.
 */
export function parseRupiah(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/rp/g, "").trim();
  const asDecimal = (s: string) => parseFloat(s.replace(",", "."));

  // bentuk "1,5jt" / "1.5 juta"
  const jtMatch = t.match(/^([\d.,]+)\s*(jt|juta)$/);
  if (jtMatch && jtMatch[1]) {
    const n = asDecimal(jtMatch[1]);
    if (!Number.isNaN(n)) return Math.round(n * 1_000_000);
  }
  // bentuk "20rb" / "90 ribu" / "20k"
  const rbMatch = t.match(/^([\d.,]+)\s*(rb|ribu|k)$/);
  if (rbMatch && rbMatch[1]) {
    const n = asDecimal(rbMatch[1]);
    if (!Number.isNaN(n)) return Math.round(n * 1_000);
  }
  // bentuk polos "31500" atau "90.000" (titik = pemisah ribuan Indonesia)
  const plain = t.replace(/\./g, "");
  if (/^\d+$/.test(plain)) {
    return parseInt(plain, 10);
  }
  return null;
}

const EXPENSE_KEYWORDS: Record<string, string> = {
  bahan: "bahan",
  gula: "bahan",
  santan: "bahan",
  creamer: "bahan",
  krimer: "bahan",
  skm: "bahan",
  uht: "bahan",
  maizena: "bahan",
  perisa: "bahan",
  glaze: "bahan",
  gas: "gas_listrik",
  listrik: "gas_listrik",
  plastik: "plastik",
  transport: "transport",
  bensin: "transport",
  ongkos: "transport",
};

// ===== Deteksi pertanyaan (jalur BACA, bukan input) =====

const QUESTION_HINTS =
  /(\bberapa\b|\bcek\b|\bstok\b|\blaporan\b|\bringkasan\b|\btotal\b|\briwayat\b|\btransaksi terakhir\b|\bhpp\b|\bgaji\b|\bpekerja\b|\bbiaya tetap\b|\?)/;
const INPUT_HINTS =
  /(\bproduksi\b|\bbuat\b|\bbikin\b|\bkirim\b|\blempar\b|\bpindah\b|\bjual\b|\buang\b|\bterima\b|\bbeli\b|\bbayar\b|\bambil\b)/;

export function isQuestion(text: string): boolean {
  const t = text.toLowerCase();
  if (!QUESTION_HINTS.test(t)) return false;
  if (/\bberapa\b|\?/.test(t)) return true;
  return !INPUT_HINTS.test(t);
}

// ===== Deteksi Worker Produksi =====

function parseWorkersFromText(seg: string, wCtx?: WorkerCtx): string[] | undefined {
  if (!wCtx) {
    if (/\b(sendiri|zummy)\b/.test(seg)) return ["diri_sendiri"];
    if (/\baril\b/.test(seg)) return ["adek"];
    if (/\b(sama|dengan|bareng|berdua)\b/.test(seg)) return ["adek", "diri_sendiri"];
    return undefined;
  }

  const found: string[] = [];
  const lower = seg.toLowerCase();

  // Cek pekerja terdaftar
  for (const [alias, w] of wCtx.workerMap.entries()) {
    const reg = new RegExp(`(?:^|\\b)${alias}(?:\\b|$)`, "i");
    if (reg.test(lower)) {
      if (!found.includes(w.name)) found.push(w.name);
    }
  }

  if (/\b(berdua|semua)\b/.test(lower) && found.length === 0) {
    return wCtx.productionWorkers.map((w) => w.name);
  }

  return found.length > 0 ? found : undefined;
}

// ===== Parser Khusus Pengaturan / Master Data =====

/**
 * Urai update harga bahan: "harga creamer sekarang 55rb per kilo" / "gula 18rb/kg"
 */
export function parseIngredientPriceUpdate(text: string): IngredientPriceUpdateInput | null {
  const lower = text.trim().toLowerCase();
  // Pola: (harga)? [bahan] (sekarang)? [nominal] (per|/)? [qty]? [satuan]
  const m = lower.match(
    /(?:harga\s+)?([a-z\s]+?)\s+(?:sekarang\s+|jadi\s+)?([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)\s*(?:per|\/)\s*([\d.,]+)?\s*([a-z]+)/i,
  );
  if (!m || !m[1] || !m[2] || !m[4]) return null;

  const rawName = m[1].trim();
  const canonicalName = matchIngredientName(rawName);
  if (!canonicalName) return null;

  const totalRp = parseRupiah(m[2]);
  if (totalRp === null || totalRp <= 0) return null;

  const qtyUnit = m[3] ? parseFloat(m[3].replace(",", ".")) : 1;
  if (Number.isNaN(qtyUnit) || qtyUnit <= 0) return null;

  const unitStr = m[4].trim();
  let divisor = qtyUnit;

  // Normalisasi ke satuan kanonik (g / ml / pcs)
  if (/^k(?:g|ilo|ilogram)?$/.test(unitStr)) {
    divisor = qtyUnit * 1000; // per kg -> per gram
  } else if (/^l(?:iter)?$/.test(unitStr)) {
    divisor = qtyUnit * 1000; // per liter -> per ml
  } else if (/^g(?:ram)?$/.test(unitStr)) {
    divisor = qtyUnit;
  } else if (/^ml$/.test(unitStr)) {
    divisor = qtyUnit;
  } else if (/^(?:pcs|biji|lembar|bungkus|pack)$/.test(unitStr)) {
    divisor = qtyUnit;
  }

  const pricePerUnit = totalRp / divisor;
  return {
    name: canonicalName,
    price_per_unit_rp: Math.round(pricePerUnit * 10000) / 10000,
    raw_text: `${m[2]} per ${m[3] ? m[3] + " " : ""}${unitStr}`,
  };
}

/**
 * Urai update biaya tetap bulanan: "biaya tetap bulan ini 65rb" / "biaya tetap 2026-08 60rb"
 */
export function parseMonthlyFixedCost(text: string): MonthlyFixedCostInput | null {
  const lower = text.trim().toLowerCase();
  const m = lower.match(
    /(?:biaya\s+tetap|biaya\s+listrik(?:\s+dan|\s*\+\s*|\s+)?gas)\s+(?:(?:bulan\s+ini|untuk\s+bulan\s+ini)\s+|(\d{4}-\d{2})\s+)?(?:jadi\s+)?([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)/i,
  );
  if (!m || !m[2]) return null;

  const month = m[1] ?? currentMonthJakarta();
  const amount = parseRupiah(m[2]);
  if (amount === null || amount < 0) return null;

  return {
    effective_month: month,
    amount_rp: amount,
    note: "Biaya tetap bulanan (listrik freezer + gas)",
  };
}

/**
 * Urai perubahan default output per resep: "ganti default pcs per resep jadi 88" / "default pcs per resep 88"
 */
export function parseDefaultPieces(text: string): DefaultPiecesInput | null {
  const lower = text.trim().toLowerCase();
  const m = lower.match(
    /(?:ganti\s+)?default\s+(?:pcs|biji|output|hasil)?\s*(?:per\s+resep\s+)?(?:jadi\s+)?(\d+)/i,
  );
  if (!m || !m[1]) return null;

  const pcs = parseInt(m[1], 10);
  if (Number.isNaN(pcs) || pcs <= 0 || pcs > 200) return null;
  return { pieces_per_recipe: pcs };
}

/**
 * Urai tambah/ubah pekerja: "tambah karyawan baru bibi, produksi, per pcs 150"
 */
export function parseWorkerSetting(text: string): WorkerSettingInput | null {
  const lower = text.trim().toLowerCase();
  const m = lower.match(
    /(?:tambah\s+(?:karyawan|pekerja)(?:\s+baru)?|gaji|rate)\s+([a-z0-9_]+)(?:,\s*|\s+)(produksi|antar)?(?:,\s*|\s+)?(?:per\s+)?(resep|pcs|hari)\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)/i,
  );
  if (!m || !m[1] || !m[3] || !m[4]) return null;

  const name = m[1].trim();
  const role = m[2] === "antar" ? "antar" : "produksi";
  const rateTypeRaw = m[3].trim();
  const rateType = rateTypeRaw === "pcs" ? "per_pcs" : rateTypeRaw === "hari" ? "per_hari" : "per_resep";
  const rateRp = parseRupiah(m[4]);
  if (rateRp === null || rateRp < 0) return null;

  return {
    name,
    role,
    rate_type: rateType,
    rate_rp: rateRp,
    status: "aktif",
  };
}

/**
 * Urai aktivasi status pekerja: "ayah mulai digaji" / "mulai gaji ayah"
 */
export function parseWorkerStatusActivation(text: string): { name: string; status: "aktif" | "rencana_belum_final" } | null {
  const lower = text.trim().toLowerCase();
  const m = lower.match(
    /(?:mulai\s+gaji\s+([a-z0-9_]+)|([a-z0-9_]+)\s+mulai\s+digaji)/i,
  );
  if (!m) return null;
  const name = (m[1] || m[2])?.trim().toLowerCase();
  if (!name) return null;
  return { name, status: "aktif" };
}

// ===== Regex per Operasi Transaksi =====

const SEGMENT_SPLIT = /(?:\r?\n|,|;|\bterus\b|\bkemudian\b|\blalu\b|\bhabis itu\b)/i;

export function parseWithRegex(text: string, ctx: LocationCtx, wCtx?: WorkerCtx): RawBatch | null {
  const raw = text.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const date = resolveRelativeDate(lower) ?? todayJakarta();
  const warehouse = defaultWarehouse(ctx);

  // ----- PRODUKSI: "produksi 4 resep [hasil 340] [sama adek]" -----
  const prod = lower.match(/(?:produksi|buat|bikin)\s+(\d+)\s*resep/);
  if (prod && prod[1]) {
    const recipes = parseInt(prod[1], 10);
    
    // Cek apakah ada yield kustom: "hasil 340", "340 biji", "340 pcs", "@85"
    let piecesPerRecipe: number | undefined;
    const yieldTotal = lower.match(/(?:hasil|dapat|jadi)\s+(\d+)(?:\s*(?:biji|pcs|buah))?/);
    const yieldPerResep = lower.match(/@\s*(\d+)(?:\s*(?:biji|pcs))?/);

    if (yieldPerResep && yieldPerResep[1]) {
      piecesPerRecipe = parseInt(yieldPerResep[1], 10);
    } else if (yieldTotal && yieldTotal[1]) {
      const totalPieces = parseInt(yieldTotal[1], 10);
      if (recipes > 0) {
        piecesPerRecipe = Math.round(totalPieces / recipes);
      }
    }

    const assignedWorkers = parseWorkersFromText(lower, wCtx);

    return {
      entity: "production",
      rows: [
        {
          prod_date: date,
          recipes,
          pieces_per_recipe: piecesPerRecipe,
          workers: assignedWorkers,
        },
      ],
    };
  }

  // ----- MUTASI bentuk eksplisit: "kirim rumah->mts1 100" / "lempar mts2 ke sma 15" -----
  const move = lower.match(
    /(?:kirim|lempar|pindah)\s+([a-z0-9 ]+?)\s*(?:->|ke|>)\s*([a-z0-9 ]+?)\s+(\d+)\b/,
  );
  if (move && move[1] && move[2] && move[3]) {
    const from = normalizeLoc(move[1], ctx);
    const to = normalizeLoc(move[2], ctx);
    if (from && to) {
      return {
        entity: "stock_movement",
        rows: [
          { move_date: date, from_loc: from, to_loc: to, qty: parseInt(move[3], 10) },
        ],
      };
    }
  }

  // ----- MUTASI "kirim 100 ke mts1" -----
  const moveTo = lower.match(/(?:kirim|lempar|pindah)\s+(\d+)\s+ke\s+([a-z0-9 ]+)\b/);
  if (moveTo && moveTo[1] && moveTo[2] && warehouse) {
    const to = normalizeLoc(moveTo[2], ctx);
    if (to && to !== warehouse) {
      return {
        entity: "stock_movement",
        rows: [
          { move_date: date, from_loc: warehouse, to_loc: to, qty: parseInt(moveTo[1], 10) },
        ],
      };
    }
  }

  // ----- MUTASI "mts1 kirim 100" -----
  const locFirst = lower.match(/^([a-z0-9 ]+?)\s+(?:kirim|dikirim|lempar|dilempar)\s+(\d+)\b/);
  if (locFirst && locFirst[1] && locFirst[2] && warehouse) {
    const to = normalizeLoc(locFirst[1], ctx);
    if (to && to !== warehouse) {
      return {
        entity: "stock_movement",
        rows: [
          { move_date: date, from_loc: warehouse, to_loc: to, qty: parseInt(locFirst[2], 10) },
        ],
      };
    }
  }

  // ----- KAS MASUK: "uang mts1 90rb" / "terima smk 45000" -----
  const cashIn = lower.match(/(?:uang|terima|bayar(?:an)?)\s+([a-z0-9 ]+?)\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)\b/);
  if (cashIn && cashIn[1] && cashIn[2]) {
    const canteen = normalizeLoc(cashIn[1], ctx);
    const amount = parseRupiah(cashIn[2]);
    if (canteen && ctx.canteenSet.has(canteen) && amount !== null) {
      return {
        entity: "cash_in",
        rows: [
          { received_date: date, canteen, amount_rp: amount, method: "cash" },
        ],
      };
    }
  }

  // ----- GAJI AYAH (Pengeluaran usaha): "gaji ayah 50rb" / "bayar gaji ayah 100rb" -----
  const gajiAyah = lower.match(/(?:bayar\s+)?gaji\s+ayah\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)/);
  if (gajiAyah && gajiAyah[1]) {
    const amount = parseRupiah(gajiAyah[1]);
    if (amount !== null) {
      return {
        entity: "cash_out",
        rows: [
          {
            out_date: date,
            kind: "pengeluaran",
            category: "gaji_ayah",
            amount_rp: amount,
            note: "gaji ayah (antar)",
          },
        ],
      };
    }
  }

  // ----- PENGAMBILAN: "ambil ayah 31500 spp" / "ambil 50rb" -----
  const ambil = lower.match(/ambil(?:\s+ayah)?\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)/);
  if (ambil && ambil[1]) {
    const amount = parseRupiah(ambil[1]);
    if (amount !== null) {
      const isSpp = /\bayah\b|\bspp\b/.test(lower);
      return {
        entity: "cash_out",
        rows: [
          {
            out_date: date,
            kind: "pengambilan",
            category: isSpp ? "spp_ayah" : "lainnya",
            amount_rp: amount,
            note: isSpp ? "diambil ayah (SPP)" : "pengambilan",
          },
        ],
      };
    }
  }

  // ----- PENGELUARAN: "beli bahan 20rb" / "bayar gas 50rb" -----
  const beli = lower.match(/(?:beli|bayar|keluar)\s+([a-z]+)\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)/);
  if (beli && beli[1] && beli[2]) {
    const category = EXPENSE_KEYWORDS[beli[1]] ?? "lainnya";
    const amount = parseRupiah(beli[2]);
    if (amount !== null) {
      return {
        entity: "cash_out",
        rows: [
          {
            out_date: date,
            kind: "pengeluaran",
            category,
            amount_rp: amount,
            note: beli[1],
          },
        ],
      };
    }
  }

  // ----- PENJUALAN: "jual sma 50 @1300" / "jual mts1 100" -----
  const jual = lower.match(
    /jual\s+([a-z0-9 ]+?)\s+(?:batch\s+)?(\d+)(?:\s*@\s*([\d.,]+))?/,
  );
  if (jual && jual[1] && jual[2]) {
    const canteen = normalizeLoc(jual[1], ctx);
    if (canteen && ctx.canteenSet.has(canteen)) {
      const qty = parseInt(jual[2], 10);
      const price =
        jual[3] !== undefined
          ? parseRupiah(jual[3])
          : ctx.defaultPrice.get(canteen) ?? null;
      if (price !== null) {
        const isBatch = ctx.batch50Set.has(canteen);
        return {
          entity: "sale",
          rows: [
            {
              sale_date: date,
              canteen,
              qty,
              price_rp: price,
              note: isBatch ? "batch 50" : undefined,
            },
          ],
        };
      }
    }
  }

  return null;
}

export function parseMultiWithRegex(text: string, ctx: LocationCtx, wCtx?: WorkerCtx): RawBatch[] | null {
  const segments = text
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const batches: RawBatch[] = [];
  for (const seg of segments) {
    const b = parseWithRegex(seg, ctx, wCtx);
    if (!b) return null;
    batches.push(b);
  }
  return batches;
}

// ===== Fallback Gemini AI =====

function buildSystemPrompt(ctx: LocationCtx, wCtx?: WorkerCtx): string {
  const canteens = [...ctx.canteenSet].sort();
  const warehouses = [...ctx.warehouseSet].sort();
  const allLocs = [...ctx.locationSet].sort();
  const batch50 = [...ctx.batch50Set].sort();
  const priceLines = canteens
    .map((c) => `${c}=${ctx.defaultPrice.get(c) ?? "?"}`)
    .join(", ");
  const warehouseLine =
    warehouses.length > 0 ? warehouses.join("/") : "(belum ada gudang)";

  const workerNames = wCtx ? wCtx.workers.map((w) => w.name).join(", ") : "adek, diri_sendiri, ayah, bibi";

  return `Kamu pengurai catatan usaha es lilin. Ubah pesan bahasa Indonesia menjadi JSON.
Satu pesan bisa berisi BEBERAPA operasi. Bentuk WAJIB:
{"ops": [ {"entity": "...", "rows": [ {...} ]} ]}
entity salah satu: production | stock_movement | sale | cash_in | cash_out.
Kolom per entity:
- production: prod_date(YYYY-MM-DD), recipes(int), pieces_per_recipe?(int), workers?(array of string), note?
  workers: daftar nama yang ikut produksi (opsi: ${workerNames}). Default bila tak disebut = semua pekerja produksi aktif.
  pieces_per_recipe: hasil per resep (misal total 340 pcs dari 4 resep -> 85 pcs/resep).
- stock_movement: move_date, from_loc, to_loc, qty(int), note? (perpindahan es, BUKAN penjualan)
- sale: sale_date, canteen, qty(int), price_rp(int rupiah), note?
- cash_in: received_date, canteen, amount_rp(int), method(cash|transfer), note?
- cash_out: out_date, kind(pengeluaran|pengambilan), category(bahan|gas_listrik|plastik|transport|spp_ayah|gaji_ayah|lainnya), amount_rp(int), note?
Lokasi valid: ${allLocs.join(", ")}. canteen HANYA boleh salah satu kantin: ${canteens.join(", ")}.
Gudang: ${warehouseLine}.
Harga default per biji: ${priceLines || "(belum diset)"}.
Kantin batch 50: ${batch50.length ? batch50.join(", ") : "(tidak ada)"}.
"ambil ayah"/"pengambilan" = cash_out kind=pengambilan category=spp_ayah.
"gaji ayah" = cash_out kind=pengeluaran category=gaji_ayah.
Tanggal: "tanggal 14"/"kemarin" -> normalisasi ke YYYY-MM-DD.
Uang berupa integer rupiah tanpa desimal (20rb=20000).
ATURAN PENTING: JANGAN PERNAH mengarang atau menebak angka.
Jawab HANYA JSON, tanpa penjelasan.`;
}

export async function parseWithGemini(
  text: string,
  ctx: LocationCtx,
  wCtx?: WorkerCtx,
): Promise<RawBatch[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum diset");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    systemInstruction: buildSystemPrompt(ctx, wCtx),
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  });

  const prompt = `Hari ini ${todayJakarta()} (Asia/Jakarta). Pesan: """${text}"""`;
  const result = await model.generateContent(prompt);
  const out = result.response.text().trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error("output AI bukan JSON valid");
  }

  const opsRaw: unknown[] =
    typeof parsed === "object" && parsed !== null && "ops" in parsed && Array.isArray((parsed as { ops: unknown }).ops)
      ? ((parsed as { ops: unknown[] }).ops)
      : typeof parsed === "object" && parsed !== null && "entity" in parsed
        ? [parsed]
        : [];

  const batches: RawBatch[] = [];
  for (const op of opsRaw) {
    if (typeof op !== "object" || op === null || !("entity" in op) || !("rows" in op)) continue;
    const o = op as { entity: unknown; rows: unknown };
    const rows = Array.isArray(o.rows) ? o.rows : [];
    if (rows.length === 0) continue;
    batches.push({ entity: o.entity as Entity, rows: rows as Record<string, unknown>[] });
  }
  if (batches.length === 0) {
    throw new Error("AI tidak menemukan operasi yang bisa dipakai");
  }
  return batches;
}

export async function parseMessage(
  text: string,
  ctx: LocationCtx,
  wCtx?: WorkerCtx,
): Promise<RawBatch[]> {
  const byRegex = parseMultiWithRegex(text, ctx, wCtx);
  if (byRegex) return byRegex;
  return parseWithGemini(text, ctx, wCtx);
}
