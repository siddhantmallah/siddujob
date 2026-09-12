import Link from "next/link";
import { logout } from "@/app/actions";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/jobs", label: "Jobs" },
  { href: "/applications", label: "Applications" },
  { href: "/profile", label: "Profile" },
  { href: "/settings", label: "Settings" },
];

export function Nav({
  current, jobCount, replyCount,
}: { current: string; jobCount?: number; replyCount?: number }) {
  return (
    <header
      className="sticky top-0 z-30 border-b backdrop-blur-xl"
      style={{
        borderColor: "var(--border)",
        background: "color-mix(in srgb, var(--bg) 82%, transparent)",
      }}
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-5 py-2.5">
        <Link href="/" className="mr-3 flex items-center gap-2">
          <span
            className="grid h-6 w-6 place-items-center rounded-md text-[11px] font-black"
            style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
          >
            JF
          </span>
          <span className="text-[13.5px] font-bold tracking-tight">Job Finder</span>
        </Link>

        <nav className="flex flex-1 flex-wrap items-center gap-0.5">
          {LINKS.map((link) => {
            const active = current === link.href;
            const badge =
              link.href === "/jobs" ? jobCount
                : link.href === "/applications" ? replyCount
                  : undefined;

            return (
              <Link
                key={link.href}
                href={link.href}
                prefetch
                aria-current={active ? "page" : undefined}
                className="relative rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors"
                style={{
                  background: active ? "var(--panel)" : "transparent",
                  color: active ? "var(--ink)" : "var(--muted)",
                  border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                  boxShadow: active ? "var(--shadow-sm)" : undefined,
                }}
              >
                {link.label}
                {badge ? (
                  <span
                    className="ml-1.5 rounded-full px-1.5 py-px text-[10px] font-bold tnum"
                    style={{
                      background: active ? "var(--accent)" : "var(--panel-2)",
                      color: active ? "var(--accent-ink)" : "var(--muted)",
                    }}
                  >
                    {badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <form action={logout}>
          <button type="submit" className="btn btn-sm">Sign out</button>
        </form>
      </div>
    </header>
  );
}

export function Shell({
  current, jobCount, replyCount, children,
}: {
  current: string;
  jobCount?: number;
  replyCount?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <Nav current={current} jobCount={jobCount} replyCount={replyCount} />
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  );
}

/** Page header: title, optional count, and room for actions on the right. */
export function PageHead({
  title, subtitle, children,
}: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[17px] font-bold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--muted)" }}>{subtitle}</p>
        )}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** Used wherever a list can legitimately be empty, so it never looks broken. */
export function EmptyState({
  title, body, action,
}: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="panel px-6 py-12 text-center">
      <p className="text-[14px] font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-[13px]" style={{ color: "var(--muted)" }}>
        {body}
      </p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
