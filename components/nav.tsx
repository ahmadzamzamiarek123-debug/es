"use client";

// Bottom navigation ala mobile app (mockup). Highlight tab aktif via pathname.
// Tombol Keluar pindah ke ikon es balok kanan-atas (IceLogout) — slotnya
// diganti tab Stok.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const TABS = [
  { href: "/", label: "Beranda", icon: "🏠" },
  { href: "/transaksi", label: "Transaksi", icon: "📋" },
  { href: "/stok", label: "Stok", icon: "🧊" },
  { href: "/laporan", label: "Laporan", icon: "📊" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bnav">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "on" : ""}>
            <span className="bi">{t.icon}</span>
            <span className="bl">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Ikon es balok kanan-atas = tombol keluar akun (dengan konfirmasi ringan
 * supaya tidak ke-logout karena kepencet).
 */
export function IceLogout() {
  const router = useRouter();

  async function logout() {
    if (!confirm("Keluar dari dashboard?")) return;
    await fetch("/api/login", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" onClick={logout} className="ice-logout" title="Keluar akun" aria-label="Keluar akun">
      🧊
    </button>
  );
}
