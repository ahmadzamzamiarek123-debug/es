// Middleware ringan: arahkan ke /login bila cookie sesi tidak ada.
// Verifikasi token SEBENARNYA dilakukan di server component tiap halaman
// (lib/auth.checkToken) karena middleware berjalan di edge runtime yang tak
// punya Node crypto. Jadi middleware = UX redirect, halaman = gerbang asli.

import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth-shared";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Jangan proteksi: halaman login, endpoint auth, dan webhook bot (punya
  // mekanisme keamanan sendiri: secret token + whitelist).
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/login") ||
    pathname.startsWith("/api/telegram")
  ) {
    return NextResponse.next();
  }

  const hasCookie = Boolean(req.cookies.get(AUTH_COOKIE)?.value);
  if (!hasCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Lindungi semua kecuali aset statis & _next.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
