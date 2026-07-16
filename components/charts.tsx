// Komponen grafik dashboard — SVG/CSS murni TANPA Recharts (dihapus demi
// bundel ringan; Recharts ~50kB+ gzip adalah penyumbang terbesar First Load).
// Semua komponen di file ini adalah SERVER component: tidak mengirim JS ke
// browser sama sekali. Gaya visual tetap meniru design/ui-mockup.html.

import { rp, rpk } from "@/lib/format";

// Warna per kantin — samakan dengan K_COLORS di mockup.
const CANTEEN_COLORS: Record<string, string> = {
  mts1: "#3B82F6",
  mts2: "#8B7CE8",
  smp: "#3EC8C4",
  sma: "#2FA36B",
  smk: "#E08A2B",
};

// Palet donut biaya (mengikuti urutan warna mockup + upah per orang).
const EXPENSE_COLORS: Record<string, string> = {
  bahan: "#3B82F6",
  "upah Zummy": "#8B7CE8",
  "upah Aril": "#B39DDB",
  plastik: "#3EC8C4",
  gas_listrik: "#1AA0C4",
  transport: "#E08A2B",
  spp_ayah: "#E5615A",
  lainnya: "#94A3B8",
};

const LOC_LABEL: Record<string, string> = {
  rumah: "Rumah",
  mts1: "MTS1",
  mts2: "MTS2",
  smp: "SMP",
  sma: "SMA",
  smk: "SMK",
};

const CAT_LABEL: Record<string, string> = {
  bahan: "Bahan",
  "upah Zummy": "Upah Zummy",
  "upah Aril": "Upah Aril",
  plastik: "Plastik",
  gas_listrik: "Gas/Listrik",
  transport: "Transport",
  spp_ayah: "SPP Ayah",
  lainnya: "Lainnya",
};

/**
 * Area chart omzet harian — SVG path statis yang dirender server.
 * Tanpa tooltip interaktif (nilai total sudah ada di kartu ringkasan).
 */
export function OmzetArea({ data }: { data: { date: string; total: number }[] }) {
  if (data.length === 0) {
    return <p className="empty">Belum ada penjualan pada periode ini.</p>;
  }

  const W = 320;
  const H = 150;
  const PAD = { top: 10, right: 8, bottom: 18, left: 8 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const max = Math.max(...data.map((d) => d.total), 1);
  const n = data.length;

  const px = (i: number) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const py = (v: number) => PAD.top + ih - (v / max) * ih;

  const points = data.map((d, i) => `${px(i).toFixed(1)},${py(d.total).toFixed(1)}`);
  const line = `M ${points.join(" L ")}`;
  const area = `${line} L ${px(n - 1).toFixed(1)},${(PAD.top + ih).toFixed(1)} L ${px(0).toFixed(1)},${(PAD.top + ih).toFixed(1)} Z`;

  // Label sumbu-x: maksimal ~6 label agar tidak bertumpuk.
  const step = Math.max(1, Math.ceil(n / 6));
  const labels = data
    .map((d, i) => ({ i, text: d.date.slice(8, 10) }))
    .filter(({ i }) => i % step === 0 || i === n - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Grafik omzet harian">
      <defs>
        <linearGradient id="omzetGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3EC8C4" stopOpacity="0.38" />
          <stop offset="100%" stopColor="#3EC8C4" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#omzetGrad)" />
      <path d={line} fill="none" stroke="#0F7DB8" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => (
        <circle key={d.date} cx={px(i)} cy={py(d.total)} r="2.4" fill="#0F7DB8" />
      ))}
      {labels.map(({ i, text }) => (
        <text key={i} x={px(i)} y={H - 4} textAnchor="middle" fontSize="9.5" fill="#6B7385">
          {text}
        </text>
      ))}
    </svg>
  );
}

/** Bar per kantin — CSS murni, sama seperti sebelumnya. */
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

/**
 * Donut komposisi biaya — SVG stroke-dasharray, dirender server.
 */
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

  // Donut via lingkaran ber-stroke: r=49 (keliling ≈ 307.9), tebal 18.
  const R = 49;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segs = items.map((d) => {
    const frac = d.total / total;
    const seg = { ...d, dash: frac * C, offset };
    offset += frac * C;
    return seg;
  });

  return (
    <div className="donut-wrap">
      <div className="donut-c">
        <svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Komposisi biaya">
          <g transform="rotate(-90 60 60)">
            {segs.map((s) => (
              <circle
                key={s.category}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                stroke={EXPENSE_COLORS[s.category] ?? "#8B7CE8"}
                strokeWidth="18"
                strokeDasharray={`${Math.max(s.dash - 2, 0.5)} ${C}`}
                strokeDashoffset={-s.offset}
              />
            ))}
          </g>
        </svg>
        <div className="mid">
          <b>{rpk(total)}</b>
          <span>keluar</span>
        </div>
      </div>
      <div className="legend">
        {items.map((d) => (
          <div className="lg" key={d.category} title={rp(d.total)}>
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
