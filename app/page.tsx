// Dashboard (server component).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkToken, AUTH_COOKIE } from "@/lib/auth";
import { parsePeriod, periodRange, type Period } from "@/lib/dates";
import {
  getSummary,
  getDailyOmzet,
  getSalesByCanteen,
  getExpenseComposition,
  getNeedsCheck,
  getRecentTransactions,
  getLocationLabels,
  labelOf,
} from "@/lib/reports";
import { rp, rpk } from "@/lib/format";
import { OmzetArea, KantinBars, ExpenseDonut } from "@/components/charts";
import { BottomNav, IceLogout } from "@/components/nav";

export const dynamic = "force-dynamic";

const PERIOD_LABEL: Record<Period, string> = {
  hari: "Hari ini",
  minggu: "7 hari",
  bulan: "Bulan ini",
};

const TX_ICON: Record<string, { ic: string; bg: string; color: string }> = {
  sale: { ic: "💵", bg: "#e6f4ec", color: "#2fa36b" },
  cash_in: { ic: "💰", bg: "#e7f1fe", color: "#2b6fd6" },
  cash_out: { ic: "🧾", bg: "#fbeedd", color: "#d5803b" },
  stock_movement: { ic: "🔁", bg: "#eeeafb", color: "#7a69d9" },
  production: { ic: "🧊", bg: "#e7f1fe", color: "#2b6fd6" },
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const jar = await cookies();
  if (!checkToken(jar.get(AUTH_COOKIE)?.value)) redirect("/login");

  const { p } = await searchParams;
  const period = parsePeriod(p);
  const { start, end } = periodRange(period);

  const [summary, daily, byCanteen, expenses, needsCheck, recent, labels] =
    await Promise.all([
      getSummary(start, end),
      getDailyOmzet(start, end),
      getSalesByCanteen(start, end),
      getExpenseComposition(start, end),
      getNeedsCheck(start, end),
      getRecentTransactions(start, end, 8),
      getLocationLabels(),
    ]);

  const flagged = needsCheck.filter((c) => c.selisih > 0 && c.omzet > 0);

  return (
    <div className="app">
      {/* HERO */}
      <header className="hero">
        <div className="hi-row">
          <div>
            <p className="hi-hello">Halo,</p>
            <p className="hi-name">Zummy 👋</p>
          </div>
          <IceLogout />
        </div>
        <p className="kas-label">Kas tersisa · {PERIOD_LABEL[period]}</p>
        <p className="kas-val">{rp(summary.kasTersisa)}</p>
        <span className="kas-sub">
          ✨ Laba bersih {rp(summary.labaBersih)} ({summary.marginBersihPercent}%) · HPP {rp(summary.hppPerPcs)}/pcs
        </span>
      </header>

      {/* SEGMENT periode */}
      <div className="seg">
        {(["hari", "minggu", "bulan"] as Period[]).map((pp) => (
          <a key={pp} href={`/?p=${pp}`} className={pp === period ? "on" : ""}>
            {PERIOD_LABEL[pp]}
          </a>
        ))}
      </div>

      <div className="wrap">
        {/* STAT GRID */}
        <div className="grid">
          <div className="stat">
            <div className="ic b-blue">💵</div>
            <p className="t">Omzet</p>
            <p className="v">{rp(summary.omzet)}</p>
          </div>
          <div className="stat">
            <div className="ic b-green">📈</div>
            <p className="t">Laba Bersih</p>
            <p className="v">{rp(summary.labaBersih)}</p>
          </div>
          <div className="stat">
            <div className="ic b-orange">🧊</div>
            <p className="t">Laba Kotor</p>
            <p className="v">{rp(summary.labaKotor)}</p>
          </div>
          <div className="stat">
            <div className="ic b-grape">🏦</div>
            <p className="t">Pengambilan</p>
            <p className="v">{rp(summary.pengambilan)}</p>
          </div>
        </div>

        {/* ALERT perlu dicek */}
        {flagged.length > 0 && (
          <div className="alert">
            <div className="ai">⚠️</div>
            <p>
              <b>Perlu dicek:</b> ada kantin dengan penjualan lebih besar dari kas
              yang masuk (mungkin belum dibayar):{" "}
              {flagged
                .map((c) => `${labelOf(c.canteen, labels)} (${rpk(c.selisih)})`)
                .join(", ")}
              . Lihat detail di{" "}
              <a href="/transaksi" style={{ color: "#5e3e14", fontWeight: 700 }}>
                Transaksi
              </a>
              .
            </p>
          </div>
        )}

        {/* OMZET AREA */}
        <div className="card">
          <p className="ct">Tren omzet</p>
          <p className="cs">Total penjualan per hari · {PERIOD_LABEL[period]}</p>
          <OmzetArea data={daily} />
        </div>

        {/* PER KANTIN */}
        <div className="card">
          <p className="ct">Penjualan per kantin</p>
          <p className="cs">Kontribusi tiap lokasi</p>
          <KantinBars data={byCanteen} labels={labels} />
        </div>

        {/* KOMPOSISI BIAYA */}
        <div className="card">
          <p className="ct">Komposisi biaya operasional & upah</p>
          <p className="cs">Rincian beban biaya</p>
          <ExpenseDonut data={expenses} />
        </div>

        {/* TRANSAKSI TERBARU */}
        <div className="sec-h">
          <h3>Transaksi terbaru</h3>
          <a className="link" href="/transaksi">
            Lihat semua
          </a>
        </div>
        <div className="card" style={{ marginTop: 0 }}>
          {recent.length === 0 && (
            <p className="empty">Belum ada transaksi pada periode ini.</p>
          )}
          {recent.map((t) => {
            const style = TX_ICON[t.kind]!;
            const sign =
              t.direction === "in" ? "+" : t.direction === "out" ? "−" : "";
            const color =
              t.direction === "in"
                ? "#2fa36b"
                : t.direction === "out"
                  ? "#e5615a"
                  : "#6b7385";
            return (
              <div className="tx" key={`${t.kind}-${t.id}`}>
                <div
                  className="ti"
                  style={{ background: style.bg, color: style.color }}
                >
                  {style.ic}
                </div>
                <div className="tm">
                  <b>
                    {t.title}
                    <span className="tag tid">#{t.id}</span>
                    {t.kind === "stock_movement" && (
                      <span className="tag mut">mutasi</span>
                    )}
                  </b>
                  <span>
                    {t.detail} · {t.date}
                  </span>
                </div>
                <div className="tv" style={{ color }}>
                  {t.amount === null ? "—" : `${sign}${rp(t.amount)}`}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <BottomNav />
    </div>
  );
}
