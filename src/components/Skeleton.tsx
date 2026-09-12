/**
 * Route-level placeholders.
 *
 * Every page here is server-rendered on demand against a remote database, so a
 * tab click has real latency behind it. Without a loading state the browser
 * simply sits on the old page and the app feels broken — these make the
 * navigation visible the instant it is clicked.
 */
export function Line({ w = "100%", h = 12 }: { w?: string; h?: number }) {
  return (
    <div
      className="animate-pulse rounded"
      style={{ width: w, height: h, background: "var(--panel-2)" }}
    />
  );
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-center gap-3">
        <Line w="38px" h={20} />
        <Line w="46%" h={14} />
        <div className="ml-auto"><Line w="88px" h={20} /></div>
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <Line key={i} w={`${88 - i * 13}%`} h={10} />
      ))}
    </div>
  );
}

export function ListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} rows={2} />
      ))}
    </div>
  );
}

export function PageSkeleton({ title, count = 6 }: { title: string; count?: number }) {
  return (
    <div className="mx-auto max-w-6xl px-5 py-7">
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-[15px] font-bold">{title}</h1>
        <span className="pill pill-flat">loading…</span>
      </div>
      <ListSkeleton count={count} />
    </div>
  );
}
