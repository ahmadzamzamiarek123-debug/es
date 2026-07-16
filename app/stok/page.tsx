// Halaman Stok (server component, read-only).
// Produksi hari ini/kemarin, es keluar hari ini, dan sisa stok per lokasi.
// SMA & SMK memakai model batch 50 → stok fisik TIDAK dilacak (CLAUDE.md §3),
// jadi hanya ditampilkan sebagai badge informasi.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkToken, AUTH_COOKIE } from "@/lib/auth";
import { todayJakarta, daysAgoJakarta } from "@/lib/dates";
import { getStockReport } from "@/lib/reports";
import { BottomNav, IceLogout } from "@/components/nav";

export const dynamic = "force-dynamic";

const LOC_LABEL: Record<string, string> = {
  rumah: "Rumah (gudang)",
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
};

const LOC_ICON: Record<string, string> = {
  rumah: "🏠",
  mts1: "🏫",
  mts2: "🏫",
  smp: "🏫",
};

export default async function StokPage() {
  const jar = await cookies();
  if (!checkToken(jar.get(AUTH_COOKIE)?.value)) redirect("/login");

  const today = todayJakarta();
  const yesterday = daysAgoJakarta(1);
  const report = await getStockReport(today, yesterday);

  const totalSisa = report.stocks.reduce((a, s) => a + s.sisa, 0);

  return (
    <div className="app">
      <header className="hero">
        <div className="hi-row">
          <div>
            <p className="hi-hello">Stok</p>
            <p className="hi-name">Es Lilin 🧊</p>
          </div>
          <IceLogout />
        </div>
        <p className="kas-label">Total sisa stok (di luar SMA/SMK)</p>
        <p className="kas-val">{totalSisa} biji</p>
        <span className="kas-sub">
          🧊 Produksi hari ini {report.prodToday.pieces} biji
        </span>
      </header>

      <div className="wrap">
        {/* PRODUKSI & KELUAR */}
        <div className="grid">
          <div className="stat">
            <div className="ic b-blue">🧊</div>
            <p className="t">Produksi hari ini</p>
            <p className="v">
              {report.prodToday.recipes} resep · {report.prodToday.pieces} biji
            </p>
          </div>
          <div className="stat">
            <div className="ic b-grape">🗓️</div>
            <p className="t">Produksi kemarin</p>
            <p className="v">
              {report.prodYesterday.recipes} resep · {report.prodYesterday.pieces} biji
            </p>
          </div>
          <div className="stat">
            <div className="ic b-orange">🚚</div>
            <p className="t">Keluar hari ini</p>
            <p className="v">{report.keluarToday} biji</p>
          </div>
          <div className="stat">
            <div className="ic b-green">📦</div>
            <p className="t">Total sisa</p>
            <p className="v">{totalSisa} biji</p>
          </div>
        </div>

        {/* SISA PER LOKASI */}
        <div className="card">
          <p className="ct">Sisa stok per lokasi</p>
          <p className="cs">masuk − keluar − terjual (sepanjang waktu)</p>
          {report.stocks.map((s) => (
            <div className="tx" key={s.loc}>
              <div className="ti" style={{ background: "#e7f1fe", color: "#2b6fd6" }}>
                {LOC_ICON[s.loc] ?? "📦"}
              </div>
              <div className="tm">
                <b>{LOC_LABEL[s.loc] ?? s.loc}</b>
                <span>
                  masuk {s.masuk} · keluar {s.keluar}
                  {s.terjual > 0 ? ` · terjual ${s.terjual}` : ""}
                </span>
              </div>
              <div className="tv" style={{ color: s.sisa < 0 ? "#e5615a" : "#1c2230" }}>
                {s.sisa} biji
              </div>
            </div>
          ))}
          <div className="tx">
            <div className="ti" style={{ background: "#eeeafb", color: "#7a69d9" }}>🧺</div>
            <div className="tm">
              <b>
                SMA &amp; SMK
                <span className="tag mut">batch 50</span>
              </b>
              <span>stok fisik tidak dilacak — penjualan kelipatan 50</span>
            </div>
            <div className="tv" style={{ color: "#6b7385" }}>—</div>
          </div>
          {report.stocks.some((s) => s.sisa < 0) && (
            <p className="empty" style={{ color: "#e5615a" }}>
              ⚠️ Ada lokasi dengan stok minus — kemungkinan ada input yang
              terlewat/salah. Cek `transaksi terakhir` di bot lalu ralat dengan
              `ubah`/`hapus`.
            </p>
          )}
        </div>
      </div>

      <BottomNav />
    </div>
  );
}
