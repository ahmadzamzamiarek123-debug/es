// Query laporan untuk web (read-only, role web_reader).
//
// Semua query BERPARAMETER lewat tagged-template neon (aman dari injection).
// TIDAK ada string-concat SQL. Tidak memanggil Gemini — web murni baca DB.
//
// Rumus (PROJECT.md §2):
//   Laba usaha  = Omzet − (Pengeluaran + Upah produksi)
//   Kas tersisa = Laba usaha − Pengambilan
// Pengambilan (owner draw, mis. SPP via MTS2) TIDAK mengurangi laba usaha,
// hanya mengurangi kas tersisa.

import { getSqlWeb } from "./db";

export interface Summary {
  omzet: number; // total penjualan
  pengeluaran: number; // cash_out kind='pengeluaran'
  upah: number; // total upah produksi (Zummy + Aril)
  upahZummy: number; // production.wage_zummy_rp
  upahAril: number; // production.wage_aril_rp
  pengambilan: number; // cash_out kind='pengambilan'
  labaUsaha: number; // omzet - (pengeluaran + upah)
  kasTersisa: number; // labaUsaha - pengambilan
}

const toInt = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Ringkasan angka untuk rentang tanggal [start, end] inklusif.
 * start & end berupa 'YYYY-MM-DD'.
 */
export async function getSummary(start: string, end: string): Promise<Summary> {
  const sql = getSqlWeb();
  const rows = (await sql`
    SELECT
      (SELECT COALESCE(SUM(total_rp),0) FROM sale
        WHERE sale_date BETWEEN ${start} AND ${end})                       AS omzet,
      (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
        WHERE kind='pengeluaran' AND out_date BETWEEN ${start} AND ${end}) AS pengeluaran,
      (SELECT COALESCE(SUM(wage_zummy_rp),0) FROM production
        WHERE prod_date BETWEEN ${start} AND ${end})                       AS upah_zummy,
      (SELECT COALESCE(SUM(wage_aril_rp),0) FROM production
        WHERE prod_date BETWEEN ${start} AND ${end})                       AS upah_aril,
      (SELECT COALESCE(SUM(amount_rp),0) FROM cash_out
        WHERE kind='pengambilan' AND out_date BETWEEN ${start} AND ${end}) AS pengambilan
  `) as Record<string, unknown>[];

  const r = rows[0] ?? {};
  const omzet = toInt(r.omzet);
  const pengeluaran = toInt(r.pengeluaran);
  const upahZummy = toInt(r.upah_zummy);
  const upahAril = toInt(r.upah_aril);
  const upah = upahZummy + upahAril;
  const pengambilan = toInt(r.pengambilan);
  const labaUsaha = omzet - (pengeluaran + upah);
  const kasTersisa = labaUsaha - pengambilan;

  return { omzet, pengeluaran, upah, upahZummy, upahAril, pengambilan, labaUsaha, kasTersisa };
}

export interface DailyOmzet {
  date: string; // 'YYYY-MM-DD'
  total: number;
}

/** Omzet harian dalam rentang (untuk grafik garis). */
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

/** Penjualan per kantin (untuk grafik batang). */
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
 * Komposisi biaya untuk donut: pengeluaran per kategori + upah per orang
 * (Zummy & Aril terpisah — kadang produksi tidak dikerjakan berdua).
 * Pengambilan TIDAK dimasukkan (owner draw, bukan biaya usaha).
 */
export async function getExpenseComposition(
  start: string,
  end: string,
): Promise<ExpenseSlice[]> {
  const sql = getSqlWeb();
  const expRows = (await sql`
    SELECT category::text AS category, COALESCE(SUM(amount_rp),0) AS total
    FROM cash_out
    WHERE kind='pengeluaran' AND out_date BETWEEN ${start} AND ${end}
    GROUP BY category
    ORDER BY total DESC
  `) as Record<string, unknown>[];
  const wageRows = (await sql`
    SELECT COALESCE(SUM(wage_zummy_rp),0) AS zummy,
           COALESCE(SUM(wage_aril_rp),0)  AS aril
    FROM production
    WHERE prod_date BETWEEN ${start} AND ${end}
  `) as Record<string, unknown>[];

  const slices: ExpenseSlice[] = expRows.map((r) => ({
    category: String(r.category),
    total: toInt(r.total),
  }));
  const upahZummy = toInt(wageRows[0]?.zummy);
  const upahAril = toInt(wageRows[0]?.aril);
  if (upahZummy > 0) slices.push({ category: "upah Zummy", total: upahZummy });
  if (upahAril > 0) slices.push({ category: "upah Aril", total: upahAril });
  return slices.sort((a, b) => b.total - a.total);
}

export interface TxRow {
  id: number;
  kind: "production" | "stock_movement" | "sale" | "cash_in" | "cash_out";
  date: string;
  title: string;
  detail: string;
  amount: number | null; // null untuk mutasi/produksi (tak ada nilai kas)
  direction: "in" | "out" | "neutral";
}

/**
 * Transaksi gabungan terbaru dari 5 tabel (untuk daftar & halaman transaksi).
 * Memakai UNION ALL berparameter; limit dibatasi.
 */
export async function getRecentTransactions(
  start: string,
  end: string,
  limit = 100,
): Promise<TxRow[]> {
  const sql = getSqlWeb();
  // Ambil per tabel lalu gabung di aplikasi — lebih mudah dibaca & tetap aman.
  const [sales, movements, cashIns, cashOuts, prods] = await Promise.all([
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
    sql`SELECT id, prod_date::text AS d, recipes, output_pieces, wage_rp
        FROM production WHERE prod_date BETWEEN ${start} AND ${end}
        ORDER BY prod_date DESC, id DESC LIMIT ${limit}` as Promise<
      Record<string, unknown>[]
    >,
  ]);

  const up = (s: string) => s.toUpperCase();
  const tx: TxRow[] = [];

  for (const r of sales) {
    tx.push({
      id: toInt(r.id),
      kind: "sale",
      date: String(r.d),
      title: `Jual ${up(String(r.canteen))}`,
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
      title: `Mutasi ${up(String(r.f))} → ${up(String(r.t))}`,
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
      title: `Kas masuk ${up(String(r.canteen))}`,
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
      title: isDraw ? `Pengambilan (${r.category})` : `Beli ${r.category}`,
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
      detail: `${toInt(r.recipes)} resep · ${toInt(r.output_pieces)} biji`,
      amount: null,
      direction: "neutral",
    });
  }

  // Urutkan gabungan by tanggal desc lalu id desc.
  tx.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return tx.slice(0, limit);
}

export interface CheckItem {
  canteen: string;
  omzet: number;
  kasMasuk: number;
  selisih: number;
}

/**
 * View "Perlu dicek": per kantin, bandingkan omzet penjualan vs kas masuk pada
 * rentang. Selisih besar (uang belum diterima / lebih) ditandai untuk ditinjau.
 * Ini bukan error — SMA/SMK memang wajar telat bayar — hanya bantu audit.
 */
export async function getNeedsCheck(
  start: string,
  end: string,
): Promise<CheckItem[]> {
  const sql = getSqlWeb();
  const rows = (await sql`
    SELECT c.canteen::text AS canteen,
           COALESCE(s.omzet,0)   AS omzet,
           COALESCE(ci.masuk,0)  AS masuk
    FROM (SELECT unnest(ARRAY['mts1','mts2','smp','sma','smk']::location[]) AS canteen) c
    LEFT JOIN (SELECT canteen, SUM(total_rp) AS omzet FROM sale
               WHERE sale_date BETWEEN ${start} AND ${end} GROUP BY canteen) s
      ON s.canteen = c.canteen
    LEFT JOIN (SELECT canteen, SUM(amount_rp) AS masuk FROM cash_in
               WHERE received_date BETWEEN ${start} AND ${end} GROUP BY canteen) ci
      ON ci.canteen = c.canteen
    ORDER BY c.canteen
  `) as Record<string, unknown>[];

  return rows.map((r) => {
    const omzet = toInt(r.omzet);
    const kasMasuk = toInt(r.masuk);
    return { canteen: String(r.canteen), omzet, kasMasuk, selisih: omzet - kasMasuk };
  });
}

// ===== Halaman Stok =====

export interface StockRow {
  loc: string;
  masuk: number; // produksi (rumah) + mutasi masuk
  keluar: number; // mutasi keluar
  terjual: number;
  sisa: number;
}

export interface StockReport {
  prodToday: { recipes: number; pieces: number };
  prodYesterday: { recipes: number; pieces: number };
  keluarToday: number; // total mutasi keluar dari rumah hari ini
  stocks: StockRow[]; // rumah + kantin non-batch (SMA/SMK tidak dilacak)
}

/**
 * Data halaman /stok. Stok fisik = masuk − keluar − terjual per lokasi,
 * dihitung SEPANJANG WAKTU (bukan per periode). SMA & SMK batch-50 tidak
 * disertakan (stok fisik memang tidak dilacak — lihat CLAUDE.md §3).
 */
export async function getStockReport(
  today: string,
  yesterday: string,
): Promise<StockReport> {
  const sql = getSqlWeb();
  const [prodRows, moveRows, stockRows] = await Promise.all([
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
      FROM stock_movement WHERE from_loc = 'rumah' AND move_date = ${today}
    ` as Promise<Record<string, unknown>[]>,
    sql`
      WITH locs AS (SELECT unnest(ARRAY['rumah','mts1','mts2','smp']::location[]) AS loc)
      SELECT
        l.loc::text AS loc,
        (CASE WHEN l.loc = 'rumah'
              THEN COALESCE((SELECT SUM(output_pieces) FROM production), 0)
              ELSE 0 END
         + COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.to_loc = l.loc), 0))::int AS masuk,
        COALESCE((SELECT SUM(qty) FROM stock_movement m WHERE m.from_loc = l.loc), 0)::int AS keluar,
        COALESCE((SELECT SUM(qty) FROM sale s WHERE s.canteen = l.loc), 0)::int AS terjual
      FROM locs l
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
  };
}
