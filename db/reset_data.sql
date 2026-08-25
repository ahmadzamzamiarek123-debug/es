-- ============================================================================
-- Es Lilin Tracker — RESET DATA (mulai dari nol)
-- Jalankan di Neon SQL editor dengan role OWNER.
--
-- APA YANG DILAKUKAN:
--   Mengosongkan SEMUA baris di tabel transaksi + reset counter id ke 1.
--   Struktur (tabel, kolom, role, kolom generated) TIDAK diubah — jadi bot &
--   web tetap jalan tanpa setup ulang.
--
--   TIDAK ikut dihapus (sengaja):
--     - location_ref  : konfigurasi kantin/sekolah + harga (dari /setting).
--     - opening_balance : saldo awal / modal (baseline, one-time).
--   Kalau memang mau ikut mengosongkan keduanya, lihat blok opsional di bawah.
--
-- ⚠️ PERINGATAN: ini MENGHAPUS SEMUA DATA transaksi secara permanen &
--    tidak bisa di-undo. Pastikan memang mau mulai dari nol.
--
-- CATATAN: jalankan migrasi 0003–0008 LEBIH DULU (sekali saja) untuk membuat
--    kolom worker/wage, tabel pending_confirm, memperbaiki overflow total_rp,
--    tabel location_ref, konversi lokasi ke text, upah 5.000/orang, dan tabel
--    opening_balance. Skrip ini boleh dijalankan berkali-kali kapan pun kamu
--    ingin membersihkan data transaksi lagi.
-- ============================================================================

TRUNCATE
  production,
  production_worker,
  stock_movement,
  sale,
  cash_in,
  cash_out,
  pending_confirm
RESTART IDENTITY;

-- OPSIONAL — reset penuh (hapus juga konfigurasi lokasi & saldo awal).
-- Buka komentar hanya bila memang ingin mengulang /setting dari nol.
-- Catatan: location_ref di-seed hanya 'rumah' oleh migrasi; kantin/sekolah
-- diisi ulang lewat /setting. opening_balance kembali kosong (saldo awal 0).
--   DELETE FROM opening_balance;
--   DELETE FROM location_ref WHERE is_warehouse = false;

-- Verifikasi (harus semua 0):
SELECT
  (SELECT count(*) FROM production)     AS production,
  (SELECT count(*) FROM stock_movement) AS stock_movement,
  (SELECT count(*) FROM sale)           AS sale,
  (SELECT count(*) FROM cash_in)        AS cash_in,
  (SELECT count(*) FROM cash_out)       AS cash_out,
  (SELECT count(*) FROM pending_confirm) AS pending_confirm;
