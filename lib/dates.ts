// Helper tanggal dengan zona waktu Asia/Jakarta (WIB, UTC+7).
// Semua tanggal domain disimpan sebagai string 'YYYY-MM-DD' agar cocok dengan
// kolom Postgres `date` dan tidak terpengaruh offset server (Vercel = UTC).

const JAKARTA_TZ = "Asia/Jakarta";

/**
 * Kembalikan tanggal hari ini menurut zona Asia/Jakarta sebagai 'YYYY-MM-DD'.
 * Memakai Intl agar benar walau server berjalan di UTC.
 */
export function todayJakarta(): string {
  const now = new Date();
  return formatJakarta(now);
}

/** Format sebuah Date ke 'YYYY-MM-DD' menurut zona Asia/Jakarta. */
export function formatJakarta(d: Date): string {
  // en-CA menghasilkan format 'YYYY-MM-DD' yang stabil.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: JAKARTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

/**
 * Tanggal N hari yang lalu (menurut Asia/Jakarta) sebagai 'YYYY-MM-DD'.
 * daysAgo=1 → kemarin.
 */
export function daysAgoJakarta(daysAgo: number): string {
  const now = new Date();
  // Kurangi dalam satuan milidetik; cukup akurat untuk pergeseran hari
  // karena kita format ulang lewat zona Jakarta di bawah.
  const shifted = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return formatJakarta(shifted);
}

/**
 * Terjemahkan kata tanggal bebas menjadi 'YYYY-MM-DD' (Asia/Jakarta).
 * Mendukung: "hari ini", "kemarin", "lusa kemarin"/"kemarin lusa" (2 hari lalu).
 * Jika sudah berupa 'YYYY-MM-DD' valid, dikembalikan apa adanya.
 * Jika tidak dikenali → null (pemanggil putuskan default/errornya).
 */
export function resolveDateWord(input: string | null | undefined): string | null {
  if (!input) return todayJakarta();
  const s = input.trim().toLowerCase();

  if (s === "" || s === "hari ini" || s === "sekarang") return todayJakarta();
  if (s === "kemarin") return daysAgoJakarta(1);
  // ASUMSI: "kemarin lusa" / "lusa kemarin" = 2 hari yang lalu (lazim di percakapan).
  if (s === "kemarin lusa" || s === "lusa kemarin") return daysAgoJakarta(2);

  // Sudah format ISO date?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Validasi ringan bahwa tanggalnya nyata (mis. tolak 2026-13-40).
    // Regex di atas menjamin ketiga bagian ada; Number() aman.
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    ) {
      return s;
    }
    return null;
  }

  return null;
}

/** Awal & akhir bulan (inklusif) untuk sebuah 'YYYY-MM' → dipakai laporan. */
export function monthRange(yearMonth: string): { start: string; end: string } {
  const parts = yearMonth.split("-").map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const yy = y.toString().padStart(4, "0");
  const mm = m.toString().padStart(2, "0");
  const start = `${yy}-${mm}-01`;
  // Hari terakhir bulan: day 0 bulan berikutnya.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${yy}-${mm}-${lastDay.toString().padStart(2, "0")}`;
  return { start, end };
}

/** Bulan berjalan menurut Asia/Jakarta sebagai 'YYYY-MM'. */
export function currentMonthJakarta(): string {
  return todayJakarta().slice(0, 7);
}

export type Period = "hari" | "minggu" | "bulan";

/**
 * Rentang tanggal [start, end] (inklusif, 'YYYY-MM-DD') untuk periode dashboard
 * relatif hari ini (Asia/Jakarta):
 *   - hari   : hari ini saja
 *   - minggu : 7 hari terakhir (termasuk hari ini)
 *   - bulan  : bulan berjalan (tanggal 1 s/d hari ini)
 */
export function periodRange(period: Period): { start: string; end: string } {
  const end = todayJakarta();
  if (period === "hari") return { start: end, end };
  if (period === "minggu") return { start: daysAgoJakarta(6), end };
  // bulan berjalan: dari tanggal 1 s/d hari ini
  return { start: `${end.slice(0, 7)}-01`, end };
}

/** Validasi & normalisasi string periode dari query (?p=). Default 'bulan'. */
export function parsePeriod(input: string | null | undefined): Period {
  if (input === "hari" || input === "minggu" || input === "bulan") return input;
  return "bulan";
}

/**
 * Pindai KALIMAT bebas untuk kata tanggal relatif ("kemarin", "kemarin lusa")
 * atau tanggal ISO eksplisit, dan kembalikan 'YYYY-MM-DD' (Asia/Jakarta).
 * Berbeda dari resolveDateWord yang menormalkan satu token: fungsi ini dipakai
 * parser regex yang menerima seluruh pesan. Mengembalikan null bila tak ada
 * penanda tanggal — pemanggil pakai default hari ini.
 */
export function resolveRelativeDate(message: string): string | null {
  const s = message.toLowerCase();
  if (/\bkemarin\s+lusa\b|\blusa\s+kemarin\b/.test(s)) return daysAgoJakarta(2);
  if (/\bkemarin\b/.test(s)) return daysAgoJakarta(1);
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return resolveDateWord(iso[1]);
  return null;
}
