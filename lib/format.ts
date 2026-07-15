/**
 * Format tampilan angka rupiah. Meniru helper `rp`/`rpk` di mockup.
 * Semua input = integer rupiah (tanpa desimal).
 */

/** "Rp90.000" — format penuh dengan pemisah ribuan Indonesia. */
export function rp(n: number): string {
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

/** Alias eksplisit untuk pemakaian di bot (ringkasan konfirmasi). */
export const formatRupiah = rp;

/** "Rp90rb" / "Rp1,2jt" — ringkas untuk kartu & grafik. */
export function rpk(n: number): string {
  const x = Math.round(n);
  if (x >= 1_000_000) {
    const jt = x / 1_000_000;
    // Tampilkan 1 desimal hanya kalau tidak bulat.
    return 'Rp' + jt.toFixed(x % 1_000_000 ? 1 : 0).replace('.', ',') + 'jt';
  }
  if (x >= 1000) {
    return 'Rp' + Math.round(x / 1000) + 'rb';
  }
  return 'Rp' + x;
}
