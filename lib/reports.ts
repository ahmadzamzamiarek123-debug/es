// Query laporan untuk web (read-only, role web_reader).
import { getSqlWeb } from "./db";
import { getHppSummary } from "./hpp";
import { getMonthlyFixedCost } from "./fixed-costs";

export interface Summary {
  omzet: number; // total penjualan (revenue)
  totalBahan: number; // estimasi biaya bahan baku terpakai
  upahProduksi: number; // total upah produksi
  biayaVariabel: number; // totalBahan + upahProduksi
  labaKotor: number; // omzet - biayaVariabel
  marginKotorPercent: number; // (labaKotor / omzet) * 100
  biayaTetap: number; // monthly_fixed_cost
  pengeluaranOperasionalLain: number; // cash_out kind='pengeluaran' kategori non-bahan
  labaBersih: number; // labaKotor - biayaTetap - pengeluaranOperasionalLain
  marginBersihPercent: number; // (labaBersih / omzet) * 100

  // Metrik Transisi & Kas
  labaUsaha: number; // versi lama: omzet - (pengeluaranKas + upahProduksi)
  pengeluaran: number; // total cash_out kind='pengeluaran'
  pengambilan: number; // total cash_out kind='pengambilan' (owner draw)
  saldoAwal: number; // opening_balance.saldo_awal_rp
  kasTersisa: number; // saldoAwal + labaUsaha - pengambilan
  
  // Info Produksi & HPP
  hppPerPcs: number;
  totalRecipes: number;
  totalPiecesProduced: number;
}

const toInt = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) ? n : 0;
};

export async function getLocationLabels(): Promise<Record<string, string>> {
  const sql = getSqlWeb();
  const rows = (await sql`
    SELECT code, label FROM location_ref ORDER BY code
  `) as Record<string, unknown>[];
  const map: Record<string, string> = {};
  for (const r of rows) map[String(r.code)] = String(r.label);
  return map;
}

export function labelOf(code: string, labels: Record<string, string>): string {
  return labels[code] ?? code.toUpperCase();
}

/**
 * Ringkasan angka untuk rentang tanggal [start, end] inklusif.
 */
export async function getSummary(start: string, end: string): Promise<Summary> {
  const sql = getSqlWeb();
  const monthStr = start.slice(0, 7); // 'YYYY-MM'

  const [dbRows, hpp, fixedCost] = await Promise.all([
    sql`
      SELECT
        (SELECT COALESCE(SUM(total_rp),0) FROM sale
          WHERE sale_date BETWEEN ${start} AND ${end})                       AS omzet,
        (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
          WHERE kind='pengeluaran' AND out_date BETWEEN ${start} AND ${end}) AS pengeluaran,
        (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
          WHERE kind='pengeluaran' AND category <> 'bahan'
            AND out_date BETWEEN ${start} AND ${end})                       AS pengeluaran_non_bahan,
        (SELECT COALESCE(SUM(wage_rp),0) FROM production
          WHERE prod_date BETWEEN ${start} AND ${end})                       AS upah_produksi,
        (SELECT COALESCE(SUM(recipes),0) FROM production
          WHERE prod_date BETWEEN ${start} AND ${end})                       AS total_recipes,
        (SELECT COALESCE(SUM(output_pieces),0) FROM production
          WHERE prod_date BETWEEN ${start} AND ${end})                       AS total_pieces,
        (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
          WHERE kind='pengambilan' AND out_date BETWEEN ${start} AND ${end}) AS pengambilan,
        (SELECT COALESCE(saldo_awal_rp,0) FROM opening_balance WHERE id=1)    AS saldo_awal
    ` as Promise<Record<string, unknown>[]>,
    getHppSummary(sql),
    getMonthlyFixedCost(sql, monthStr),
  ]);

  const r = dbRows[0] ?? {};
  const omzet = toInt(r.omzet);
  const pengeluaran = toInt(r.pengeluaran);
  const pengeluaranOperasionalLain = toInt(r.pengeluaran_non_bahan);
  const upahProduksi = toInt(r.upah_produksi);
  const totalRecipes = toInt(r.total_recipes);
  const totalPiecesProduced = toInt(r.total_pieces);
  const pengambilan = toInt(r.pengambilan);
  const saldoAwal = toInt(r.saldo_awal);

  // Kalkulasi HPP & Biaya Variabel
  const totalBahan = totalRecipes * hpp.totalBahanPerRecipeRp;
  const biayaVariabel = totalBahan + upahProduksi;
  const labaKotor = omzet - biayaVariabel;
  const marginKotorPercent = omzet > 0 ? Math.round((labaKotor / omzet) * 1000) / 10 : 0;

  // Biaya Tetap & Laba Bersih
  const biayaTetap = fixedCost;
  const labaBersih = labaKotor - biayaTetap - pengeluaranOperasionalLain;
  const marginBersihPercent = omzet > 0 ? Math.round((labaBersih / omzet) * 1000) / 10 : 0;

  // Metrik Transisi & Kas
  const labaUsaha = omzet - (pengeluaran + upahProduksi);
  const kasTersisa = saldoAwal + labaUsaha - pengambilan;

  return {
    omzet,
    totalBahan,
    upahProduksi,
    biayaVariabel,
    labaKotor,
    marginKotorPercent,
    biayaTetap,
    pengeluaranOperasionalLain,
    labaBersih,
    marginBersihPercent,
    labaUsaha,
    pengeluaran,
    pengambilan,
    saldoAwal,
    kasTersisa,
    hppPerPcs: hpp.hppPerPcsRp,
    totalRecipes,
    totalPiecesProduced,
  };
}

export interface DailyOmzet {
  date: string; // 'YYYY-MM-DD'
  total: number;
}

export async function getDailyOmzet(
  start: string,
  end: string,
): Promise<DailyOmzet[]> {
  const sql = getSqlWeb();
  const rows = (await sql`
    SELECT sale_date::text AS date, COALESCE(SUM(total_rp),0) AS total
    FROM sale
    WHERE sale_date BETWEEN ${start} AND ${end}
    GROUP BY sale_date
    ORDER BY sale_date
  `) as Record<string, unknown>[];
  return rows.map((r) => ({ date: String(r.date), total: toInt(r.total) }));
}

export interface CanteenSales {
  canteen: string;
  total: number;
}

export async function getSalesByCanteen(
  start: string,
  end: string,
): Promise<CanteenSales[]> {
  const sql = getSqlWeb();
  const rows = (await sql`
    SELECT canteen::text AS canteen, COALESCE(SUM(total_rp),0) AS total
    FROM sale
    WHERE sale_date BETWEEN ${start} AND ${end}
    GROUP BY canteen
    ORDER BY total DESC
  `) as Record<string, unknown>[];
  return rows.map((r) => ({
    canteen: String(r.canteen),
    total: toInt(r.total),
  }));
}

export interface ExpenseSlice {
  category: string;
  total: number;
}

/**
 * Komposisi biaya: pengeluaran kas operasional + rincian upah per pekerja.
 */
export async function getExpenseComposition(
  start: string,
  end: string,
): Promise<ExpenseSlice[]> {
  const sql = getSqlWeb();
  const [expRows, wageWorkerRows] = await Promise.all([
    sql`
      SELECT category::text AS category, COALESCE(SUM(amount_rp),0) AS total
      FROM cash_out
      WHERE kind='pengeluaran' AND out_date BETWEEN ${start} AND ${end}
      GROUP BY category
      ORDER BY total DESC
    ` as Promise<Record<string, unknown>[]>,
    sql`
      SELECT w.name AS worker_name, COALESCE(SUM(pw.wage_rp),0) AS total_wage
      FROM production_worker pw
      JOIN worker w ON w.id = pw.worker_id
      JOIN production p ON p.id = pw.production_id
      WHERE p.prod_date BETWEEN ${start} AND ${end}
      GROUP BY w.name
      ORDER BY total_wage DESC
    ` as Promise<Record<string, unknown>[]>,
  ]);

  const slices: ExpenseSlice[] = expRows.map((r) => ({
    category: String(r.category),
    total: toInt(r.total),
  }));

  for (const wr of wageWorkerRows) {
    const total = toInt(wr.total_wage);
    if (total > 0) {
      slices.push({
        category: `Upah ${String(wr.worker_name)}`,
        total,
      });
    }
  }

  return slices.sort((a, b) => b.total - a.total);
}

export interface TxRow {
  id: number;
  kind: "production" | "stock_movement" | "sale" | "cash_in" | "cash_out";
  date: string;
  title: string;
  detail: string;
  amount: number | null;
  direction: "in" | "out" | "neutral";
}

export async function getRecentTransactions(
  start: string,
  end: string,
  limit = 100,
): Promise<TxRow[]> {
  const sql = getSqlWeb();
  const [sales, movements, cashIns, cashOuts, prods, labels] = await Promise.all([
    sql`SELECT id, sale_date::text AS d, canteen::text AS canteen, qty, total_rp
        FROM sale WHERE sale_date BETWEEN ${start} AND ${end}
        ORDER BY sale_date DESC, id DESC LIMIT ${limit}` as Promise<
      Record<string, unknown>[]
    >,
    sql`SELECT id, move_date::text AS d, from_loc::text AS f, to_loc::text AS t, qty
        FROM stock_movement WHERE move_date BETWEEN ${start} AND ${end}
        ORDER BY move_date DESC, id DESC LIMIT ${limit}` as Promise<
      Record<string, unknown>[]
    >,
    sql`SELECT id, received_date::text AS d, canteen::text AS canteen, amount_rp, method::text AS method
        FROM cash_in WHERE received_date BETWEEN ${start} AND ${end}
        ORDER BY received_date DESC, id DESC LIMIT ${limit}` as Promise<
      Record<string, unknown>[]
    >,
    sql`SELECT id, out_date::text AS d, kind::text AS kind, category::text AS category, amount_rp
        FROM cash_out WHERE out_date BETWEEN ${start} AND ${end}
        ORDER BY out_date DESC, id DESC LIMIT ${limit}` as Promise<
      Record<string, unknown>[]
    >,
    sql`SELECT id, prod_date::text AS d, recipes, pieces_per_recipe, output_pieces, wage_rp
        FROM production WHERE prod_date BETWEEN ${start} AND ${end}
        ORDER BY prod_date DESC, id DESC LIMIT ${limit}` as Promise<
      Record<string, unknown>[]
    >,
    getLocationLabels(),
  ]);

  const lbl = (code: string) => labelOf(code, labels);
  const tx: TxRow[] = [];

  for (const r of sales) {
    tx.push({
      id: toInt(r.id),
      kind: "sale",
      date: String(r.d),
      title: `Jual ${lbl(String(r.canteen))}`,
      detail: `${toInt(r.qty)} biji`,
      amount: toInt(r.total_rp),
      direction: "in",
    });
  }
  for (const r of movements) {
    tx.push({
      id: toInt(r.id),
      kind: "stock_movement",
      date: String(r.d),
      title: `Mutasi ${lbl(String(r.f))} → ${lbl(String(r.t))}`,
      detail: `${toInt(r.qty)} biji`,
      amount: null,
      direction: "neutral",
    });
  }
  for (const r of cashIns) {
    tx.push({
      id: toInt(r.id),
      kind: "cash_in",
      date: String(r.d),
      title: `Kas masuk ${lbl(String(r.canteen))}`,
      detail: String(r.method),
      amount: toInt(r.amount_rp),
      direction: "in",
    });
  }
  for (const r of cashOuts) {
    const isDraw = String(r.kind) === "pengambilan";
    tx.push({
      id: toInt(r.id),
      kind: "cash_out",
      date: String(r.d),
      title: isDraw ? `Pengambilan (${r.category})` : `Beli/Biaya (${r.category})`,
      detail: isDraw ? "owner draw" : "pengeluaran",
      amount: toInt(r.amount_rp),
      direction: "out",
    });
  }
  for (const r of prods) {
    tx.push({
      id: toInt(r.id),
      kind: "production",
      date: String(r.d),
      title: "Produksi",
      detail: `${toInt(r.recipes)} resep (${toInt(r.output_pieces)} pcs @${toInt(r.pieces_per_recipe)})`,
      amount: null,
      direction: "neutral",
    });
  }

  tx.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return tx.slice(0, limit);
}

export interface CheckItem {
  canteen: string;
  omzet: number;
  kasMasuk: number;
  selisih: number;
}

export async function getNeedsCheck(
  start: string,
  end: string,
): Promise<CheckItem[]> {
  const sql = getSqlWeb();
  const rows = (await sql`
    SELECT c.code AS canteen,
           COALESCE(s.omzet,0)   AS omzet,
           COALESCE(ci.masuk,0)  AS masuk
    FROM (SELECT code FROM location_ref
          WHERE is_canteen = true AND is_warehouse = false AND active = true) c
    LEFT JOIN (SELECT canteen, SUM(total_rp) AS omzet FROM sale
               WHERE sale_date BETWEEN ${start} AND ${end} GROUP BY canteen) s
      ON s.canteen = c.code
    LEFT JOIN (SELECT canteen, SUM(amount_rp) AS masuk FROM cash_in
               WHERE received_date BETWEEN ${start} AND ${end} GROUP BY canteen) ci
      ON ci.canteen = c.code
    ORDER BY c.code
  `) as Record<string, unknown>[];

  return rows.map((r) => {
    const omzet = toInt(r.omzet);
    const kasMasuk = toInt(r.masuk);
    return { canteen: String(r.canteen), omzet, kasMasuk, selisih: omzet - kasMasuk };
  });
}

export interface StockRow {
  loc: string;
  masuk: number;
  keluar: number;
  terjual: number;
  sisa: number;
}

export interface StockReport {
  prodToday: { recipes: number; pieces: number };
  prodYesterday: { recipes: number; pieces: number };
  keluarToday: number;
  stocks: StockRow[];
  batch50: string[];
}

export async function getStockReport(
  today: string,
  yesterday: string,
): Promise<StockReport> {
  const sql = getSqlWeb();
  const [prodRows, moveRows, stockRows, batch50Rows] = await Promise.all([
    sql`
      SELECT
        COALESCE(SUM(recipes)       FILTER (WHERE prod_date = ${today}), 0)::int     AS r_today,
        COALESCE(SUM(output_pieces) FILTER (WHERE prod_date = ${today}), 0)::int     AS p_today,
        COALESCE(SUM(recipes)       FILTER (WHERE prod_date = ${yesterday}), 0)::int AS r_yest,
        COALESCE(SUM(output_pieces) FILTER (WHERE prod_date = ${yesterday}), 0)::int AS p_yest
      FROM production
    ` as Promise<Record<string, unknown>[]>,
    sql`
      SELECT COALESCE(SUM(qty),0)::int AS keluar
      FROM stock_movement
      WHERE from_loc IN (SELECT code FROM location_ref WHERE is_warehouse = true)
        AND move_date = ${today}
    ` as Promise<Record<string, unknown>[]>,
    sql`
      WITH locs AS (
        SELECT code AS loc, is_warehouse
        FROM location_ref
        WHERE active = true AND is_batch50 = false
      )
      SELECT
        l.loc AS loc,
        (CASE WHEN l.is_warehouse
              THEN COALESCE((SELECT SUM(output_pieces) FROM production), 0)
              ELSE 0 END
         + COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.to_loc = l.loc), 0))::int AS masuk,
        COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.from_loc = l.loc), 0)::int AS keluar,
        COALESCE((SELECT SUM(qty) FROM sale s WHERE s.canteen = l.loc), 0)::int AS terjual
      FROM locs l
      ORDER BY l.is_warehouse DESC, l.loc
    ` as Promise<Record<string, unknown>[]>,
    sql`
      SELECT code FROM location_ref
      WHERE active = true AND is_batch50 = true
      ORDER BY code
    ` as Promise<Record<string, unknown>[]>,
  ]);

  const p = prodRows[0] ?? {};
  const stocks: StockRow[] = stockRows.map((r) => {
    const masuk = toInt(r.masuk);
    const keluar = toInt(r.keluar);
    const terjual = toInt(r.terjual);
    return {
      loc: String(r.loc),
      masuk,
      keluar,
      terjual,
      sisa: masuk - keluar - terjual,
    };
  });

  return {
    prodToday: { recipes: toInt(p.r_today), pieces: toInt(p.p_today) },
    prodYesterday: { recipes: toInt(p.r_yest), pieces: toInt(p.p_yest) },
    keluarToday: toInt(moveRows[0]?.keluar),
    stocks,
    batch50: batch50Rows.map((r) => String(r.code)),
  };
}
