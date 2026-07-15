import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Semua secret hanya lewat env; tidak ada yang di-expose ke client (tanpa NEXT_PUBLIC_).
};

export default nextConfig;
