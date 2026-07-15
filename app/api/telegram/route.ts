// Webhook Telegram — satu-satunya endpoint tulis.
//
// URUTAN KEAMANAN (WAJIB, sebelum menyentuh Gemini/DB):
//   1. Verifikasi header X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET.
//      Gagal → 401, berhenti. (Ini membuktikan request benar-benar dari Telegram
//      dengan secret yang hanya kita & Telegram tahu.)
//   2. Cek from.id == ALLOWED_TELEGRAM_ID. Bukan pemilik → abaikan diam-diam (200).
//   Baru setelah lolos keduanya, update diproses (parse → konfirmasi → insert).
//
// Selalu balas 200 untuk update yang sudah lolos auth walau pemrosesan gagal,
// supaya Telegram tidak retry berulang. Error internal tidak dibocorkan.

import { NextRequest, NextResponse } from "next/server";
import { webhookCallback } from "grammy";
import { getBot, getAllowedId, extractFromId } from "@/lib/telegram";

// Jalankan di Node.js runtime (butuh Buffer & driver Neon), bukan edge.
export const runtime = "nodejs";
// Jangan cache; tiap update unik.
export const dynamic = "force-dynamic";

// Bandingkan string secara timing-safe sederhana (hindari kebocoran lewat waktu).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(req: NextRequest): Promise<Response> {
  // ---- 1. Verifikasi secret token ----
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    // Konfigurasi belum lengkap: tolak, jangan proses apa pun.
    return new NextResponse("not configured", { status: 500 });
  }
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(got, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // Baca body sekali (dipakai untuk cek from.id lalu diserahkan ke grammY).
  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }

  // ---- 2. Whitelist pemilik ----
  let allowedId: number;
  try {
    allowedId = getAllowedId();
  } catch {
    return new NextResponse("not configured", { status: 500 });
  }
  const fromId = extractFromId(update);
  if (fromId !== allowedId) {
    // Bukan pemilik → abaikan tanpa memproses (tidak buang kuota Gemini/DB).
    // Balas 200 agar Telegram tidak retry.
    return new NextResponse("ok", { status: 200 });
  }

  // ---- 3. Proses update (parse → konfirmasi → insert) via grammY ----
  const bot = getBot();
  // Bangun ulang Request untuk grammY dari body yang sudah kita baca.
  const forwarded = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(update),
  });
  // grammY juga memverifikasi header secret secara internal terhadap opsi
  // secretToken. Karena kita meneruskan header apa adanya, secret HARUS
  // diberikan di sini juga — kalau tidak, grammY membandingkannya dengan
  // undefined dan menolak dengan 401 "secret token is wrong".
  const handle = webhookCallback(bot, "std/http", { secretToken: expected });
  try {
    return await handle(forwarded);
  } catch {
    // Sudah lolos auth: balas 200 agar Telegram tak retry; jangan bocorkan error.
    return new NextResponse("ok", { status: 200 });
  }
}

// Tolak method non-POST secara eksplisit.
export function GET(): Response {
  return new NextResponse("method not allowed", { status: 405 });
}
