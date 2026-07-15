// Halaman Laporan bulanan (server component, read-only).
// Tabel: omzet → biaya (pengeluaran + upah) → laba usaha → pengambilan →
// kas tersisa, untuk bulan yang dipilih. Bisa export CSV.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkToken, AUTH_COOKIE } from "@/lib/auth";
import { monthRange, currentMonthJakarta } from "@/lib/dates";
import { getSummary } from "@/lib/reports";
import { rp } from "@/lib/format";
import { BottomNav } from "@/components/nav";

export const dynamic = "force-dynamic";

/** Validasi 'YYYY-MM'; kalau tak valid → bulan berjalan. */
function parseMonth(input: string | undefined): string {
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const m = Number(input.slice(5, 7));
    if (m >= 1 && m <= 12) return input;
  }
  return currentMonthJakarta();
}

/** Geser 'YYYY-MM' sebanyak delta bulan. */
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = (y as number) * 12 + (m as number) - 1 + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny.toString().padStart(4, "0")}-${nm.toString().padStart(2, "0")}`;
}

const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_NAMES[(m as number) - 1]} ${y}`;
}

export default async function LaporanPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const jar = await cookies();
  if (!checkToken(jar.get(AUTH_COOKIE)?.value)) redirect("/login");

  const { m } = await searchParams;
  const month = parseMonth(m);
  const { start, end } = monthRange(month);
  const s = await getSummary(start, end);

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const thisMonth = currentMonthJakarta();

  // Baris laporan sesuai rumus PROJECT.md §2.
  const rows: { label: string; value: number; kind: "in" | "out" | "sum" | "draw" }[] = [
    { label: "Omzet (total penjualan)", value: s.omzet, kind: "in" },
    { label: "Pengeluaran usaha", value: -s.pengeluaran, kind: "out" },
    { label: "Upah produksi", value: -s.upah, kind: "out" },
    { label: "Laba usaha", value: s.labaUsaha, kind: "sum" },
    { label: "Pengambilan (owner draw / SPP)", value: -s.pengambilan, kind: "draw" },
    { label: "Kas tersisa", value: s.kasTersisa, kind: "sum" },
  ];

  return (
    <div className="app">
      <header className="page-hd">
        <h1>Laporan bulanan</h1>
        <p>{monthLabel(month)}</p>
      </header>

      <div className="wrap">
        {/* Navigasi bulan */}
        <div className="month-nav">
          <a href={`/laporan?m=${prev}`} className="mbtn">
            ‹ {monthLabel(prev)}
          </a>
          {month !== thisMonth ? (
            <a href={`/laporan?m=${next}`} className="mbtn">
              {monthLabel(next)} ›
            </a>
          ) : (
            <span className="mbtn disabled">bulan ini</span>
          )}
        </div>

        {/* Kartu kas tersisa */}
        <div className="card report-hero">
          <p className="cs">Kas tersisa {monthLabel(month)}</p>
          <p className="report-kas">{rp(s.kasTersisa)}</p>
          <p className="cs">
            Laba usaha {rp(s.labaUsaha)} − pengambilan {rp(s.pengambilan)}
          </p>
        </div>

        {/* Tabel rincian */}
        <div className="card" style={{ marginTop: 12 }}>
          <table className="report-tbl">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className={r.kind === "sum" ? "sum" : ""}>
                  <td>{r.label}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        r.value < 0
                          ? "#e5615a"
                          : r.kind === "sum"
                            ? "#0f7db8"
                            : "#2fa36b",
                    }}
                  >
                    {r.value < 0 ? `−${rp(-r.value)}` : rp(r.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Insight */}
        <div className="alert" style={{ marginTop: 12 }}>
          <div className="ai">💡</div>
          <p>
            Laba usaha bisa <b>positif</b> tapi kas terasa habis karena{" "}
            <b>pengambilan</b> ({rp(s.pengambilan)}) menyedot laba. Itu bukan
            kerugian — uang MTS2 masuk tabungan SPP lewat Ayah.
          </p>
        </div>

        {/* Export CSV */}
        <a href={`/laporan/export?m=${month}`} className="btn-export">
          ⬇️ Export CSV
        </a>
      </div>

      <BottomNav />
    </div>
  );
}
