// Export laporan bulanan sebagai CSV. Read-only (web_reader) + butuh cookie auth.
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
    ["Laporan Finansial Es Lilin", month],
    ["Komponen", "Nilai / Rupiah", "Keterangan"],
    ["Omzet Penjualan", s.omzet, "Total revenue"],
    ["Total Resep Diproduksi", s.totalRecipes, "Resep"],
    ["Total Biji Es Diproduksi", s.totalPiecesProduced, "Pcs"],
    ["Biaya Bahan Baku Terpakai", s.totalBahan, "HPP bahan"],
    ["Upah Produksi", s.upahProduksi, "Upah variabel pekerja"],
    ["Laba Kotor", s.labaKotor, `Margin Kotor ${s.marginKotorPercent}%`],
    ["Biaya Tetap (Listrik + Gas)", s.biayaTetap, "Flat bulanan"],
    ["Biaya Operasional Lain", s.pengeluaranOperasionalLain, "Transport dll"],
    ["Laba Bersih", s.labaBersih, `Margin Bersih ${s.marginBersihPercent}%`],
    ["Laba Usaha (Transisi Lama)", s.labaUsaha, "Omzet - cashout - upah"],
    ["Saldo Awal Modal", s.saldoAwal, "Baseline modal"],
    ["Pengambilan (Owner Draw / SPP)", s.pengambilan, "Penarikan kas pribadi"],
    ["Kas Tersisa", s.kasTersisa, "Posisi kas akhir"],
    ["HPP per Pcs Standar", s.hppPerPcs, "Rp per biji"],
  ];
  const csv = lines.map((row) => row.map(csvCell).join(",")).join("\r\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="laporan-lengkap-${month}.csv"`,
    },
  });
}
