/**
 * Koneksi Neon lewat driver HTTP (@neondatabase/serverless) — aman untuk
 * serverless (tidak ada koneksi TCP long-running seperti `pg`).
 *
 * DUA koneksi role terpisah (least privilege):
 *   - dbBot : role bot_writer  (INSERT/SELECT/UPDATE/DELETE) — dipakai bot.
 *   - dbWeb : role web_reader  (SELECT saja)                 — dipakai web.
 *
 * Aturan: web TIDAK boleh mengimpor dbBot, dan bot TIDAK boleh menulis lewat dbWeb.
 * Semua query WAJIB berparameter (drizzle / tagged-template neon) — dilarang
 * menyambung string ke SQL.
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    // Pesan tanpa membocorkan nilai; hanya sebut nama variabel.
    throw new Error(`Environment variable ${name} belum di-set.`);
  }
  return v;
}

/**
 * Koneksi tulis (bot). Lazy: baru dibuat saat dipanggil, supaya modul web tidak
 * ikut menuntut DATABASE_URL_BOT ada.
 */
let _dbBot: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function getDbBot() {
  if (!_dbBot) {
    const sql = neon(requireEnv('DATABASE_URL_BOT'));
    _dbBot = drizzle(sql, { schema });
  }
  return _dbBot;
}

/**
 * Koneksi baca (web). Lazy juga.
 */
let _dbWeb: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function getDbWeb() {
  if (!_dbWeb) {
    const sql = neon(requireEnv('DATABASE_URL_WEB'));
    _dbWeb = drizzle(sql, { schema });
  }
  return _dbWeb;
}

/**
 * Akses SQL mentah berparameter untuk laporan (tagged template neon — tetap
 * aman dari injection). Memakai koneksi web_reader (read-only).
 */
let _sqlWeb: ReturnType<typeof neon> | null = null;
export function getSqlWeb() {
  if (!_sqlWeb) {
    _sqlWeb = neon(requireEnv('DATABASE_URL_WEB'));
  }
  return _sqlWeb;
}

/**
 * SQL mentah untuk BOT (jalur tanya laporan via chat). bot_writer memang punya
 * SELECT; tetap tagged template berparameter, tidak ada string-concat.
 */
let _sqlBot: ReturnType<typeof neon> | null = null;
export function getSqlBot() {
  if (!_sqlBot) {
    _sqlBot = neon(requireEnv('DATABASE_URL_BOT'));
  }
  return _sqlBot;
}

export { schema };
