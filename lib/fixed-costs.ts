/**
 * Pengelolaan Biaya Tetap Bulanan (listrik freezer + gas, dll).
 */
import { neon } from '@neondatabase/serverless';
import { currentMonthJakarta } from './dates';

type Sql = ReturnType<typeof neon>;

export interface MonthlyFixedCostInfo {
  effectiveMonth: string; // 'YYYY-MM'
  amountRp: number;
  note: string | null;
}

const DEFAULT_FIXED_COST_RP = 55_000;

export async function getMonthlyFixedCost(
  sql: Sql,
  monthStr?: string,
): Promise<number> {
  const month = monthStr ?? currentMonthJakarta();
  try {
    const rows = (await sql`
      SELECT amount_rp FROM monthly_fixed_cost
      WHERE effective_month = ${month}
    `) as { amount_rp: number }[];

    if (rows.length > 0 && typeof rows[0]?.amount_rp === 'number') {
      return rows[0].amount_rp;
    }

    // Jika belum diset untuk bulan ini, cari bulan terdekat sebelumnya
    const fallbackRows = (await sql`
      SELECT amount_rp FROM monthly_fixed_cost
      WHERE effective_month <= ${month}
      ORDER BY effective_month DESC
      LIMIT 1
    `) as { amount_rp: number }[];

    if (fallbackRows.length > 0 && typeof fallbackRows[0]?.amount_rp === 'number') {
      return fallbackRows[0].amount_rp;
    }

    return DEFAULT_FIXED_COST_RP;
  } catch {
    return DEFAULT_FIXED_COST_RP;
  }
}

export async function setMonthlyFixedCost(
  sql: Sql,
  monthStr: string,
  amountRp: number,
  note?: string,
): Promise<void> {
  await sql`
    INSERT INTO monthly_fixed_cost (effective_month, amount_rp, note, updated_at)
    VALUES (${monthStr}, ${amountRp}, ${note ?? 'Biaya tetap bulanan (listrik + gas)'}, now())
    ON CONFLICT (effective_month) DO UPDATE
      SET amount_rp = EXCLUDED.amount_rp,
          note = COALESCE(EXCLUDED.note, monthly_fixed_cost.note),
          updated_at = now()
  `;
}
