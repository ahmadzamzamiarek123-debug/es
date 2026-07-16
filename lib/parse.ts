// Parser input bot: REGEX/COMMAND DULU (hemat kuota Gemini), Gemini hanya
// fallback untuk kalimat bebas. Output selalu bentuk longgar { entity, rows }
// yang HARUS divalidasi oleh lib/validate.ts sebelum dipakai.
//
// Mendukung MULTI-OPERASI: satu pesan bisa berisi beberapa operasi dipisah
// koma / baris baru / "terus" / "kemudian" / "lalu". Bila SEMUA potongan
// terurai regex → hasil regex dipakai; bila ada yang gagal → SELURUH pesan
// dilempar ke Gemini (hindari dobel hitung antara regex & AI).
//
// Prinsip: parser tidak menyentuh DB & tidak memutuskan simpan.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { todayJakarta, resolveRelativeDate } from "./dates";
import {
  CANTEENS,
  LOCATIONS,
  isBatch50Canteen,
  type Entity,
} from "./validate";

// Bentuk longgar hasil parse (belum tervalidasi).
export interface RawBatch {
  entity: Entity;
  rows: Record<string, unknown>[];
}

// Harga jual default per kantin (rupiah/biji). Bukan hardcode transaksi —
// hanya dipakai bila user tak menyebut harga; nilai final tetap disimpan
// per baris di price_rp. (PROJECT.md §2: SMA=800, lainnya=900.)
const DEFAULT_PRICE: Record<string, number> = {
  mts1: 900,
  mts2: 900,
  smp: 900,
  sma: 800,
  smk: 900,
};

// Alias lokasi yang mungkin diketik user → enum kanonik.
const LOC_ALIAS: Record<string, string> = {
  rumah: "rumah",
  gudang: "rumah",
  mts1: "mts1",
  "mts 1": "mts1",
  mts2: "mts2",
  "mts 2": "mts2",
  smp: "smp",
  sma: "sma",
  smk: "smk",
};

function normalizeLoc(s: string): string | null {
  const key = s.trim().toLowerCase();
  if (LOC_ALIAS[key]) return LOC_ALIAS[key];
  if ((LOCATIONS as readonly string[]).includes(key)) return key;
  return null;
}

/**
 * Ubah teks nominal rupiah jadi integer.
 * Mendukung: "20rb", "20 ribu", "1.5jt", "31500", "Rp90.000".
 * Mengembalikan null bila tak bisa diyakini sebagai angka.
 */
export function parseRupiah(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/rp/g, "").trim();
  // Untuk bentuk berpengali (jt/rb), "." dan "," sama-sama pemisah DESIMAL
  // ("1,5jt" = "1.5 juta" = 1.500.000). Jadi keduanya dinormalkan jadi titik.
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

// Kategori pengeluaran yang dikenali dari kata kunci.
const EXPENSE_KEYWORDS: Record<string, string> = {
  bahan: "bahan",
  gula: "bahan",
  santan: "bahan",
  gas: "gas_listrik",
  listrik: "gas_listrik",
  plastik: "plastik",
  transport: "transport",
  bensin: "transport",
  ongkos: "transport",
};

// ===== Deteksi pertanyaan (jalur BACA, bukan input) =====

const QUESTION_HINTS =
  /(\bberapa\b|\bcek\b|\bstok\b|\blaporan\b|\bringkasan\b|\btotal\b|\briwayat\b|\btransaksi terakhir\b|\?)/;
const INPUT_HINTS =
  /(\bproduksi\b|\bbuat\b|\bbikin\b|\bkirim\b|\blempar\b|\bpindah\b|\bjual\b|\buang\b|\bterima\b|\bbeli\b|\bbayar\b|\bambil\b)/;

/**
 * Apakah pesan ini PERTANYAAN laporan (bukan input transaksi)?
 * "cek stok" / "kemarin mts1 kirim berapa?" → true.
 * "kirim 100 ke mts1" → false (ada angka aksi, tanpa kata tanya).
 */
export function isQuestion(text: string): boolean {
  const t = text.toLowerCase();
  if (!QUESTION_HINTS.test(t)) return false;
  // "jual mts1 100" mengandung kata input + angka → input, bukan tanya.
  // Tapi "kemarin mts1 kirim berapa" ada kata input NAMUN ada "berapa".
  if (/\bberapa\b|\?/.test(t)) return true;
  // "cek stok", "laporan hari ini", "ringkasan" tanpa kata input → tanya.
  return !INPUT_HINTS.test(t);
}

// ===== Regex per operasi =====

// Pemisah antar operasi dalam satu pesan.
const SEGMENT_SPLIT = /(?:\r?\n|,|;|\bterus\b|\bkemudian\b|\blalu\b|\bhabis itu\b)/i;

/**
 * Deteksi worker produksi dari teks potongan.
 * "sendiri"/"zummy" → zummy; "aril" → aril; "sama aril"/"berdua" → berdua.
 */
function parseWorker(seg: string): string {
  if (/\b(sama|dengan|bareng|berdua)\b/.test(seg) || /\bzummy\b.*\baril\b|\baril\b.*\bzummy\b/.test(seg)) {
    return "berdua";
  }
  if (/\baril\b/.test(seg)) return "aril";
  if (/\b(sendiri|zummy)\b/.test(seg)) return "zummy";
  return "berdua"; // default: dikerjakan berdua
}

/**
 * Coba parse SATU potongan operasi dengan regex (tanpa AI).
 * Mengembalikan RawBatch bila salah satu pola cocok, atau null.
 */
export function parseWithRegex(text: string): RawBatch | null {
  const raw = text.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Tanggal default hari ini (Asia/Jakarta), atau "kemarin"/"lusa" bila disebut.
  const date = resolveRelativeDate(lower) ?? todayJakarta();

  // ----- PRODUKSI: "produksi 6 resep [sendiri|sama aril]" -----
  const prod = lower.match(/(?:produksi|buat|bikin)\s+(\d+)\s*resep/);
  if (prod && prod[1]) {
    return {
      entity: "production",
      rows: [
        {
          prod_date: date,
          recipes: parseInt(prod[1], 10),
          worker: parseWorker(lower),
        },
      ],
    };
  }

  // ----- MUTASI bentuk eksplisit: "kirim rumah->mts1 100" / "lempar mts2 ke sma 15" -----
  const move = lower.match(
    /(?:kirim|lempar|pindah)\s+([a-z0-9 ]+?)\s*(?:->|ke|>)\s*([a-z0-9 ]+?)\s+(\d+)\b/,
  );
  if (move && move[1] && move[2] && move[3]) {
    const from = normalizeLoc(move[1]);
    const to = normalizeLoc(move[2]);
    if (from && to) {
      return {
        entity: "stock_movement",
        rows: [
          { move_date: date, from_loc: from, to_loc: to, qty: parseInt(move[3], 10) },
        ],
      };
    }
  }

  // ----- MUTASI "kirim 100 ke mts1" (asal default rumah) -----
  const moveTo = lower.match(/(?:kirim|lempar|pindah)\s+(\d+)\s+ke\s+([a-z0-9 ]+)\b/);
  if (moveTo && moveTo[1] && moveTo[2]) {
    const to = normalizeLoc(moveTo[2]);
    if (to && to !== "rumah") {
      return {
        entity: "stock_movement",
        rows: [
          // ASUMSI: tanpa asal disebut, kiriman berangkat dari rumah (gudang).
          { move_date: date, from_loc: "rumah", to_loc: to, qty: parseInt(moveTo[1], 10) },
        ],
      };
    }
  }

  // ----- MUTASI "mts1 kirim 100" (tujuan di depan; asal default rumah) -----
  const locFirst = lower.match(/^([a-z0-9 ]+?)\s+(?:kirim|dikirim|lempar|dilempar)\s+(\d+)\b/);
  if (locFirst && locFirst[1] && locFirst[2]) {
    const to = normalizeLoc(locFirst[1]);
    if (to && to !== "rumah") {
      return {
        entity: "stock_movement",
        rows: [
          // ASUMSI: "mts1 kirim 100" = 100 biji dikirim KE mts1 dari rumah.
          { move_date: date, from_loc: "rumah", to_loc: to, qty: parseInt(locFirst[2], 10) },
        ],
      };
    }
  }

  // ----- KAS MASUK: "uang mts1 90rb" / "terima smk 45000" -----
  const cashIn = lower.match(/(?:uang|terima|bayar(?:an)?)\s+([a-z0-9 ]+?)\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)\b/);
  if (cashIn && cashIn[1] && cashIn[2]) {
    const canteen = normalizeLoc(cashIn[1]);
    const amount = parseRupiah(cashIn[2]);
    if (canteen && canteen !== "rumah" && amount !== null) {
      return {
        entity: "cash_in",
        rows: [
          { received_date: date, canteen, amount_rp: amount, method: "cash" },
        ],
      };
    }
  }

  // ----- PENGAMBILAN: "ambil ayah 31500 spp" / "ambil 50rb" -----
  // Pengambilan = owner draw MANUAL (tidak lagi otomatis terkait MTS2).
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

  // ----- PENJUALAN: "jual sma 50 @800" / "jual mts1 100" / "jual smk batch 50" -----
  const jual = lower.match(
    /jual\s+([a-z0-9 ]+?)\s+(?:batch\s+)?(\d+)(?:\s*@\s*([\d.,]+))?/,
  );
  if (jual && jual[1] && jual[2]) {
    const canteen = normalizeLoc(jual[1]);
    if (canteen && canteen !== "rumah") {
      const qty = parseInt(jual[2], 10);
      const price =
        jual[3] !== undefined
          ? parseRupiah(jual[3])
          : DEFAULT_PRICE[canteen] ?? null;
      if (price !== null) {
        const isBatch = isBatch50Canteen(canteen);
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

/**
 * Parse pesan MULTI-OPERASI dengan regex saja.
 * Pesan dipecah per pemisah; SEMUA potongan harus terurai — kalau ada satu
 * yang gagal, kembalikan null (pemanggil fallback ke Gemini untuk seluruh
 * pesan, supaya tidak dobel hitung).
 */
export function parseMultiWithRegex(text: string): RawBatch[] | null {
  const segments = text
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const batches: RawBatch[] = [];
  for (const seg of segments) {
    const b = parseWithRegex(seg);
    if (!b) return null; // ada potongan tak terurai → serahkan ke Gemini
    batches.push(b);
  }
  return batches;
}

// ===== Fallback Gemini untuk kalimat bebas =====

// Kontrak JSON multi-operasi. Output tetap divalidasi zod setelahnya.
const SYSTEM_PROMPT = `Kamu pengurai catatan usaha es lilin. Ubah pesan bahasa Indonesia menjadi JSON.
Satu pesan bisa berisi BEBERAPA operasi. Bentuk WAJIB:
{"ops": [ {"entity": "...", "rows": [ {...} ]} ]}
entity salah satu: production | stock_movement | sale | cash_in | cash_out.
Kolom per entity:
- production: prod_date(YYYY-MM-DD), recipes(int), worker(berdua|zummy|aril), note?
  worker: yang mengerjakan produksi. "sendiri"=zummy, "aril"=aril, default berdua.
- stock_movement: move_date, from_loc, to_loc, qty(int), note?   (perpindahan es, BUKAN penjualan)
- sale: sale_date, canteen, qty(int), price_rp(int rupiah), note?
- cash_in: received_date, canteen, amount_rp(int), method(cash|transfer), note?
- cash_out: out_date, kind(pengeluaran|pengambilan), category(bahan|gas_listrik|plastik|transport|spp_ayah|lainnya), amount_rp(int), note?
Lokasi valid: rumah, mts1, mts2, smp, sma, smk. canteen tidak boleh 'rumah'.
"X kirim 100" atau "kirim 100 ke X" = stock_movement dari rumah ke X.
Harga default per biji: sma=800, lainnya=900 (pakai bila tak disebut).
SMA & SMK memakai batch 50: qty penjualan kelipatan 50.
"ambil ayah"/"pengambilan" = cash_out kind=pengambilan (category spp_ayah bila terkait ayah/SPP).
Uang berupa integer rupiah tanpa desimal (20rb=20000, 1,5jt=1500000).
Jika informasi kurang untuk mengisi kolom wajib, JANGAN mengarang nominal — lewati operasi itu. Jawab HANYA JSON, tanpa penjelasan.`;

/**
 * Fallback ke Gemini: seluruh pesan → daftar operasi.
 * Melempar error bila API key tak ada atau output tak bisa dipakai.
 */
export async function parseWithGemini(text: string): Promise<RawBatch[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum diset");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  });

  // Beri konteks tanggal hari ini agar Gemini bisa hitung "kemarin" dsb.
  const prompt = `Hari ini ${todayJakarta()} (Asia/Jakarta). Pesan: """${text}"""`;
  const result = await model.generateContent(prompt);
  const out = result.response.text().trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error("output AI bukan JSON valid");
  }

  // Terima {"ops":[...]} (kontrak baru) maupun {entity,rows} tunggal (jaga-jaga).
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

/**
 * Titik masuk utama: multi-op regex dulu, baru Gemini untuk seluruh pesan.
 * Selalu mengembalikan daftar RawBatch (belum tervalidasi).
 */
export async function parseMessage(text: string): Promise<RawBatch[]> {
  const byRegex = parseMultiWithRegex(text);
  if (byRegex) return byRegex;
  return parseWithGemini(text);
}

export { DEFAULT_PRICE, CANTEENS };
