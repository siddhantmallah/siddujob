import type { Job } from "@/db";

export function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="pill pill-flat">unscored</span>;
  const cls = score >= 78 ? "pill-good" : score >= 55 ? "pill-warn" : "pill-flat";
  return <span className={`pill ${cls}`} style={{ minWidth: 34, justifyContent: "center" }}>{score}</span>;
}

/**
 * The visa badge. This is the field you look at first: green means the employer
 * can legally hire you, red means they cannot no matter how good the match is.
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
    return (
      <span className="pill pill-bad" title={job.visaNote ?? undefined}>
        not a sponsor
      </span>
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
    return <span style={{ color: "var(--muted)" }}>salary not stated</span>;
  }
  const symbol = job.currency === "GBP" ? "£" : job.currency === "EUR" ? "€" : job.currency === "USD" ? "$" : "";
  const fmt = (n: number) => `${symbol}${Math.round(n).toLocaleString()}`;
  if (job.salaryMin != null && job.salaryMax != null && job.salaryMin !== job.salaryMax) {
    return <span>{fmt(job.salaryMin)}–{fmt(job.salaryMax)}</span>;
  }
  return <span>{fmt((job.salaryMax ?? job.salaryMin)!)}</span>;
}

export function SourceTag({ source }: { source: string }) {
  const direct = ["greenhouse", "lever", "ashby"].includes(source);
  return (
    <span
      className="pill pill-flat"
      title={direct ? "Straight from the employer's ATS — no recruiter in between" : undefined}
    >
      {source}{direct ? " ·  direct" : ""}
    </span>
  );
}
