import Link from "next/link";
import { logout } from "@/app/actions";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/jobs", label: "Jobs" },
  { href: "/applications", label: "Applications" },
  { href: "/profile", label: "Profile" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ current, badge }: { current: string; badge?: number }) {
  return (
    <header
      className="sticky top-0 z-20 border-b backdrop-blur"
      style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--bg) 88%, transparent)" }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-5 py-3">
        <Link href="/" className="mr-4 text-sm font-bold tracking-tight">
          Job&nbsp;Finder
        </Link>

        <nav className="flex flex-1 flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active = current === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors"
                style={{
                  background: active ? "var(--panel)" : "transparent",
                  color: active ? "var(--ink)" : "var(--muted)",
                  border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                }}
              >
                {link.label}
                {link.href === "/applications" && badge ? (
                  <span
                    className="ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                    style={{ background: "var(--accent)", color: "#fff" }}
                  >
                    {badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <form action={logout}>
          <button type="submit" className="btn" style={{ padding: "5px 10px", fontSize: 12 }}>
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

export function Shell({
  current, badge, children,
}: { current: string; badge?: number; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Nav current={current} badge={badge} />
      <main className="mx-auto max-w-6xl px-5 py-7">{children}</main>
    </div>
  );
}
