"use client";

// Komponen grafik dashboard (client component) memakai Recharts.
// Gaya visual meniru design/ui-mockup.html: area omzet biru-mint, bar per
// kantin dengan warna khas, donut komposisi biaya. Data dilewatkan sebagai
// props dari server component (query DB terjadi di server, bukan di sini).

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
  Pie,
  PieChart,
} from "recharts";
import { rp, rpk } from "@/lib/format";

// Warna per kantin — samakan dengan K_COLORS di mockup.
const CANTEEN_COLORS: Record<string, string> = {
  mts1: "#3B82F6",
  mts2: "#8B7CE8",
  smp: "#3EC8C4",
  sma: "#2FA36B",
  smk: "#E08A2B",
};

// Palet donut biaya (mengikuti urutan warna mockup).
const EXPENSE_COLORS: Record<string, string> = {
  bahan: "#3B82F6",
  upah: "#8B7CE8",
  plastik: "#3EC8C4",
  gas_listrik: "#1AA0C4",
  transport: "#E08A2B",
  lainnya: "#E5615A",
};

const LOC_LABEL: Record<string, string> = {
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
  sma: "SMA",
  smk: "SMK",
};

const CAT_LABEL: Record<string, string> = {
  bahan: "Bahan",
  upah: "Upah",
  plastik: "Plastik",
  gas_listrik: "Gas/Listrik",
  transport: "Transport",
  lainnya: "Lainnya",
};

/** Area chart omzet harian. */
export function OmzetArea({ data }: { data: { date: string; total: number }[] }) {
  // Label sumbu-x: tanggal (DD) saja agar ringkas.
  const chartData = data.map((d) => ({
    label: d.date.slice(8, 10),
    total: d.total,
  }));

  if (chartData.length === 0) {
    return <p className="empty">Belum ada penjualan pada periode ini.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={150}>
      <AreaChart data={chartData} margin={{ top: 8, right: 6, left: 6, bottom: 0 }}>
        <defs>
          <linearGradient id="omzetGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3EC8C4" stopOpacity={0.38} />
            <stop offset="100%" stopColor="#3EC8C4" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 9.5, fill: "#6B7385" }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis hide domain={[0, "dataMax"]} />
        <Tooltip
          formatter={(v: number) => [rp(v), "Omzet"]}
          labelFormatter={(l) => `Tanggal ${l}`}
          contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #ECEEF2" }}
        />
        <Area
          type="monotone"
          dataKey="total"
          stroke="#0F7DB8"
          strokeWidth={2.6}
          fill="url(#omzetGrad)"
          dot={{ r: 2.4, fill: "#0F7DB8" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Bar per kantin — dibuat manual (bukan BarChart) agar sama persis dgn mockup. */
export function KantinBars({ data }: { data: { canteen: string; total: number }[] }) {
  if (data.length === 0) {
    return <p className="empty">Belum ada penjualan per kantin.</p>;
  }
  const max = Math.max(...data.map((d) => d.total), 1);
  return (
    <div className="bars">
      {data.map((d) => (
        <div className="bar-row" key={d.canteen}>
          <span className="nm">{LOC_LABEL[d.canteen] ?? d.canteen}</span>
          <div className="track">
            <div
              className="fill"
              style={{
                width: `${(d.total / max) * 100}%`,
                background: CANTEEN_COLORS[d.canteen] ?? "#3B82F6",
              }}
            />
          </div>
          <span className="amt">{rpk(d.total)}</span>
        </div>
      ))}
    </div>
  );
}

/** Donut komposisi biaya. */
export function ExpenseDonut({
  data,
}: {
  data: { category: string; total: number }[];
}) {
  const items = data.filter((d) => d.total > 0);
  const total = items.reduce((a, d) => a + d.total, 0);

  if (items.length === 0) {
    return <p className="empty">Belum ada pengeluaran pada periode ini.</p>;
  }

  return (
    <div className="donut-wrap">
      <div className="donut-c">
        <ResponsiveContainer width={120} height={120}>
          <PieChart>
            <Pie
              data={items}
              dataKey="total"
              nameKey="category"
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={58}
              paddingAngle={2}
              stroke="none"
            >
              {items.map((d) => (
                <Cell
                  key={d.category}
                  fill={EXPENSE_COLORS[d.category] ?? "#8B7CE8"}
                />
              ))}
            </Pie>
            <Tooltip formatter={(v: number) => rp(v)} />
          </PieChart>
        </ResponsiveContainer>
        <div className="mid">
          <b>{rpk(total)}</b>
          <span>keluar</span>
        </div>
      </div>
      <div className="legend">
        {items.map((d) => (
          <div className="lg" key={d.category}>
            <span
              className="dot"
              style={{ background: EXPENSE_COLORS[d.category] ?? "#8B7CE8" }}
            />
            {CAT_LABEL[d.category] ?? d.category}
            <span className="lv">{Math.round((d.total / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
