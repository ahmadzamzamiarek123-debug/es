// Skeleton global: tampil INSTAN saat pindah halaman, sementara server
// component halaman tujuan masih mengambil data dari Neon. Ini yang membuat
// navigasi terasa responsif walau query butuh ~ratusan ms.
export default function Loading() {
  return (
    <div className="app">
      <header className="hero" aria-busy="true">
        <div className="hi-row">
          <div>
            <p className="hi-hello">Memuat…</p>
            <p className="hi-name">Es Lilin 🧊</p>
          </div>
          <div className="ava">🧊</div>
        </div>
        <p className="kas-label">&nbsp;</p>
        <p className="kas-val skeleton-line" style={{ width: 160 }}>
          &nbsp;
        </p>
      </header>
      <div className="wrap">
        <div className="grid">
          {[0, 1, 2, 3].map((i) => (
            <div className="stat" key={i}>
              <div className="ic b-blue">⏳</div>
              <p className="t skeleton-line" style={{ width: 80 }}>
                &nbsp;
              </p>
              <p className="v skeleton-line" style={{ width: 110 }}>
                &nbsp;
              </p>
            </div>
          ))}
        </div>
        <div className="card">
          <p className="ct skeleton-line" style={{ width: 120 }}>
            &nbsp;
          </p>
          <div className="skeleton-block" />
        </div>
      </div>
    </div>
  );
}
