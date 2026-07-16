// Export laporan bulanan sebagai CSV. Read-only (web_reader) + butuh cookie auth.
// Angka = integer rupiah. Tidak mengeluarkan detail DB/stack.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { checkToken, AUTH_COOKIE } from "@/lib/auth";
import { monthRange, currentMonthJakarta } from "@/lib/dates";
import { getSummary } from "@/lib/reports";

export const dynamic = "force-dynamic";

function parseMonth(input: string | null): string {
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const m = Number(input.slice(5, 7));
    if (m >= 1 && m <= 12) return input;
  }
  return currentMonthJakarta();
}

/**
 * Escape sel CSV. Selain quoting biasa, cegah CSV injection: sel yang diawali
 * = + - @ diberi prefix kutip tunggal agar tak dieksekusi Excel/Sheets.
 */
function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: Request) {
  const jar = await cookies();
  if (!checkToken(jar.get(AUTH_COOKIE)?.value)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const month = parseMonth(url.searchParams.get("m"));
  const { start, end } = monthRange(month);
  const s = await getSummary(start, end);

  const lines = [
    ["Laporan Es Lilin", month],
    ["Komponen", "Rupiah"],
    ["Omzet", s.omzet],
    ["Pengeluaran usaha", s.pengeluaran],
    ["Upah Zummy", s.upahZummy],
    ["Upah Aril", s.upahAril],
    ["Upah produksi (total)", s.upah],
    ["Laba usaha", s.labaUsaha],
    ["Pengambilan", s.pengambilan],
    ["Kas tersisa", s.kasTersisa],
  ];
  const csv = lines.map((row) => row.map(csvCell).join(",")).join("\r\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="laporan-${month}.csv"`,
    },
  });
}
