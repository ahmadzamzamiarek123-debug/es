// Konstanta auth yang aman diimpor dari edge runtime (middleware) — TIDAK
// mengimpor node:crypto. Logika token/HMAC ada di lib/auth.ts (server-only).

export const AUTH_COOKIE = "es_auth";
