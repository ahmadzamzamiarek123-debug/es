/**
 * Jalur TANYA (baca) untuk bot: "cek stok", "cek hpp", "cek pekerja", "cek biaya tetap",
 * "kemarin mts1 kirim berapa", "ringkasan hari ini", "transaksi terakhir".
 */
import { getSqlBot } from "./db";
import { todayJakarta, daysAgoJakarta, currentMonthJakarta } from "./dates";
import { rp } from "./format";
import type { LocationCtx } from "./locations";
import { getHppSummary } from "./hpp";
import { getWorkers } from "./workers";
import { getMonthlyFixedCost } from "./fixed-costs";

function labelOf(code: string, labels: Record<string, string>): string {
  return labels[code] ?? code.toUpperCase();
}

function findLocation(text: string, ctx: LocationCtx): string | null {
  const t = text.toLowerCase();
  const aliases = [...ctx.aliasMap.keys()].sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|\\b)${esc}(?:\\b|$)`).test(t)) {
      return ctx.aliasMap.get(alias) ?? null;
    }
  }
  return null;
}

function findDate(text: string): { date: string; label: string } {
  const t = text.toLowerCase();
  if (/kemarin\s+lusa|lusa\s+kemarin/.test(t)) return { date: daysAgoJakarta(2), label: "kemarin lusa" };
  if (/\bkemarin\b/.test(t)) return { date: daysAgoJakarta(1), label: "kemarin" };
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && iso[1]) return { date: iso[1], label: iso[1] };
  return { date: todayJakarta(), label: "hari ini" };
}

/** Laporan HPP dinamis */
export async function hppReport(): Promise<string> {
  const sql = getSqlBot();
  const hpp = await getHppSummary(sql, true);

  const ingLines = hpp.ingredients.map(
    (i) => `• ${i.name}: ${i.qtyPerRecipe}${i.unit} × Rp${i.pricePerUnitRp}/${i.unit} = ${rp(i.costPerRecipeRp)}`,
  );

  return (
    `🧊 *Rincian HPP Es Lilin:*\n\n` +
    `*Biaya Bahan per 1 Resep:*\n` +
    `${ingLines.join("\n")}\n` +
    `👉 *Total Bahan/resep:* ${rp(hpp.totalBahanPerRecipeRp)}\n` +
    `👉 *Upah Produksi/resep:* ${rp(hpp.upahProduksiPerRecipeRp)}\n` +
    `👉 *Total HPP/resep:* ${rp(hpp.totalHppPerRecipeRp)}\n\n` +
    `🎯 *Yield:* ${hpp.piecesPerRecipe} pcs/resep\n` +
    `💰 *HPP per pcs:* *${rp(hpp.hppPerPcsRp)}* (Bahan saja: ${rp(hpp.hppBahanOnlyPerPcsRp)}/pcs)`
  );
}

/** Laporan daftar pekerja */
export async function workersReport(): Promise<string> {
  const sql = getSqlBot();
  const list = await getWorkers(sql, true);

  const lines = list.map((w) => {
    const statusNote = w.status === "rencana_belum_final" ? " _(rencana/belum final)_" : "";
    return `• *${w.name}* [${w.role}] — ${rp(w.rateRp)} / ${w.rateType.replace("per_", "")}${statusNote}`;
  });

  return `👥 *Daftar Karyawan / Pekerja:*\n${lines.join("\n")}`;
}

/** Laporan biaya tetap */
export async function fixedCostReport(): Promise<string> {
  const sql = getSqlBot();
  const month = currentMonthJakarta();
  const cost = await getMonthlyFixedCost(sql, month);

  return `💡 *Biaya Tetap Bulan Ini (${month}):*\n• Total: *${rp(cost)}* (listrik freezer + gas)`;
}

export async function stockReport(ctx: LocationCtx, labels: Record<string, string>): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    WITH locs AS (
      SELECT code AS loc, is_warehouse
      FROM location_ref
      WHERE active = true AND is_batch50 = false
    )
    SELECT
      l.loc AS loc,
      COALESCE((SELECT SUM(output_pieces) FROM production WHERE l.is_warehouse), 0)::int
        AS produced,
      COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.to_loc = l.loc), 0)::int AS moved_in,
      COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.from_loc = l.loc), 0)::int AS moved_out,
      COALESCE((SELECT SUM(qty) FROM sale s WHERE s.canteen = l.loc), 0)::int AS sold
    FROM locs l
    ORDER BY l.is_warehouse DESC, l.loc
  `) as { loc: string; produced: number; moved_in: number; moved_out: number; sold: number }[];

  const lines = rows.map((r) => {
    const stock = r.produced + r.moved_in - r.moved_out - r.sold;
    return `• ${labelOf(r.loc, labels)}: ${stock} biji`;
  });
  const b50 = [...ctx.batch50Set].map((c) => labelOf(c, labels));
  if (b50.length) {
    lines.push(`• ${b50.join(" & ")}: batch 50 — stok fisik tidak dilacak`);
  }
  return `📦 Stok saat ini:\n${lines.join("\n")}`;
}

export async function dayReport(date: string, label: string): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT
      COALESCE((SELECT SUM(recipes) FROM production WHERE prod_date = ${date}), 0)::int AS recipes,
      COALESCE((SELECT SUM(output_pieces) FROM production WHERE prod_date = ${date}), 0)::int AS pieces,
      COALESCE((SELECT SUM(qty) FROM stock_movement WHERE move_date = ${date}), 0)::int AS moved,
      COALESCE((SELECT SUM(qty) FROM sale WHERE sale_date = ${date}), 0)::int AS sold,
      COALESCE((SELECT SUM(total_rp) FROM sale WHERE sale_date = ${date}), 0)::int AS omzet,
      COALESCE((SELECT SUM(amount_rp) FROM cash_in WHERE received_date = ${date}), 0)::int AS cash_in,
      COALESCE((SELECT SUM(amount_rp) FROM cash_out WHERE out_date = ${date}), 0)::int AS cash_out
  `) as {
    recipes: number; pieces: number; moved: number; sold: number;
    omzet: number; cash_in: number; cash_out: number;
  }[];
  const r = rows[0];
  if (!r) return `Tidak ada data untuk ${label}.`;
  return (
    `📊 Ringkasan ${label} (${date}):\n` +
    `• Produksi: ${r.recipes} resep (${r.pieces} biji)\n` +
    `• Es keluar (mutasi): ${r.moved} biji\n` +
    `• Terjual: ${r.sold} biji — omzet ${rp(r.omzet)}\n` +
    `• Kas masuk: ${rp(r.cash_in)}\n` +
    `• Kas keluar: ${rp(r.cash_out)}`
  );
}

export async function movementReport(
  loc: string,
  date: string,
  label: string,
  labels: Record<string, string>,
): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN to_loc = ${loc} THEN qty END), 0)::int AS masuk,
      COALESCE(SUM(CASE WHEN from_loc = ${loc} THEN qty END), 0)::int AS keluar
    FROM stock_movement WHERE move_date = ${date}
  `) as { masuk: number; keluar: number }[];
  const r = rows[0];
  const masuk = r?.masuk ?? 0;
  const keluar = r?.keluar ?? 0;
  const name = labelOf(loc, labels);
  return `🔁 Mutasi ${name} ${label} (${date}):\n• Masuk: ${masuk} biji\n• Keluar: ${keluar} biji`;
}

export async function saleReport(
  loc: string,
  date: string,
  label: string,
  labels: Record<string, string>,
): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT COALESCE(SUM(qty),0)::int AS qty, COALESCE(SUM(total_rp),0)::int AS total
    FROM sale WHERE canteen = ${loc} AND sale_date = ${date}
  `) as { qty: number; total: number }[];
  const r = rows[0];
  const name = labelOf(loc, labels);
  return `💵 Penjualan ${name} ${label} (${date}): ${r?.qty ?? 0} biji — ${rp(r?.total ?? 0)}`;
}

export async function recentReport(limit = 8): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT * FROM (
      SELECT 'produksi' AS jenis, id::int, prod_date::text AS tgl,
             recipes || ' resep (' || output_pieces || ' pcs @' || pieces_per_recipe || ')' AS info, created_at
        FROM production
      UNION ALL
      SELECT 'mutasi', id::int, move_date::text,
             from_loc || '→' || to_loc || ' ' || qty || ' biji', created_at
        FROM stock_movement
      UNION ALL
      SELECT 'jual', id::int, sale_date::text,
             canteen || ' ' || qty || ' × ' || price_rp, created_at
        FROM sale
      UNION ALL
      SELECT 'kas masuk', id::int, received_date::text,
             canteen || ' Rp' || amount_rp, created_at
        FROM cash_in
      UNION ALL
      SELECT kind::text, id::int, out_date::text,
             category || ' Rp' || amount_rp, created_at
        FROM cash_out
    ) t ORDER BY created_at DESC LIMIT ${limit}
  `) as { jenis: string; id: number; tgl: string; info: string }[];

  if (rows.length === 0) return "Belum ada transaksi.";
  const lines = rows.map(
    (r) => `• [${r.jenis} #${r.id}] ${r.info} · ${r.tgl}`,
  );
  return (
    `🧾 Transaksi terakhir:\n${lines.join("\n")}\n\n` +
    `Untuk meralat: \`ubah <jenis> <id> jadi <nilai>\` atau \`hapus <jenis> <id>\``
  );
}

const HELP_TEXT =
  "Aku bisa jawab:\n" +
  "• `cek stok`\n" +
  "• `cek hpp`\n" +
  "• `cek gaji` / `cek pekerja`\n" +
  "• `cek biaya tetap`\n" +
  "• `ringkasan hari ini` / `ringkasan kemarin`\n" +
  "• `kemarin mts1 kirim berapa`\n" +
  "• `mts1 jual berapa hari ini`\n" +
  "• `transaksi terakhir` (tampil id untuk ralat)";

export async function answerQuestion(
  text: string,
  ctx: LocationCtx,
  labels: Record<string, string>,
): Promise<string> {
  const t = text.toLowerCase();
  const { date, label } = findDate(t);
  const loc = findLocation(t, ctx);

  if (/\bhpp\b/.test(t)) return hppReport();
  if (/\b(pekerja|karyawan|gaji|rate)\b/.test(t) && !/\bgaji\s+ayah\s+\d+/.test(t)) return workersReport();
  if (/\bbiaya\s+tetap\b/.test(t)) return fixedCostReport();
  if (/\bstok\b/.test(t) && !loc) return stockReport(ctx, labels);
  if (/transaksi terakhir|riwayat/.test(t)) return recentReport();
  if (/ringkasan|laporan|total/.test(t) && !loc) return dayReport(date, label);

  if (loc) {
    if (/\bkirim\b|\bmutasi\b|\bstok\b/.test(t)) return movementReport(loc, date, label, labels);
    if (/\bjual\b|\bpenjualan\b|\blaku\b/.test(t)) return saleReport(loc, date, label, labels);
    return dayReport(date, label);
  }

  return HELP_TEXT;
}
