// Endpoint login: verifikasi password → set cookie httpOnly berisi token.
// POST { password } → 200 (set cookie) | 401. DELETE → logout (hapus cookie).
import { NextRequest, NextResponse } from "next/server";
import { checkPassword, makeToken, AUTH_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return new NextResponse("bad request", { status: 400 });
  }
  const password = typeof body.password === "string" ? body.password : "";

  if (!checkPassword(password)) {
    // Jeda kecil untuk sedikit memperlambat brute force.
    await new Promise((r) => setTimeout(r, 300));
    return new NextResponse("unauthorized", { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, makeToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 hari
  });
  return res;
}

export async function DELETE(): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
