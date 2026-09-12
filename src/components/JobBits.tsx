import type { Job } from "@/db";

/**
 * The score as a ring rather than a number in a box.
 *
 * The job list is scanned, not read. A filled arc is legible at a glance from
 * across the row, which a two-digit number never is.
 */
export function ScoreRing({ score, size = 38 }: { score: number | null; size?: number }) {
  if (score == null) {
    return (
      <div
        className="grid shrink-0 place-items-center rounded-full text-[10px] font-semibold"
        style={{
          width: size, height: size,
          border: "1.5px dashed var(--border-strong)", color: "var(--faint)",
        }}
        title="Not scored yet"
      >
        –
      </div>
    );
  }

  const tone = score >= 78 ? "var(--good)" : score >= 55 ? "var(--warn)" : "var(--faint)";
  const angle = Math.round((Math.max(0, Math.min(100, score)) / 100) * 360);

  return (
    <div
      className="relative grid shrink-0 place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${tone} ${angle}deg, var(--panel-2) ${angle}deg)`,
      }}
      title={`Fit score ${score} of 100`}
    >
      <div
        className="grid place-items-center rounded-full"
        style={{ width: size - 7, height: size - 7, background: "var(--panel)" }}
      >
        <span className="tnum text-[12.5px] font-bold" style={{ color: tone }}>{score}</span>
      </div>
    </div>
  );
}

/**
 * The visa badge — the field to read first. Green means the employer can
 * legally hire you; red means they cannot, however good the match is.
 */
export function VisaPill({ job }: { job: Job }) {
  if (job.sponsorStatus === "not_required") {
    return <span className="pill pill-flat">no visa needed</span>;
  }

  if (job.country === "gb") {
    if (job.sponsorStatus === "licensed") {
      return (
        <span className="pill pill-good" title={job.sponsorMatchedName ?? undefined}>
          licensed sponsor
        </span>
      );
    }
    if (job.sponsorStatus === "likely") {
      return (
        <span
          className="pill pill-warn"
          title={`Matched "${job.sponsorMatchedName}" by name prefix — confirm on the advert`}
        >
          likely sponsor
        </span>
      );
    }
    return (
      <span className="pill pill-bad" title={job.visaNote ?? undefined}>not a sponsor</span>
    );
  }

  if (job.blueCardOk === true) {
    return <span className="pill pill-good" title={job.visaNote ?? undefined}>EU route open</span>;
  }
  if (job.blueCardOk === false) {
    return <span className="pill pill-bad" title={job.visaNote ?? undefined}>below EU threshold</span>;
  }
  return <span className="pill pill-flat" title={job.visaNote ?? undefined}>visa unclear</span>;
}

export function SalaryText({ job }: { job: Job }) {
  if (job.salaryMin == null && job.salaryMax == null) {
    return <span style={{ color: "var(--faint)" }}>salary not stated</span>;
  }
  const symbol =
    job.currency === "GBP" ? "£" : job.currency === "EUR" ? "€" : job.currency === "USD" ? "$" : "";
  const fmt = (n: number) => `${symbol}${Math.round(n).toLocaleString("en-GB")}`;

  if (job.salaryMin != null && job.salaryMax != null && job.salaryMin !== job.salaryMax) {
    return <span className="tnum">{fmt(job.salaryMin)}–{fmt(job.salaryMax)}</span>;
  }
  return <span className="tnum">{fmt((job.salaryMax ?? job.salaryMin)!)}</span>;
}

export function SourceTag({ source }: { source: string }) {
  const direct = ["greenhouse", "lever", "ashby"].includes(source);
  return (
    <span
      className="pill pill-flat"
      title={direct ? "Straight from the employer's own careers system" : undefined}
    >
      {source}
    </span>
  );
}

/** Country code as a readable label rather than a bare two-letter code. */
const COUNTRY_NAMES: Record<string, string> = {
  gb: "UK", ie: "Ireland", de: "Germany", nl: "Netherlands", fr: "France",
  es: "Spain", pl: "Poland", pt: "Portugal", it: "Italy", se: "Sweden",
  dk: "Denmark", be: "Belgium", at: "Austria", cz: "Czechia", fi: "Finland",
  lu: "Luxembourg", ch: "Switzerland", no: "Norway",
};

export function placeLabel(job: Job): string {
  const country = COUNTRY_NAMES[job.country] ?? job.country.toUpperCase();
  if (!job.location) return country || "location unknown";
  // Adverts often already include the country; do not print it twice.
  if (country && job.location.toLowerCase().includes(country.toLowerCase())) return job.location;
  return country ? `${job.location}, ${country}` : job.location;
}
