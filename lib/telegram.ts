// Bot Telegram (grammY, mode WEBHOOK — tidak ada polling/bot.start()).
//
// Alur: teks masuk → parse (regex→Gemini) → validasi zod → tampilkan ringkasan
// + inline keyboard [✅ Simpan][✏️ Ubah][❌ Batal]. TIDAK ada auto-insert:
// insert hanya terjadi setelah user menekan Simpan.
//
// State konfirmasi bersifat STATELESS agar aman di serverless: batch yang sudah
// tervalidasi di-encode ringkas ke dalam callback_data tombol Simpan. Saat
// ditekan, payload di-decode lalu DIVALIDASI ULANG (defense in depth) sebelum
// insert. Jadi tidak butuh memori proses / tabel state tambahan.
//
// Keamanan (verifikasi secret header + whitelist from.id) dilakukan di route
// SEBELUM memanggil modul ini — lihat app/api/telegram/route.ts.

import { Bot, InlineKeyboard, type Context } from "grammy";
import { parseMessage } from "./parse";
import { validateBatch, type ParsedBatch, type Entity } from "./validate";
import { insertBatch } from "./insert";
import { formatRupiah } from "./format";

// ===== Codec ringkas ParsedBatch <-> string (untuk callback_data) =====
// Telegram membatasi callback_data 1–64 byte. JSON terlalu boros, jadi kita
// pakai format terpisah pipa. Bila hasil > 64 byte, batch dianggap terlalu
// besar untuk satu konfirmasi (minta user pisah). Tanggal disimpan tanpa strip
// ("20260714") agar hemat.

const ENTITY_CODE: Record<Entity, string> = {
  production: "p",
  stock_movement: "m",
  sale: "s",
  cash_in: "i",
  cash_out: "o",
};
const CODE_ENTITY: Record<string, Entity> = {
  p: "production",
  m: "stock_movement",
  s: "sale",
  i: "cash_in",
  o: "cash_out",
};

const packDate = (d: string) => d.replace(/-/g, "");
const unpackDate = (d: string) =>
  `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/**
 * Encode batch tervalidasi ke string ringkas. Note SENGAJA tidak diikutkan di
 * callback_data (bisa panjang & tak kritikal); note default akan diterapkan
 * ulang saat decode berdasarkan aturan domain. Mengembalikan null bila hasil
 * melebihi 64 byte.
 */
export function encodeBatch(batch: ParsedBatch): string | null {
  const code = ENTITY_CODE[batch.entity];
  const rows = batch.rows.map((r) => {
    switch (batch.entity) {
      case "production":
        return `${packDate((r as any).prod_date)}~${(r as any).recipes}`;
      case "stock_movement":
        return `${packDate((r as any).move_date)}~${(r as any).from_loc}~${(r as any).to_loc}~${(r as any).qty}`;
      case "sale":
        return `${packDate((r as any).sale_date)}~${(r as any).canteen}~${(r as any).qty}~${(r as any).price_rp}`;
      case "cash_in":
        return `${packDate((r as any).received_date)}~${(r as any).canteen}~${(r as any).amount_rp}~${(r as any).method}`;
      case "cash_out":
        return `${packDate((r as any).out_date)}~${(r as any).kind}~${(r as any).category}~${(r as any).amount_rp}`;
    }
  });
  const payload = `s|${code}|${rows.join(";")}`;
  // Ukur dalam byte (callback_data dibatasi byte, bukan char).
  if (Buffer.byteLength(payload, "utf8") > 64) return null;
  return payload;
}

/**
 * Decode kembali menjadi bentuk longgar { entity, rows } untuk divalidasi ulang.
 * Melempar bila format tak dikenali.
 */
export function decodeBatch(data: string): {
  entity: Entity;
  rows: Record<string, unknown>[];
} {
  const parts = data.split("|");
  if (parts[0] !== "s") throw new Error("payload bukan aksi simpan");
  const code = parts[1] ?? "";
  const entity = CODE_ENTITY[code];
  if (!entity) throw new Error("entity tak dikenali");
  const rowStrs = parts[2] ? parts[2].split(";") : [];
  const rows = rowStrs.map((rs) => {
    // f[i] bisa undefined (noUncheckedIndexedAccess) — beri default aman.
    // Semua nilai di sini divalidasi ulang oleh zod, jadi nilai janggal
    // (mis. NaN) tetap akan ditolak sebelum insert.
    const f = rs.split("~");
    const g = (i: number): string => f[i] ?? "";
    switch (entity) {
      case "production":
        return { prod_date: unpackDate(g(0)), recipes: Number(g(1)) };
      case "stock_movement":
        return {
          move_date: unpackDate(g(0)),
          from_loc: g(1),
          to_loc: g(2),
          qty: Number(g(3)),
        };
      case "sale":
        return {
          sale_date: unpackDate(g(0)),
          canteen: g(1),
          qty: Number(g(2)),
          price_rp: Number(g(3)),
        };
      case "cash_in":
        return {
          received_date: unpackDate(g(0)),
          canteen: g(1),
          amount_rp: Number(g(2)),
          method: g(3),
        };
      case "cash_out":
        return {
          out_date: unpackDate(g(0)),
          kind: g(1),
          category: g(2),
          amount_rp: Number(g(3)),
        };
    }
  });
  return { entity, rows: rows as Record<string, unknown>[] };
}

// ===== Ringkasan manusiawi untuk konfirmasi =====
const LOC_LABEL: Record<string, string> = {
  rumah: "Rumah",
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
  sma: "SMA",
  smk: "SMK",
};

function summarize(batch: ParsedBatch): string {
  const lines = batch.rows.map((r) => {
    switch (batch.entity) {
      case "production": {
        const x = r as any;
        return `• Produksi ${x.recipes} resep (${x.recipes * 40} biji, upah ${formatRupiah(x.recipes * 6000)}) · ${x.prod_date}`;
      }
      case "stock_movement": {
        const x = r as any;
        return `• Mutasi ${LOC_LABEL[x.from_loc]} → ${LOC_LABEL[x.to_loc]}: ${x.qty} biji · ${x.move_date} (tidak menambah penjualan)`;
      }
      case "sale": {
        const x = r as any;
        return `• Jual ${LOC_LABEL[x.canteen]}: ${x.qty} × ${formatRupiah(x.price_rp)} = ${formatRupiah(x.qty * x.price_rp)} · ${x.sale_date}`;
      }
      case "cash_in": {
        const x = r as any;
        return `• Kas masuk ${LOC_LABEL[x.canteen]}: ${formatRupiah(x.amount_rp)} (${x.method}) · ${x.received_date}`;
      }
      case "cash_out": {
        const x = r as any;
        const jenis = x.kind === "pengambilan" ? "Pengambilan" : "Pengeluaran";
        return `• ${jenis} [${x.category}]: ${formatRupiah(x.amount_rp)} · ${x.out_date}`;
      }
    }
  });
  const header: Record<Entity, string> = {
    production: "🧊 Produksi",
    stock_movement: "🔁 Mutasi stok",
    sale: "💵 Penjualan",
    cash_in: "💰 Kas masuk",
    cash_out: "🧾 Kas keluar",
  };
  return `${header[batch.entity]} — konfirmasi:\n${lines.join("\n")}\n\nSimpan?`;
}

// ===== Bot & handler =====
let _bot: Bot | null = null;

/**
 * Bangun bot grammY sekali (lazy). Token diambil dari env — tidak di-hardcode.
 */
export function getBot(): Bot {
  if (_bot) return _bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diset");

  const bot = new Bot(token);

  bot.command("start", (ctx) =>
    ctx.reply(
      "Halo! Aku bot pencatat Es Lilin 🧊\n\n" +
        "Kirim catatan pakai bahasa bebas, contoh:\n" +
        "• produksi 6 resep\n" +
        "• kirim rumah->mts1 100\n" +
        "• lempar mts2->sma 15\n" +
        "• jual mts1 100\n" +
        "• jual sma batch 50\n" +
        "• uang mts1 90rb\n" +
        "• beli bahan 20rb\n" +
        "• ambil ayah 31500 spp\n\n" +
        "Aku akan minta konfirmasi sebelum menyimpan. /help untuk bantuan.",
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "Format yang dikenali:\n" +
        "Produksi: `produksi N resep`\n" +
        "Mutasi: `kirim ASAL->TUJUAN qty` (bukan penjualan)\n" +
        "Penjualan: `jual KANTIN qty` atau `jual sma 50 @800`\n" +
        "  (SMA/SMK pakai batch 50 → qty kelipatan 50)\n" +
        "Kas masuk: `uang KANTIN 90rb`\n" +
        "Pengeluaran: `beli bahan 20rb`\n" +
        "Pengambilan ayah: `ambil ayah 31500 spp`\n\n" +
        "Tanggal default hari ini; bisa sebut `kemarin`.",
      { parse_mode: "Markdown" },
    ),
  );

  // Pesan teks bebas → parse → validasi → konfirmasi.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // command sudah ditangani di atas

    let raw;
    try {
      raw = await parseMessage(text);
    } catch {
      // Jangan bocorkan error mentah; minta ulang dengan ramah.
      await ctx.reply(
        "Maaf, aku belum paham catatan itu 🙏\nCoba tulis lebih spesifik, mis. `jual mts1 100` atau `beli bahan 20rb`. Ketik /help untuk contoh.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const result = validateBatch(raw);
    if (!result.ok) {
      await ctx.reply(
        "Datanya belum bisa disimpan:\n" +
          result.errors.map((e) => `⚠️ ${e}`).join("\n") +
          "\n\nCoba perbaiki lalu kirim lagi.",
      );
      return;
    }

    const encoded = encodeBatch(result.batch);
    if (!encoded) {
      await ctx.reply(
        "Catatannya terlalu banyak untuk sekali konfirmasi. Coba pisah jadi beberapa pesan ya.",
      );
      return;
    }

    const kb = new InlineKeyboard()
      .text("✅ Simpan", encoded)
      .text("❌ Batal", "x")
      .row()
      .text("✏️ Ubah (kirim ulang)", "x");

    await ctx.reply(summarize(result.batch), { reply_markup: kb });
  });

  // Tombol konfirmasi.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "x") {
      await ctx.answerCallbackQuery({ text: "Dibatalkan" });
      await ctx.editMessageText("❌ Dibatalkan. Tidak ada yang disimpan.");
      return;
    }

    // Aksi simpan: decode → VALIDASI ULANG → insert.
    try {
      const decoded = decodeBatch(data);
      const result = validateBatch(decoded);
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: "Data tidak valid" });
        await ctx.editMessageText(
          "⚠️ Gagal menyimpan (validasi ulang tidak lolos). Coba kirim lagi.",
        );
        return;
      }
      const inserted = await insertBatch(result.batch);
      await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
      await ctx.editMessageText(
        `✅ Tersimpan (${inserted.entity}) — id: ${inserted.ids.join(", ")}`,
      );
    } catch {
      await ctx.answerCallbackQuery({ text: "Gagal menyimpan" });
      // Pesan ramah; jangan tampilkan error mentah DB.
      await ctx.editMessageText(
        "⚠️ Terjadi masalah saat menyimpan. Coba lagi sebentar.",
      );
    }
  });

  _bot = bot;
  return bot;
}

/**
 * ID Telegram yang diizinkan (pemilik). Diambil dari env ALLOWED_TELEGRAM_ID.
 */
export function getAllowedId(): number {
  const v = process.env.ALLOWED_TELEGRAM_ID;
  if (!v) throw new Error("ALLOWED_TELEGRAM_ID belum diset");
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error("ALLOWED_TELEGRAM_ID tidak valid");
  return n;
}

/**
 * Ambil from.id dari update mentah (message atau callback_query) untuk cek
 * whitelist SEBELUM memproses. Mengembalikan undefined bila tak ada.
 */
export function extractFromId(update: unknown): number | undefined {
  const u = update as {
    message?: { from?: { id?: number } };
    callback_query?: { from?: { id?: number } };
    edited_message?: { from?: { id?: number } };
  };
  return (
    u.message?.from?.id ??
    u.callback_query?.from?.id ??
    u.edited_message?.from?.id
  );
}

export type { Context };
