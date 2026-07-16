// Bot Telegram (grammY, mode WEBHOOK — tidak ada polling/bot.start()).
//
// Alur input: teks → parse multi-op (regex→Gemini) → validasi zod → ringkasan
// + tombol [✅ Simpan][❌ Batal]. TIDAK ada auto-insert: insert hanya setelah
// Simpan ditekan. Batch tervalidasi disimpan di tabel pending_confirm dan
// callback_data hanya membawa id pendek (batas Telegram 64 byte). Saat Simpan:
// payload divalidasi ULANG (defense in depth) sebelum insert.
//
// Alur lain:
//   - PERTANYAAN ("cek stok", "... berapa") → lib/ask.ts (baca saja).
//   - REVISI: `undo`, `hapus <jenis> <id>`, `ubah <jenis> <id> jadi <nilai>`
//     — selalu tampilkan data lama dulu → konfirmasi → eksekusi.
//
// Keamanan (verifikasi secret header + whitelist from.id) dilakukan di route
// SEBELUM memanggil modul ini — lihat app/api/telegram/route.ts.

import { Bot, InlineKeyboard, type Context } from "grammy";
import { parseMessage, isQuestion } from "./parse";
import { validateBatches, type ParsedBatch, type Entity } from "./validate";
import {
  insertBatches,
  getSnapshot,
  getLastInserted,
  deleteRow,
  updateMainValue,
  ENTITY_LABEL,
} from "./insert";
import { savePending, takePending, discardPending } from "./pending";
import { answerQuestion } from "./ask";
import { formatRupiah } from "./format";

// ===== Ringkasan manusiawi untuk konfirmasi =====
const LOC_LABEL: Record<string, string> = {
  rumah: "Rumah",
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
  sma: "SMA",
  smk: "SMK",
};

const WORKER_LABEL: Record<string, string> = {
  berdua: "Zummy & Aril",
  zummy: "Zummy",
  aril: "Aril",
};

function summarizeBatch(batch: ParsedBatch): string[] {
  return batch.rows.map((r) => {
    switch (batch.entity) {
      case "production": {
        const x = r as { recipes: number; worker: string; prod_date: string };
        const wage = x.worker === "berdua" ? x.recipes * 6000 : x.recipes * 3000;
        return `🧊 Produksi ${x.recipes} resep (${x.recipes * 40} biji) oleh ${WORKER_LABEL[x.worker] ?? x.worker}, upah ${formatRupiah(wage)} · ${x.prod_date}`;
      }
      case "stock_movement": {
        const x = r as { from_loc: string; to_loc: string; qty: number; move_date: string };
        return `🔁 Mutasi ${LOC_LABEL[x.from_loc]} → ${LOC_LABEL[x.to_loc]}: ${x.qty} biji · ${x.move_date}`;
      }
      case "sale": {
        const x = r as { canteen: string; qty: number; price_rp: number; sale_date: string };
        return `💵 Jual ${LOC_LABEL[x.canteen]}: ${x.qty} × ${formatRupiah(x.price_rp)} = ${formatRupiah(x.qty * x.price_rp)} · ${x.sale_date}`;
      }
      case "cash_in": {
        const x = r as { canteen: string; amount_rp: number; method: string; received_date: string };
        return `💰 Kas masuk ${LOC_LABEL[x.canteen]}: ${formatRupiah(x.amount_rp)} (${x.method}) · ${x.received_date}`;
      }
      case "cash_out": {
        const x = r as { kind: string; category: string; amount_rp: number; out_date: string };
        const jenis = x.kind === "pengambilan" ? "Pengambilan" : "Pengeluaran";
        return `🧾 ${jenis} [${x.category}]: ${formatRupiah(x.amount_rp)} · ${x.out_date}`;
      }
    }
  });
}

function summarizeAll(batches: ParsedBatch[]): string {
  const lines = batches.flatMap(summarizeBatch);
  const head =
    lines.length === 1 ? "Konfirmasi:" : `Konfirmasi ${lines.length} operasi:`;
  return `${head}\n${lines.map((l) => `• ${l}`).join("\n")}\n\nSimpan?`;
}

// ===== Perintah revisi =====

// Sinonim jenis → entity (untuk `hapus jual 12`, `ubah produksi 3 jadi 5`).
const ENTITY_ALIAS: Record<string, Entity> = {
  produksi: "production",
  mutasi: "stock_movement",
  kirim: "stock_movement",
  jual: "sale",
  penjualan: "sale",
  "kas masuk": "cash_in",
  uang: "cash_in",
  pengeluaran: "cash_out",
  pengambilan: "cash_out",
  "kas keluar": "cash_out",
};

function findEntityAlias(text: string): Entity | null {
  for (const [alias, entity] of Object.entries(ENTITY_ALIAS)) {
    if (text.includes(alias)) return entity;
  }
  return null;
}

/** `hapus jual 12` / `hapus id 12` (tanpa jenis → cari di semua tabel). */
function parseDeleteCommand(text: string): { entity: Entity | null; id: number } | null {
  const m = text.match(/^hapus\s+(?:id\s+)?(.*?)\s*(\d+)\s*$/);
  if (!m || !m[2]) return null;
  const id = parseInt(m[2], 10);
  const entity = m[1] ? findEntityAlias(m[1].trim()) : null;
  return { entity, id };
}

/** `ubah jual 12 jadi 80` → ganti nilai utama (qty/resep/nominal). */
function parseUpdateCommand(
  text: string,
): { entity: Entity | null; id: number; value: number } | null {
  const m = text.match(/^ubah\s+(?:id\s+)?(.*?)\s*(\d+)\s+jadi\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)\s*$/);
  if (!m || !m[2] || !m[3]) return null;
  const id = parseInt(m[2], 10);
  const entity = m[1] ? findEntityAlias(m[1].trim()) : null;
  // nilai bisa "80" (qty) atau "20rb" (nominal)
  const raw = m[3].trim();
  let value: number | null = null;
  if (/^\d+$/.test(raw)) value = parseInt(raw, 10);
  else {
    // impor ringan tanpa siklus: parse bentuk rb/jt di sini
    const rb = raw.match(/^([\d.,]+)\s*(rb|ribu|k)$/);
    const jt = raw.match(/^([\d.,]+)\s*(jt|juta)$/);
    if (rb && rb[1]) value = Math.round(parseFloat(rb[1].replace(",", ".")) * 1000);
    else if (jt && jt[1]) value = Math.round(parseFloat(jt[1].replace(",", ".")) * 1_000_000);
  }
  if (value === null || Number.isNaN(value)) return null;
  return { entity, id, value };
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
      "Halo Zummy! Aku bot pencatat Es Lilin 🧊\n\n" +
        "Catat (boleh beberapa sekaligus, pisahkan dengan koma):\n" +
        "• produksi 6 resep sendiri\n" +
        "• mts1 kirim 100, sma kirim 50\n" +
        "• jual mts1 100, uang mts1 90rb\n" +
        "• beli bahan 20rb\n" +
        "• ambil ayah 31500 spp\n\n" +
        "Tanya:\n" +
        "• cek stok · ringkasan hari ini\n" +
        "• kemarin mts1 kirim berapa · transaksi terakhir\n\n" +
        "Ralat:\n" +
        "• undo · hapus jual 12 · ubah jual 12 jadi 80\n\n" +
        "Aku selalu minta konfirmasi sebelum menyimpan/menghapus. /help untuk detail.",
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "📝 INPUT (boleh multi, pisah koma / baris / 'terus'):\n" +
        "`produksi N resep [sendiri|sama aril]`\n" +
        "`KANTIN kirim QTY` / `kirim QTY ke KANTIN` / `kirim ASAL->TUJUAN QTY`\n" +
        "`jual KANTIN QTY [@harga]` (SMA/SMK kelipatan 50)\n" +
        "`uang KANTIN 90rb` · `beli bahan 20rb` · `ambil [ayah] 50rb [spp]`\n\n" +
        "❓ TANYA:\n" +
        "`cek stok` · `ringkasan hari ini/kemarin`\n" +
        "`kemarin mts1 kirim berapa` · `mts1 jual berapa`\n" +
        "`transaksi terakhir` (tampil id)\n\n" +
        "✏️ RALAT:\n" +
        "`undo` — batalkan input terakhir\n" +
        "`hapus <jenis> <id>` — mis. `hapus jual 12`\n" +
        "`ubah <jenis> <id> jadi <nilai>` — mis. `ubah mutasi 5 jadi 80`\n" +
        "(jenis: produksi/mutasi/jual/uang/pengeluaran)\n\n" +
        "Tanggal default hari ini; bisa sebut `kemarin`.",
      { parse_mode: "Markdown" },
    ),
  );

  // Pesan teks bebas → routing: revisi → pertanyaan → input.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // command sudah ditangani di atas
    const lower = text.toLowerCase();

    // ---- 1. Revisi: undo ----
    if (lower === "undo" || lower === "batalkan terakhir") {
      const last = await getLastInserted();
      if (!last) {
        await ctx.reply("Tidak ada transaksi untuk di-undo.");
        return;
      }
      const kb = new InlineKeyboard()
        .text("🗑 Ya, hapus", `d|${last.entity}|${last.id}`)
        .text("❌ Jangan", "x|");
      await ctx.reply(
        `Input terakhir:\n• [${ENTITY_LABEL[last.entity]} #${last.id}] ${last.summary}\n\nHapus?`,
        { reply_markup: kb },
      );
      return;
    }

    // ---- 2. Revisi: hapus <jenis> <id> ----
    if (lower.startsWith("hapus")) {
      const cmd = parseDeleteCommand(lower);
      if (!cmd) {
        await ctx.reply("Format: `hapus <jenis> <id>` — mis. `hapus jual 12`", { parse_mode: "Markdown" });
        return;
      }
      const snap = cmd.entity ? await getSnapshot(cmd.entity, cmd.id) : null;
      if (!snap) {
        await ctx.reply(
          cmd.entity
            ? `Tidak ketemu ${ENTITY_LABEL[cmd.entity]} dengan id ${cmd.id}.`
            : "Sebutkan jenisnya: `hapus jual 12` / `hapus mutasi 5` (lihat id di `transaksi terakhir`).",
          { parse_mode: "Markdown" },
        );
        return;
      }
      const kb = new InlineKeyboard()
        .text("🗑 Ya, hapus", `d|${snap.entity}|${snap.id}`)
        .text("❌ Jangan", "x|");
      await ctx.reply(`Akan dihapus:\n• [${ENTITY_LABEL[snap.entity]} #${snap.id}] ${snap.summary}\n\nYakin?`, {
        reply_markup: kb,
      });
      return;
    }

    // ---- 3. Revisi: ubah <jenis> <id> jadi <nilai> ----
    if (lower.startsWith("ubah")) {
      const cmd = parseUpdateCommand(lower);
      if (!cmd || !cmd.entity) {
        await ctx.reply(
          "Format: `ubah <jenis> <id> jadi <nilai>` — mis. `ubah mutasi 5 jadi 80`\n(nilai = qty/resep/nominal; untuk ganti tanggal/kantin: hapus lalu input ulang)",
          { parse_mode: "Markdown" },
        );
        return;
      }
      const snap = await getSnapshot(cmd.entity, cmd.id);
      if (!snap) {
        await ctx.reply(`Tidak ketemu ${ENTITY_LABEL[cmd.entity]} dengan id ${cmd.id}.`);
        return;
      }
      const kb = new InlineKeyboard()
        .text("✏️ Ya, ubah", `u|${cmd.entity}|${cmd.id}|${cmd.value}`)
        .text("❌ Jangan", "x|");
      await ctx.reply(
        `Data sekarang:\n• [${ENTITY_LABEL[snap.entity]} #${snap.id}] ${snap.summary}\n\nNilai utama diganti jadi ${cmd.value}. Lanjut?`,
        { reply_markup: kb },
      );
      return;
    }

    // ---- 4. Pertanyaan (jalur baca) ----
    if (isQuestion(lower)) {
      try {
        const answer = await answerQuestion(lower);
        await ctx.reply(answer, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply("Maaf, gagal mengambil laporan. Coba lagi sebentar.");
      }
      return;
    }

    // ---- 5. Input transaksi (multi-op) ----
    let rawBatches;
    try {
      rawBatches = await parseMessage(text);
    } catch {
      await ctx.reply(
        "Maaf, aku belum paham catatan itu 🙏\nCoba tulis lebih spesifik, mis. `jual mts1 100` atau `beli bahan 20rb`. Ketik /help untuk contoh.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const result = validateBatches(rawBatches);
    if (!result.ok) {
      await ctx.reply(
        "Datanya belum bisa disimpan:\n" +
          result.errors.map((e) => `⚠️ ${e}`).join("\n") +
          "\n\nCoba perbaiki lalu kirim lagi.",
      );
      return;
    }

    let pendingId: string;
    try {
      pendingId = await savePending(result.batches);
    } catch {
      await ctx.reply("⚠️ Gagal menyiapkan konfirmasi. Coba lagi sebentar.");
      return;
    }

    const kb = new InlineKeyboard()
      .text("✅ Simpan", `s|${pendingId}`)
      .text("❌ Batal", `x|${pendingId}`);

    await ctx.reply(summarizeAll(result.batches), { reply_markup: kb });
  });

  // Tombol konfirmasi: s|<pendingId>, x|<pendingId?>, d|<entity>|<id>, u|<entity>|<id>|<val>
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split("|");
    const action = parts[0] ?? "";

    try {
      // ---- Batal ----
      if (action === "x") {
        const pid = parts[1];
        if (pid) await discardPending(pid).catch(() => {});
        await ctx.answerCallbackQuery({ text: "Dibatalkan" });
        await ctx.editMessageText("❌ Dibatalkan. Tidak ada yang berubah.");
        return;
      }

      // ---- Simpan batch dari pending ----
      if (action === "s") {
        const pid = parts[1] ?? "";
        const pending = await takePending(pid);
        if (!pending.ok) {
          await ctx.answerCallbackQuery({ text: "Kedaluwarsa" });
          await ctx.editMessageText(
            pending.reason === "notfound"
              ? "⚠️ Konfirmasi kedaluwarsa / sudah dipakai. Kirim ulang catatannya ya."
              : "⚠️ Data konfirmasi tidak valid. Kirim ulang catatannya ya.",
          );
          return;
        }
        const res = await insertBatches(pending.batches);
        const lines = res.results.map((r) =>
          "error" in r
            ? `⚠️ ${ENTITY_LABEL[r.entity]}: gagal`
            : `✅ ${ENTITY_LABEL[r.entity]} tersimpan — id: ${r.ids.join(", ")}`,
        );
        await ctx.answerCallbackQuery({
          text: res.okCount === res.total ? "Tersimpan ✅" : "Sebagian gagal",
        });
        await ctx.editMessageText(
          `${res.okCount}/${res.total} operasi tersimpan:\n${lines.join("\n")}`,
        );
        return;
      }

      // ---- Hapus (undo / hapus id) ----
      if (action === "d") {
        const entity = parts[1] as Entity;
        const id = parseInt(parts[2] ?? "", 10);
        if (!entity || Number.isNaN(id)) throw new Error("payload salah");
        const ok = await deleteRow(entity, id);
        await ctx.answerCallbackQuery({ text: ok ? "Terhapus" : "Tidak ketemu" });
        await ctx.editMessageText(
          ok
            ? `🗑 [${ENTITY_LABEL[entity]} #${id}] dihapus.`
            : `⚠️ [${ENTITY_LABEL[entity]} #${id}] tidak ditemukan (mungkin sudah terhapus).`,
        );
        return;
      }

      // ---- Ubah nilai utama ----
      if (action === "u") {
        const entity = parts[1] as Entity;
        const id = parseInt(parts[2] ?? "", 10);
        const value = parseInt(parts[3] ?? "", 10);
        if (!entity || Number.isNaN(id) || Number.isNaN(value)) throw new Error("payload salah");
        const ok = await updateMainValue(entity, id, value);
        const snap = ok ? await getSnapshot(entity, id) : null;
        await ctx.answerCallbackQuery({ text: ok ? "Diubah ✅" : "Tidak ketemu" });
        await ctx.editMessageText(
          ok
            ? `✏️ [${ENTITY_LABEL[entity]} #${id}] diubah.\nSekarang: ${snap?.summary ?? "(terubah)"}`
            : `⚠️ [${ENTITY_LABEL[entity]} #${id}] tidak ditemukan.`,
        );
        return;
      }

      await ctx.answerCallbackQuery({ text: "Aksi tidak dikenal" });
    } catch {
      await ctx.answerCallbackQuery({ text: "Gagal" });
      // Pesan ramah; jangan tampilkan error mentah DB.
      await ctx.editMessageText("⚠️ Terjadi masalah. Coba lagi sebentar.").catch(() => {});
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
