// Proteksi dashboard: login password sederhana → cookie httpOnly.
// Dashboard menampilkan keuangan usaha, jadi tidak boleh publik (CLAUDE.md §2).
// Ini lapis pertama; role web_reader (SELECT saja) adalah lapis kedua.
//
// ASUMSI: satu password (DASHBOARD_PASSWORD) untuk pemilik. Token cookie =
// HMAC-SHA256 dari penanda tetap dengan kunci password, jadi tidak menyimpan
// password mentah di cookie & tidak butuh tabel sesi. Untuk skala pribadi ini
// memadai; dicatat di README bagian "Perlu dikonfirmasi user".

import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_COOKIE } from "./auth-shared";

const TOKEN_MESSAGE = "es-lilin-dashboard-v1";

function requirePassword(): string {
  const p = process.env.DASHBOARD_PASSWORD;
  if (!p) throw new Error("DASHBOARD_PASSWORD belum diset");
  return p;
}

/** Token deterministik dari password (bukan password mentah). */
export function makeToken(): string {
  return createHmac("sha256", requirePassword())
    .update(TOKEN_MESSAGE)
    .digest("hex");
}

/** Bandingkan dua string secara timing-safe (hindari kebocoran lewat waktu). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Verifikasi password login. */
export function checkPassword(input: string): boolean {
  return safeEqual(input, requirePassword());
}

/** Verifikasi nilai cookie sesi. */
export function checkToken(token: string | undefined): boolean {
  if (!token) return false;
  try {
    return safeEqual(token, makeToken());
  } catch {
    return false;
  }
}

export { AUTH_COOKIE };
