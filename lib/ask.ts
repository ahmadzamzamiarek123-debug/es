/**
 * Jalur TANYA (baca) untuk bot: "cek stok", "kemarin mts1 kirim berapa",
 * "ringkasan hari ini", "transaksi terakhir".
 *
 * Keamanan: pertanyaan diubah jadi INTENT terstruktur oleh regex (tanpa AI
 * untuk pola umum). SQL selalu tagged-template berparameter — teks user tidak
 * pernah disambung ke SQL. Gemini TIDAK dipakai di jalur ini sama sekali:
 * pertanyaan di luar pola dijawab dengan bantuan format yang didukung.
 */
import { getSqlBot } from "./db";
import { todayJakarta, daysAgoJakarta } from "./dates";
import { rp } from "./format";
import { LOCATIONS } from "./validate";

const LOC_LABEL: Record<string, string> = {
  rumah: "Rumah",
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
  sma: "SMA",
  smk: "SMK",
};

/** Temukan lokasi yang disebut dalam teks ("mts 1" → mts1). */
function findLocation(text: string): string | null {
  const t = text.toLowerCase().replace(/mts\s+1/g, "mts1").replace(/mts\s+2/g, "mts2");
  for (const loc of LOCATIONS) {
    if (new RegExp(`\\b${loc}\\b`).test(t)) return loc;
  }
  return null;
}

/** Tanggal yang dimaksud pertanyaan (default hari ini). */
function findDate(text: string): { date: string; label: string } {
  const t = text.toLowerCase();
  if (/kemarin\s+lusa|lusa\s+kemarin/.test(t)) return { date: daysAgoJakarta(2), label: "kemarin lusa" };
  if (/\bkemarin\b/.test(t)) return { date: daysAgoJakarta(1), label: "kemarin" };
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && iso[1]) return { date: iso[1], label: iso[1] };
  return { date: todayJakarta(), label: "hari ini" };
}

/**
 * Stok fisik per lokasi = masuk (produksi utk rumah + mutasi masuk)
 * − mutasi keluar − terjual. SMA/SMK batch-50: stok fisik tidak dilacak.
 */
export async function stockReport(): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    WITH locs AS (SELECT unnest(ARRAY['rumah','mts1','mts2','smp']::location[]) AS loc)
    SELECT
      l.loc::text AS loc,
      COALESCE((SELECT SUM(output_pieces) FROM production WHERE l.loc = 'rumah'), 0)::int
        AS produced,
      COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.to_loc = l.loc), 0)::int AS moved_in,
      COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.from_loc = l.loc), 0)::int AS moved_out,
      COALESCE((SELECT SUM(qty) FROM sale s WHERE s.canteen = l.loc), 0)::int AS sold
    FROM locs l
  `) as { loc: string; produced: number; moved_in: number; moved_out: number; sold: number }[];

  const lines = rows.map((r) => {
    const stock = r.produced + r.moved_in - r.moved_out - r.sold;
    return `• ${LOC_LABEL[r.loc] ?? r.loc}: ${stock} biji`;
  });
  lines.push("• SMA & SMK: batch 50 — stok fisik tidak dilacak");
  return `📦 Stok saat ini:\n${lines.join("\n")}`;
}

/** Ringkasan satu hari: produksi, kiriman, penjualan, kas masuk/keluar. */
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

/** "kemarin mts1 kirim berapa" → total mutasi MASUK ke lokasi pada tanggal. */
export async function movementReport(
  loc: string,
  date: string,
  label: string,
): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN to_loc = ${loc}::location THEN qty END), 0)::int AS masuk,
      COALESCE(SUM(CASE WHEN from_loc = ${loc}::location THEN qty END), 0)::int AS keluar
    FROM stock_movement WHERE move_date = ${date}
  `) as { masuk: number; keluar: number }[];
  const r = rows[0];
  const masuk = r?.masuk ?? 0;
  const keluar = r?.keluar ?? 0;
  const name = LOC_LABEL[loc] ?? loc;
  return `🔁 Mutasi ${name} ${label} (${date}):\n• Masuk: ${masuk} biji\n• Keluar: ${keluar} biji`;
}

/** "mts1 jual berapa hari ini" → penjualan per kantin per tanggal. */
export async function saleReport(
  loc: string,
  date: string,
  label: string,
): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT COALESCE(SUM(qty),0)::int AS qty, COALESCE(SUM(total_rp),0)::int AS total
    FROM sale WHERE canteen = ${loc}::location AND sale_date = ${date}
  `) as { qty: number; total: number }[];
  const r = rows[0];
  const name = LOC_LABEL[loc] ?? loc;
  return `💵 Penjualan ${name} ${label} (${date}): ${r?.qty ?? 0} biji — ${rp(r?.total ?? 0)}`;
}

/** Transaksi terakhir lintas tabel, dengan ID (untuk perintah ubah/hapus). */
export async function recentReport(limit = 8): Promise<string> {
  const sql = getSqlBot();
  const rows = (await sql`
    SELECT * FROM (
      SELECT 'produksi' AS jenis, id::int, prod_date::text AS tgl,
             recipes || ' resep (' || worker || ')' AS info, created_at
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
  "• `ringkasan hari ini` / `ringkasan kemarin`\n" +
  "• `kemarin mts1 kirim berapa`\n" +
  "• `mts1 jual berapa hari ini`\n" +
  "• `transaksi terakhir` (tampil id untuk ralat)";

/**
 * Router pertanyaan → jawaban. Pola tak dikenal → daftar bantuan (tanpa AI:
 * jalur baca sengaja deterministik agar aman & hemat kuota).
 */
export async function answerQuestion(text: string): Promise<string> {
  const t = text.toLowerCase();
  const { date, label } = findDate(t);
  const loc = findLocation(t);

  if (/\bstok\b/.test(t) && !loc) return stockReport();
  if (/transaksi terakhir|riwayat/.test(t)) return recentReport();
  if (/ringkasan|laporan|total/.test(t) && !loc) return dayReport(date, label);

  if (loc) {
    if (/\bkirim\b|\bmutasi\b|\bstok\b/.test(t)) return movementReport(loc, date, label);
    if (/\bjual\b|\bpenjualan\b|\blaku\b/.test(t)) return saleReport(loc, date, label);
    return dayReport(date, label);
  }

  return HELP_TEXT;
}
