// Halaman Laporan bulanan (server component, read-only).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkToken, AUTH_COOKIE } from "@/lib/auth";
import { monthRange, currentMonthJakarta } from "@/lib/dates";
import { getSummary } from "@/lib/reports";
import { rp } from "@/lib/format";
import { BottomNav } from "@/components/nav";

export const dynamic = "force-dynamic";

function parseMonth(input: string | undefined): string {
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const m = Number(input.slice(5, 7));
    if (m >= 1 && m <= 12) return input;
  }
  return currentMonthJakarta();
}

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

  const reportSections = [
    {
      title: "1. Pendapatan & Biaya Variabel (HPP)",
      rows: [
        { label: "Omzet Penjualan", value: s.omzet, kind: "in" },
        { label: `Biaya Bahan Baku (${s.totalRecipes} resep / ${s.totalPiecesProduced} pcs)`, value: -s.totalBahan, kind: "out" },
        { label: "Upah Produksi", value: -s.upahProduksi, kind: "out" },
        { label: `Laba Kotor (Margin ${s.marginKotorPercent}%)`, value: s.labaKotor, kind: "sum" },
      ],
    },
    {
      title: "2. Biaya Tetap & Operasional",
      rows: [
        { label: "Biaya Tetap Bulanan (Listrik + Gas)", value: -s.biayaTetap, kind: "out" },
        { label: "Biaya Operasional Non-Bahan (Transport dll)", value: -s.pengeluaranOperasionalLain, kind: "out" },
        { label: `Laba Bersih (Margin ${s.marginBersihPercent}%)`, value: s.labaBersih, kind: "sum" },
      ],
    },
    {
      title: "3. Arus Kas & Saldo Modal",
      rows: [
        { label: "Saldo Awal (Modal Baseline)", value: s.saldoAwal, kind: "in" },
        { label: "Pengambilan Pribadi (Owner Draw)", value: -s.pengambilan, kind: "draw" },
        { label: "Kas Tersisa", value: s.kasTersisa, kind: "sum" },
      ],
    },
  ];

  return (
    <div className="app">
      <header className="page-hd">
        <h1>Laporan Keuangan & HPP</h1>
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

        {/* Ringkasan Finansial Hero */}
        <div className="card report-hero">
          <p className="cs">Laba Bersih {monthLabel(month)}</p>
          <p className="report-kas" style={{ color: s.labaBersih >= 0 ? "#2fa36b" : "#e5615a" }}>
            {rp(s.labaBersih)}
          </p>
          <p className="cs">
            Margin Bersih: <b>{s.marginBersihPercent}%</b> · HPP: <b>{rp(s.hppPerPcs)}/pcs</b>
          </p>
        </div>

        {/* Highlight Metrics Grid */}
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="stat">
            <p className="t">Omzet</p>
            <p className="v" style={{ fontSize: 16 }}>{rp(s.omzet)}</p>
          </div>
          <div className="stat">
            <p className="t">Laba Kotor</p>
            <p className="v" style={{ fontSize: 16, color: "#2fa36b" }}>{rp(s.labaKotor)}</p>
          </div>
          <div className="stat">
            <p className="t">Kas Tersisa</p>
            <p className="v" style={{ fontSize: 16, color: "#0f7db8" }}>{rp(s.kasTersisa)}</p>
          </div>
          <div className="stat">
            <p className="t">HPP / pcs</p>
            <p className="v" style={{ fontSize: 16 }}>{rp(s.hppPerPcs)}</p>
          </div>
        </div>

        {/* Tabel Rincian Keuangan */}
        {reportSections.map((sec, idx) => (
          <div className="card" style={{ marginTop: 12 }} key={idx}>
            <p className="ct" style={{ fontSize: 14, marginBottom: 8 }}>{sec.title}</p>
            <table className="report-tbl">
              <tbody>
                {sec.rows.map((r) => (
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
                        fontWeight: r.kind === "sum" ? "bold" : "normal",
                      }}
                    >
                      {r.value < 0 ? `−${rp(-r.value)}` : rp(r.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {/* Transisi Versi Lama & Insight */}
        <div className="alert" style={{ marginTop: 12 }}>
          <div className="ai">📊</div>
          <p>
            <b>Perbandingan Transisi:</b><br />
            • Laba Bersih Baru: <b>{rp(s.labaBersih)}</b> (memperhitungkan HPP resep & biaya tetap flat)<br />
            • Laba Usaha Lama: <b>{rp(s.labaUsaha)}</b> (omzet − kas keluar − upah)<br />
            • Pengambilan Owner: <b>{rp(s.pengambilan)}</b> (SPP ayah / prive)
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
