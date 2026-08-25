// Bot Telegram (grammY, mode WEBHOOK — tidak ada polling/bot.start()).
//
// Alur input: teks → parse multi-op (regex→Gemini) → validasi zod → ringkasan
// + tombol [✅ Simpan][❌ Batal]. TIDAK ada auto-insert: insert hanya setelah
// Simpan ditekan.

import { Bot, InlineKeyboard, type Context } from "grammy";
import {
  parseMessage,
  isQuestion,
  parseRupiah,
  parseIngredientPriceUpdate,
  parseMonthlyFixedCost,
  parseDefaultPieces,
  parseWorkerSetting,
  parseWorkerStatusActivation,
} from "./parse";
import {
  validateBatches,
  locationSettingSchema,
  openingBalanceSchema,
  ingredientPriceUpdateSchema,
  workerSettingSchema,
  monthlyFixedCostSchema,
  defaultPiecesSchema,
  type ParsedBatch,
  type Entity,
} from "./validate";
import {
  insertBatches,
  getSnapshot,
  getLastInserted,
  deleteRow,
  updateMainValue,
  upsertLocation,
  deactivateLocation,
  setOpeningBalance,
  updateIngredientPriceAction,
  upsertWorkerAction,
  setWorkerStatusAction,
  setMonthlyFixedCostAction,
  setDefaultPiecesAction,
  ENTITY_LABEL,
} from "./insert";
import {
  savePending,
  takePending,
  discardPending,
  saveSettingPending,
  takeSettingPending,
} from "./pending";
import { answerQuestion } from "./ask";
import { formatRupiah } from "./format";
import { getSqlBot } from "./db";
import {
  getLocationsFresh,
  buildLocationCtx,
  labelMapOf,
  type LocationInfo,
  type LocationCtx,
} from "./locations";
import { getWorkers, buildWorkerCtx, calculateWagesForProduction, type WorkerInfo, type WorkerCtx } from "./workers";
import { getDefaultPiecesPerRecipe } from "./settings";
import { getHppSummary } from "./hpp";

// ===== Muat konteks (lokasi, pekerja, default pieces) =====
interface LoadedCtx {
  locs: LocationInfo[];
  ctx: LocationCtx;
  labels: Record<string, string>;
  workers: WorkerInfo[];
  wCtx: WorkerCtx;
  defaultPieces: number;
}

async function loadCtx(): Promise<LoadedCtx> {
  const sql = getSqlBot();
  const [locs, workers, defaultPieces] = await Promise.all([
    getLocationsFresh(sql),
    getWorkers(sql, true),
    getDefaultPiecesPerRecipe(sql),
  ]);
  return {
    locs,
    ctx: buildLocationCtx(locs),
    labels: labelMapOf(locs),
    workers,
    wCtx: buildWorkerCtx(workers),
    defaultPieces,
  };
}

function labelOf(code: string, labels: Record<string, string>): string {
  return labels[code] ?? code.toUpperCase();
}

// ===== Ringkasan untuk konfirmasi transaksi =====
function summarizeBatch(
  batch: ParsedBatch,
  labels: Record<string, string>,
  wCtx: WorkerCtx,
  defaultPieces: number,
): string[] {
  return batch.rows.map((r) => {
    switch (batch.entity) {
      case "production": {
        const x = r as {
          recipes: number;
          pieces_per_recipe?: number;
          workers?: string[];
          prod_date: string;
        };
        const pieces = x.pieces_per_recipe ?? defaultPieces;
        const totalPieces = x.recipes * pieces;

        let assignedWorkers = wCtx.productionWorkers;
        if (x.workers && x.workers.length > 0) {
          const matched = x.workers
            .map((wName) => wCtx.workerMap.get(wName.toLowerCase()))
            .filter((w): w is WorkerInfo => Boolean(w && w.active));
          if (matched.length > 0) assignedWorkers = matched;
        }

        const { totalWageRp } = calculateWagesForProduction(
          assignedWorkers,
          x.recipes,
          pieces,
        );

        const workerNames = assignedWorkers.map((w) => w.name).join(" & ");

        return `🧊 Produksi ${x.recipes} resep (${totalPieces} pcs @${pieces}/resep) oleh ${workerNames || "pekerja aktif"}, total upah ${formatRupiah(totalWageRp)} · ${x.prod_date}`;
      }
      case "stock_movement": {
        const x = r as { from_loc: string; to_loc: string; qty: number; move_date: string };
        return `🔁 Mutasi ${labelOf(x.from_loc, labels)} → ${labelOf(x.to_loc, labels)}: ${x.qty} biji · ${x.move_date}`;
      }
      case "sale": {
        const x = r as { canteen: string; qty: number; price_rp: number; sale_date: string };
        return `💵 Jual ${labelOf(x.canteen, labels)}: ${x.qty} × ${formatRupiah(x.price_rp)} = ${formatRupiah(x.qty * x.price_rp)} · ${x.sale_date}`;
      }
      case "cash_in": {
        const x = r as { canteen: string; amount_rp: number; method: string; received_date: string };
        return `💰 Kas masuk ${labelOf(x.canteen, labels)}: ${formatRupiah(x.amount_rp)} (${x.method}) · ${x.received_date}`;
      }
      case "cash_out": {
        const x = r as { kind: string; category: string; amount_rp: number; out_date: string };
        const jenis = x.kind === "pengambilan" ? "Pengambilan" : "Pengeluaran";
        return `🧾 ${jenis} [${x.category}]: ${formatRupiah(x.amount_rp)} · ${x.out_date}`;
      }
    }
  });
}

function summarizeAll(
  batches: ParsedBatch[],
  labels: Record<string, string>,
  wCtx: WorkerCtx,
  defaultPieces: number,
): string {
  const lines = batches.flatMap((b) => summarizeBatch(b, labels, wCtx, defaultPieces));
  const head = lines.length === 1 ? "Konfirmasi:" : `Konfirmasi ${lines.length} operasi:`;
  return `${head}\n${lines.map((l) => `• ${l}`).join("\n")}\n\nSimpan?`;
}

// ===== Perintah Revisi =====

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

function parseDeleteCommand(text: string): { entity: Entity | null; id: number } | null {
  const m = text.match(/^hapus\s+(?:id\s+)?(.*?)\s*(\d+)\s*$/);
  if (!m || !m[2]) return null;
  const id = parseInt(m[2], 10);
  const entity = m[1] ? findEntityAlias(m[1].trim()) : null;
  return { entity, id };
}

function parseUpdateCommand(
  text: string,
): { entity: Entity | null; id: number; value: number } | null {
  const m = text.match(/^ubah\s+(?:id\s+)?(.*?)\s*(\d+)\s+jadi\s+([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)\s*$/);
  if (!m || !m[2] || !m[3]) return null;
  const id = parseInt(m[2], 10);
  const entity = m[1] ? findEntityAlias(m[1].trim()) : null;
  const raw = m[3].trim();
  let value: number | null = null;
  if (/^\d+$/.test(raw)) value = parseInt(raw, 10);
  else {
    const rb = raw.match(/^([\d.,]+)\s*(rb|ribu|k)$/);
    const jt = raw.match(/^([\d.,]+)\s*(jt|juta)$/);
    if (rb && rb[1]) value = Math.round(parseFloat(rb[1].replace(",", ".")) * 1000);
    else if (jt && jt[1]) value = Math.round(parseFloat(jt[1].replace(",", ".")) * 1_000_000);
  }
  if (value === null || Number.isNaN(value)) return null;
  return { entity, id, value };
}

// ===== /setting =====

const SETTING_HELP =
  "⚙️ *Menu Pengaturan Usaha Es Lilin*\n\n" +
  "Kantin:\n" +
  "• `/setting lokasi <kode> <Nama> [harga] [batch50]`\n" +
  "• `/setting hapuslokasi <kode>`\n\n" +
  "Bahan Baku & HPP:\n" +
  "• Chat: `harga creamer sekarang 55rb per kilo`\n" +
  "• Chat: `harga gula 18rb/kg`\n" +
  "• Chat: `ganti default pcs per resep jadi 88`\n\n" +
  "Gaji & Karyawan:\n" +
  "• Chat: `tambah karyawan baru bibi, produksi, per pcs 150`\n" +
  "• Chat: `gaji adek jadi 6000 per resep`\n" +
  "• Chat: `ayah mulai digaji`\n\n" +
  "Biaya Tetap:\n" +
  "• Chat: `biaya tetap bulan ini 65rb`\n\n" +
  "Saldo Awal Modal:\n" +
  "• `/setting saldo <nominal> [catatan]`";

interface SettingLocationCmd {
  kind: "location";
  code: string;
  label: string;
  price: number | null;
  batch50: boolean;
}
interface SettingDeleteCmd { kind: "delloc"; code: string }
interface SettingSaldoCmd { kind: "saldo"; amount: number; note?: string }
type SettingCmd =
  | SettingLocationCmd
  | SettingDeleteCmd
  | SettingSaldoCmd
  | { kind: "help" }
  | { kind: "error"; message: string };

function parseSettingCommand(text: string): SettingCmd {
  const body = text.replace(/^\/setting(?:@\w+)?\s*/i, "").trim();
  if (!body) return { kind: "help" };

  const sub = body.split(/\s+/)[0]?.toLowerCase() ?? "";
  const rest = body.slice(sub.length).trim();

  if (sub === "lokasi") {
    const tokens = rest.match(/"[^"]+"|\S+/g) ?? [];
    if (tokens.length < 2) {
      return { kind: "error", message: "Format: `/setting lokasi <kode> <Nama> [harga] [batch50]`" };
    }
    const code = tokens[0]!.toLowerCase();
    let batch50 = false;
    let price: number | null = null;
    const labelParts: string[] = [];
    for (const tk of tokens.slice(1)) {
      const t = tk.toLowerCase();
      if (t === "batch50" || t === "batch") { batch50 = true; continue; }
      const asRp = parseRupiah(tk);
      if (asRp !== null && /^\d|rb|ribu|k|jt|juta/i.test(tk)) { price = asRp; continue; }
      labelParts.push(tk.replace(/^"|"$/g, ""));
    }
    const label = labelParts.join(" ").trim() || code.toUpperCase();
    return { kind: "location", code, label, price, batch50 };
  }

  if (sub === "hapuslokasi" || sub === "nonaktif") {
    const code = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!code) return { kind: "error", message: "Format: `/setting hapuslokasi <kode>`" };
    return { kind: "delloc", code };
  }

  if (sub === "saldo") {
    const m = rest.match(/^([\d.,]+\s*(?:rb|ribu|k|jt|juta)?)(?:\s+(.*))?$/i);
    if (!m || !m[1]) return { kind: "error", message: "Format: `/setting saldo <nominal> [catatan]`" };
    const amount = parseRupiah(m[1]);
    if (amount === null) return { kind: "error", message: "Nominal saldo tidak dikenali." };
    const note = m[2]?.trim();
    return note ? { kind: "saldo", amount, note } : { kind: "saldo", amount };
  }

  return { kind: "error", message: "Sub-perintah tidak dikenal. Ketik `/setting` untuk bantuan." };
}

// ===== Bot & Handler =====
let _bot: Bot | null = null;

export function getBot(): Bot {
  if (_bot) return _bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum diset");

  const bot = new Bot(token);

  bot.command("start", (ctx) =>
    ctx.reply(
      "Halo Zummy! Aku bot pencatat Es Lilin 🧊\n\n" +
        "Catat Transaksi:\n" +
        "• produksi 4 resep hasil 340 sama adek\n" +
        "• mts1 kirim 100, sma kirim 50\n" +
        "• jual mts1 100, uang mts1 90rb\n" +
        "• beli bahan 20rb · ambil ayah 31500 spp\n" +
        "• gaji ayah 50rb\n\n" +
        "Ubah Harga & Biaya:\n" +
        "• harga creamer sekarang 55rb per kilo\n" +
        "• biaya tetap bulan ini 65rb\n" +
        "• ganti default pcs per resep jadi 88\n\n" +
        "Tanya:\n" +
        "• cek stok · cek hpp · cek pekerja · cek biaya tetap\n" +
        "• ringkasan hari ini · transaksi terakhir\n\n" +
        "Semua perubahan selalu lewat tombol konfirmasi ✅",
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      "📝 *PANDUAN INPUT CHAT*\n\n" +
        "*1. Produksi & Mutasi:*\n" +
        "`produksi 4 resep` (default 85 pcs/resep)\n" +
        "`produksi 4 resep hasil 340 sama adek`\n" +
        "`kirim rumah->mts1 100` · `lempar mts1 ke mts2 15`\n\n" +
        "*2. Penjualan & Kas:*\n" +
        "`jual mts1 100` · `jual sma 50 @1300`\n" +
        "`uang mts1 90rb` (kas masuk)\n" +
        "`beli bahan 20rb` · `gaji ayah 50rb` (pengeluaran)\n" +
        "`ambil ayah 31500 spp` (owner draw)\n\n" +
        "*3. Master Data & Setting:*\n" +
        "`harga creamer sekarang 55rb per kilo`\n" +
        "`ganti default pcs per resep jadi 88`\n" +
        "`tambah karyawan baru bibi, produksi, per pcs 150`\n" +
        "`biaya tetap bulan ini 65rb`\n" +
        "`ayah mulai digaji`\n\n" +
        "*4. Tanya:*\n" +
        "`cek hpp` · `cek stok` · `cek pekerja` · `ringkasan hari ini`\n\n" +
        "*5. Ralat:*\n" +
        "`undo` · `hapus jual 12` · `ubah produksi 3 jadi 5`",
      { parse_mode: "Markdown" },
    ),
  );

  bot.command("setting", async (ctx) => {
    const cmd = parseSettingCommand(ctx.message?.text ?? "");

    if (cmd.kind === "help") {
      const { locs } = await loadCtx();
      const canteens = locs.filter((l) => l.isCanteen && !l.isWarehouse && l.active);
      const daftar = canteens.length
        ? canteens
            .map((l) => `• ${l.code} — ${l.label}${l.priceRp ? ` @${formatRupiah(l.priceRp)}` : " (harga belum diset)"}${l.isBatch50 ? " [batch50]" : ""}`)
            .join("\n")
        : "(belum ada kantin — tambahkan dengan `/setting lokasi ...`)";
      await ctx.reply(`${SETTING_HELP}\n\nKantin terdaftar:\n${daftar}`, { parse_mode: "Markdown" });
      return;
    }

    if (cmd.kind === "error") {
      await ctx.reply(cmd.message, { parse_mode: "Markdown" });
      return;
    }

    if (cmd.kind === "location") {
      const parsed = locationSettingSchema.safeParse({
        code: cmd.code,
        label: cmd.label,
        price_rp: cmd.price,
        is_batch50: cmd.batch50,
      });
      if (!parsed.success) {
        await ctx.reply("Datanya belum bisa disimpan:\n" + parsed.error.issues.map((i) => `⚠️ ${i.message}`).join("\n"));
        return;
      }
      const d = parsed.data;
      const pid = await saveSettingPending({ kind: "location", data: d });
      const kb = new InlineKeyboard()
        .text("✅ Simpan", `ss|${pid}`)
        .text("❌ Batal", `sx|${pid}`);
      await ctx.reply(
        `Konfirmasi kantin:\n• Kode: ${d.code}\n• Nama: ${d.label}\n• Harga/biji: ${d.price_rp ? formatRupiah(d.price_rp) : "(belum diset)"}\n• Batch 50: ${d.is_batch50 ? "ya" : "tidak"}\n\nSimpan?`,
        { reply_markup: kb },
      );
      return;
    }

    if (cmd.kind === "delloc") {
      const { ctx: lctx, labels } = await loadCtx();
      if (!lctx.locationSet.has(cmd.code)) {
        await ctx.reply(`Lokasi '${cmd.code}' tidak ditemukan / sudah nonaktif.`);
        return;
      }
      if (lctx.warehouseSet.has(cmd.code)) {
        await ctx.reply(`'${cmd.code}' adalah gudang — tidak bisa dinonaktifkan.`);
        return;
      }
      const ok = await deactivateLocation(cmd.code);
      await ctx.reply(
        ok
          ? `🗑 Kantin ${labelOf(cmd.code, labels)} dinonaktifkan (data lama tetap aman).`
          : `⚠️ Gagal menonaktifkan '${cmd.code}'.`,
      );
      return;
    }

    if (cmd.kind === "saldo") {
      const parsed = openingBalanceSchema.safeParse({
        saldo_awal_rp: cmd.amount,
        note: cmd.note,
      });
      if (!parsed.success) {
        await ctx.reply("Datanya belum bisa disimpan:\n" + parsed.error.issues.map((i) => `⚠️ ${i.message}`).join("\n"));
        return;
      }
      const d = parsed.data;
      const pid = await saveSettingPending({ kind: "opening_balance", data: d });
      const kb = new InlineKeyboard()
        .text("✅ Simpan", `ss|${pid}`)
        .text("❌ Batal", `sx|${pid}`);
      await ctx.reply(
        `Konfirmasi saldo awal:\n• Nominal: ${formatRupiah(d.saldo_awal_rp)}${d.note ? `\n• Catatan: ${d.note}` : ""}\n\nIni baseline modal (sekali isi, bisa dikoreksi). Simpan?`,
        { reply_markup: kb },
      );
      return;
    }
  });

  // Pesan teks bebas
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
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

    // ---- 4. Master Data: Update Harga Bahan via Chat ----
    const ingPrice = parseIngredientPriceUpdate(text);
    if (ingPrice) {
      const parsed = ingredientPriceUpdateSchema.safeParse(ingPrice);
      if (parsed.success) {
        const d = parsed.data;
        const pid = await saveSettingPending({ kind: "ingredient_price", data: d });
        const kb = new InlineKeyboard()
          .text("✅ Simpan", `ss|${pid}`)
          .text("❌ Batal", `sx|${pid}`);
        await ctx.reply(
          `Konfirmasi update harga bahan:\n• Bahan: *${d.name.toUpperCase()}*\n• Harga baru: *${formatRupiah(d.price_per_unit_rp)}* per satuan\n${d.raw_text ? `• Input: ${d.raw_text}\n` : ""}\nSimpan & perbarui HPP?`,
          { reply_markup: kb, parse_mode: "Markdown" },
        );
        return;
      }
    }

    // ---- 5. Master Data: Update Biaya Tetap Bulanan via Chat ----
    const fixedCost = parseMonthlyFixedCost(text);
    if (fixedCost) {
      const parsed = monthlyFixedCostSchema.safeParse(fixedCost);
      if (parsed.success) {
        const d = parsed.data;
        const pid = await saveSettingPending({ kind: "monthly_fixed_cost", data: d });
        const kb = new InlineKeyboard()
          .text("✅ Simpan", `ss|${pid}`)
          .text("❌ Batal", `sx|${pid}`);
        await ctx.reply(
          `Konfirmasi biaya tetap bulanan:\n• Bulan: *${d.effective_month}*\n• Nominal: *${formatRupiah(d.amount_rp)}* (listrik + gas)\n\nSimpan?`,
          { reply_markup: kb, parse_mode: "Markdown" },
        );
        return;
      }
    }

    // ---- 6. Master Data: Update Default Yield/Pieces per Resep ----
    const defPieces = parseDefaultPieces(text);
    if (defPieces) {
      const parsed = defaultPiecesSchema.safeParse(defPieces);
      if (parsed.success) {
        const d = parsed.data;
        const pid = await saveSettingPending({ kind: "default_pieces", data: d });
        const kb = new InlineKeyboard()
          .text("✅ Simpan", `ss|${pid}`)
          .text("❌ Batal", `sx|${pid}`);
        await ctx.reply(
          `Konfirmasi default yield resep:\n• Output standar baru: *${d.pieces_per_recipe} pcs/resep*\n\nSimpan?`,
          { reply_markup: kb, parse_mode: "Markdown" },
        );
        return;
      }
    }

    // ---- 7. Master Data: Tambah/Ubah Karyawan via Chat ----
    const wSetting = parseWorkerSetting(text);
    if (wSetting) {
      const parsed = workerSettingSchema.safeParse(wSetting);
      if (parsed.success) {
        const d = parsed.data;
        const pid = await saveSettingPending({ kind: "worker_setting", data: d });
        const kb = new InlineKeyboard()
          .text("✅ Simpan", `ss|${pid}`)
          .text("❌ Batal", `sx|${pid}`);
        await ctx.reply(
          `Konfirmasi data karyawan:\n• Nama: *${d.name}*\n• Bagian: *${d.role}*\n• Skema Gaji: *${formatRupiah(d.rate_rp)} / ${d.rate_type.replace("per_", "")}*\n\nSimpan?`,
          { reply_markup: kb, parse_mode: "Markdown" },
        );
        return;
      }
    }

    // ---- 8. Master Data: Aktivasi Gaji Ayah ----
    const wStatus = parseWorkerStatusActivation(text);
    if (wStatus) {
      const pid = await saveSettingPending({ kind: "worker_status", data: wStatus });
      const kb = new InlineKeyboard()
        .text("✅ Simpan", `ss|${pid}`)
        .text("❌ Batal", `sx|${pid}`);
      await ctx.reply(
        `Konfirmasi aktivasi gaji:\n• Pekerja: *${wStatus.name.toUpperCase()}*\n• Status: *Aktif digaji*\n\nSimpan?`,
        { reply_markup: kb, parse_mode: "Markdown" },
      );
      return;
    }

    // ---- 9. Pertanyaan (jalur baca) ----
    if (isQuestion(lower)) {
      try {
        const { ctx: lctx, labels } = await loadCtx();
        const answer = await answerQuestion(lower, lctx, labels);
        await ctx.reply(answer, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply("Maaf, gagal mengambil laporan. Coba lagi sebentar.");
      }
      return;
    }

    // ---- 10. Input transaksi (multi-op) ----
    const { ctx: lctx, labels, wCtx, defaultPieces } = await loadCtx();
    let rawBatches;
    try {
      rawBatches = await parseMessage(text, lctx, wCtx);
    } catch {
      await ctx.reply(
        "Maaf, aku belum paham catatan itu 🙏\n\n" +
          "Coba sebutkan angkanya dengan jelas, contoh:\n" +
          "• `produksi 4 resep hasil 340 sama adek`\n" +
          "• `jual mts1 79`\n" +
          "• `uang mts1 90rb` · `beli bahan 20rb`\n" +
          "• `harga creamer sekarang 55rb per kilo`\n\n" +
          "Ketik `/help` untuk bantuan format.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const result = validateBatches(rawBatches, lctx);
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

    await ctx.reply(summarizeAll(result.batches, labels, wCtx, defaultPieces), { reply_markup: kb });
  });

  // Tombol konfirmasi callback
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split("|");
    const action = parts[0] ?? "";

    try {
      // Batal
      if (action === "x" || action === "sx") {
        const pid = parts[1];
        if (pid) await discardPending(pid).catch(() => {});
        await ctx.answerCallbackQuery({ text: "Dibatalkan" });
        await ctx.editMessageText("❌ Dibatalkan. Tidak ada yang berubah.");
        return;
      }

      // Simpan pengaturan / Master Data
      if (action === "ss") {
        const pid = parts[1] ?? "";
        const s = await takeSettingPending(pid);
        if (!s.ok) {
          await ctx.answerCallbackQuery({ text: "Kedaluwarsa" });
          await ctx.editMessageText("⚠️ Konfirmasi kedaluwarsa / sudah dipakai. Ketik ulang perintahnya ya.");
          return;
        }

        if (s.kind === "location") {
          await upsertLocation(s.data);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(`✅ Kantin ${s.data.label} (${s.data.code}) disimpan.`);
        } else if (s.kind === "opening_balance") {
          await setOpeningBalance(s.data);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(`✅ Saldo awal disimpan: ${formatRupiah(s.data.saldo_awal_rp)}.`);
        } else if (s.kind === "ingredient_price") {
          await updateIngredientPriceAction(s.data);
          const sql = getSqlBot();
          const hpp = await getHppSummary(sql, true);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(
            `✅ Harga ${s.data.name.toUpperCase()} diperbarui jadi ${formatRupiah(s.data.price_per_unit_rp)}/satuan.\n💰 HPP baru: *${formatRupiah(hpp.hppPerPcsRp)}/pcs*`,
            { parse_mode: "Markdown" },
          );
        } else if (s.kind === "worker_setting") {
          await upsertWorkerAction(s.data);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(`✅ Data karyawan *${s.data.name}* disimpan: ${formatRupiah(s.data.rate_rp)}/${s.data.rate_type.replace("per_", "")}.`, { parse_mode: "Markdown" });
        } else if (s.kind === "worker_status") {
          await setWorkerStatusAction(s.data.name, s.data.status);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(`✅ Status karyawan *${s.data.name}* diubah menjadi *${s.data.status}*.`, { parse_mode: "Markdown" });
        } else if (s.kind === "monthly_fixed_cost") {
          await setMonthlyFixedCostAction(s.data);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(`✅ Biaya tetap bulan *${s.data.effective_month}* disimpan: ${formatRupiah(s.data.amount_rp)}.`, { parse_mode: "Markdown" });
        } else if (s.kind === "default_pieces") {
          await setDefaultPiecesAction(s.data);
          await ctx.answerCallbackQuery({ text: "Tersimpan ✅" });
          await ctx.editMessageText(`✅ Default yield resep diubah menjadi *${s.data.pieces_per_recipe} pcs/resep*.`, { parse_mode: "Markdown" });
        }
        return;
      }

      // Simpan transaksi
      if (action === "s") {
        const pid = parts[1] ?? "";
        const { ctx: lctx } = await loadCtx();
        const pending = await takePending(pid, lctx);
        if (!pending.ok) {
          await ctx.answerCallbackQuery({ text: "Kedaluwarsa" });
          await ctx.editMessageText("⚠️ Konfirmasi kedaluwarsa / sudah dipakai. Kirim ulang catatannya ya.");
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

      // Hapus
      if (action === "d") {
        const entity = parts[1] as Entity;
        const id = parseInt(parts[2] ?? "", 10);
        if (!entity || Number.isNaN(id)) throw new Error("payload salah");
        const ok = await deleteRow(entity, id);
        await ctx.answerCallbackQuery({ text: ok ? "Terhapus" : "Tidak ketemu" });
        await ctx.editMessageText(
          ok
            ? `🗑 [${ENTITY_LABEL[entity]} #${id}] dihapus.`
            : `⚠️ [${ENTITY_LABEL[entity]} #${id}] tidak ditemukan.`,
        );
        return;
      }

      // Ubah
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
      await ctx.editMessageText("⚠️ Terjadi masalah. Coba lagi sebentar.").catch(() => {});
    }
  });

  _bot = bot;
  return bot;
}

export function getAllowedId(): number {
  const v = process.env.ALLOWED_TELEGRAM_ID;
  if (!v) throw new Error("ALLOWED_TELEGRAM_ID belum diset");
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error("ALLOWED_TELEGRAM_ID tidak valid");
  return n;
}

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
