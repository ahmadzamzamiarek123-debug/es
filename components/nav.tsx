"use client";

// Bottom navigation ala mobile app (mockup). Highlight tab aktif via pathname.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const TABS = [
  { href: "/", label: "Beranda", icon: "🏠" },
  { href: "/transaksi", label: "Transaksi", icon: "📋" },
  { href: "/laporan", label: "Laporan", icon: "📊" },
];

export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/login", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }

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
      <button type="button" onClick={logout} className="bnav-out">
        <span className="bi">🚪</span>
        <span className="bl">Keluar</span>
      </button>
    </nav>
  );
}
