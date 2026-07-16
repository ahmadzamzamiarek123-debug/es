// Halaman Transaksi (server component, read-only).
// Menampilkan daftar gabungan 5 tabel + filter periode, dan view "Perlu dicek"
// (omzet vs kas masuk per kantin). Auth digerbang di sini juga.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkToken, AUTH_COOKIE } from "@/lib/auth";
import { parsePeriod, periodRange, type Period } from "@/lib/dates";
import { getRecentTransactions, getNeedsCheck } from "@/lib/reports";
import { rp, rpk } from "@/lib/format";
import { BottomNav } from "@/components/nav";

export const dynamic = "force-dynamic";

const LOC_LABEL: Record<string, string> = {
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
  sma: "SMA",
  smk: "SMK",
};

const PERIOD_LABEL: Record<Period, string> = {
  hari: "Hari ini",
  minggu: "7 hari",
  bulan: "Bulan ini",
};

const KIND_LABEL: Record<string, string> = {
  sale: "Penjualan",
  cash_in: "Kas masuk",
  cash_out: "Kas keluar",
  stock_movement: "Mutasi",
  production: "Produksi",
};

const TX_ICON: Record<string, { ic: string; bg: string; color: string }> = {
  sale: { ic: "💵", bg: "#e6f4ec", color: "#2fa36b" },
  cash_in: { ic: "💰", bg: "#e7f1fe", color: "#2b6fd6" },
  cash_out: { ic: "🧾", bg: "#fbeedd", color: "#d5803b" },
  stock_movement: { ic: "🔁", bg: "#eeeafb", color: "#7a69d9" },
  production: { ic: "🧊", bg: "#e7f1fe", color: "#2b6fd6" },
};

const KIND_FILTERS = [
  ["all", "Semua"],
  ["sale", "Jual"],
  ["cash_in", "Kas +"],
  ["cash_out", "Kas −"],
  ["stock_movement", "Mutasi"],
  ["production", "Produksi"],
] as const;

export default async function TransaksiPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; k?: string }>;
}) {
  const jar = await cookies();
  if (!checkToken(jar.get(AUTH_COOKIE)?.value)) redirect("/login");

  const { p, k } = await searchParams;
  const period = parsePeriod(p);
  const kind = k ?? "all";
  const { start, end } = periodRange(period);

  const [all, needsCheck] = await Promise.all([
    getRecentTransactions(start, end, 200),
    getNeedsCheck(start, end),
  ]);

  const rows = kind === "all" ? all : all.filter((t) => t.kind === kind);
  const flagged = needsCheck.filter((c) => c.selisih > 0 && c.omzet > 0);

  return (
    <div className="app">
      <header className="page-hd">
        <h1>Transaksi</h1>
        <p>Riwayat gabungan semua catatan</p>
      </header>

      <div className="wrap">
        {/* Filter periode */}
        <div className="seg seg-inline">
          {(["hari", "minggu", "bulan"] as Period[]).map((pp) => (
            <a
              key={pp}
              href={`/transaksi?p=${pp}&k=${kind}`}
              className={pp === period ? "on" : ""}
            >
              {PERIOD_LABEL[pp]}
            </a>
          ))}
        </div>

        {/* Filter jenis */}
        <div className="chips">
          {KIND_FILTERS.map(([key, label]) => (
            <a
              key={key}
              href={`/transaksi?p=${period}&k=${key}`}
              className={`chip ${key === kind ? "on" : ""}`}
            >
              {label}
            </a>
          ))}
        </div>

        {/* Perlu dicek */}
        {flagged.length > 0 && (
          <>
            <div className="sec-h">
              <h3>Perlu dicek</h3>
            </div>
            <div className="card" style={{ marginTop: 0 }}>
              <p className="cs" style={{ marginBottom: 10 }}>
                Kantin dengan penjualan &gt; kas masuk pada periode ini. Wajar
                untuk SMA/SMK (bayar menyusul), tapi cek agar tidak terlewat.
              </p>
              {flagged.map((c) => (
                <div className="tx" key={c.canteen}>
                  <div className="ti" style={{ background: "#fdeede" }}>
                    👁️
                  </div>
                  <div className="tm">
                    <b>{LOC_LABEL[c.canteen]}</b>
                    <span>
                      Omzet {rpk(c.omzet)} · masuk {rpk(c.kasMasuk)}
                    </span>
                  </div>
                  <div className="tv" style={{ color: "#e08a2b" }}>
                    {rp(c.selisih)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Daftar transaksi */}
        <div className="sec-h">
          <h3>{KIND_LABEL[kind] ?? "Semua"}</h3>
          <span className="link">{rows.length} baris</span>
        </div>
        <div className="card" style={{ marginTop: 0 }}>
          {rows.length === 0 && (
            <p className="empty">Tidak ada transaksi pada filter ini.</p>
          )}
          {rows.map((t) => {
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
                    {t.kind === "stock_movement" && (
                      <span className="tag mut">mutasi</span>
                    )}
                  </b>
                  <span>
                    <code className="txid">#{t.id}</code> · {t.detail} · {t.date}
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
