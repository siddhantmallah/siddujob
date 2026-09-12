import { and, eq, isNull, sql } from "drizzle-orm";
import { db, jobs, logEvent, type Job } from "@/db";
import { fetchJson, normalizeCompany, truncate } from "@/lib/utils";

/**
 * Finding a job you can apply to is not the same as finding a job.
 *
 * Adzuna serves its API worldwide but geo-blocks the apply path: from outside
 * the advertised country its job page returns "this job is not available in
 * your region", so the employer's form is unreachable. Every match so far came
 * from Adzuna, which meant every queued application was unsubmittable.
 *
 * The listing is still good intelligence — it tells us this employer has this
 * opening right now. What it cannot give us is a usable link. So for those
 * jobs we go looking for the same opening somewhere reachable, and only queue
 * an application once we have a link that works from here.
 */

/** Sources whose apply path is reachable from outside the advertised country. */
const REACHABLE = new Set(["reed", "greenhouse", "lever", "ashby", "arbeitnow", "jobicy", "remotive"]);

export function applyPathReachable(source: string): boolean {
  return REACHABLE.has(source);
}

type ReedSearch = {
  results?: Array<{
    jobId: number;
    jobTitle?: string;
    employerName?: string;
    jobUrl?: string;
    locationName?: string;
  }>;
};

function authHeader(): string {
  return "Basic " + Buffer.from(`${process.env.REED_API_KEY}:`).toString("base64");
}

/** Loose title comparison — boards pad titles with contract type and location. */
function titlesMatch(a: string, b: string): boolean {
  const clean = (s: string) =>
    s.toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(ftc|permanent|contract|full|part|time|month|months|remote|hybrid|onsite)\b/g, " ")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;

  // Otherwise require most of the shorter title's words to appear.
  const xs = new Set(x.split(" "));
  const ys = y.split(" ");
  const overlap = ys.filter((w) => xs.has(w)).length;
  return overlap >= Math.max(2, Math.ceil(Math.min(xs.size, ys.length) * 0.7));
}

/**
 * Looks for the same opening on Reed, which is reachable and covers the UK
 * market broadly. Returns a usable URL, or null if the role cannot be found —
 * in which case the job is honestly marked unreachable rather than queued.
 */
export async function findReachableUrl(job: Job): Promise<string | null> {
  if (!process.env.REED_API_KEY || job.country !== "gb") return null;

  const params = new URLSearchParams({
    keywords: job.title.replace(/\([^)]*\)/g, " ").trim(),
    resultsToTake: "50",
  });

  try {
    const data = await fetchJson<ReedSearch>(
      `https://www.reed.co.uk/api/1.0/search?${params}`,
      { headers: { authorization: authHeader() } },
    );

    const wantCompany = normalizeCompany(job.company);
    for (const r of data.results ?? []) {
      if (!r.jobTitle || !r.employerName || !r.jobUrl) continue;
      const sameCompany = normalizeCompany(r.employerName) === wantCompany;
      if (sameCompany && titlesMatch(job.title, r.jobTitle)) return r.jobUrl;
    }
  } catch (err) {
    console.warn(`[resolve] Reed lookup failed for ${job.company}:`, (err as Error).message);
  }
  return null;
}

export type ResolveSummary = { checked: number; resolved: number; unreachable: number };

/**
 * Gives every job a link that works from here, before anything is queued.
 * Jobs already on a reachable source are left alone.
 */
export async function resolveApplyUrls(limit = 25): Promise<ResolveSummary> {
  const pending = await db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.status, "scored"),
      isNull(jobs.applyUrl),
      sql`${jobs.source} not in ('reed','greenhouse','lever','ashby','arbeitnow','jobicy','remotive')`,
    ))
    .orderBy(sql`${jobs.score} desc`)
    .limit(limit);

  const summary: ResolveSummary = { checked: pending.length, resolved: 0, unreachable: 0 };

  for (const job of pending) {
    const url = await findReachableUrl(job);
    if (url) {
      await db.update(jobs).set({ applyUrl: url }).where(eq(jobs.id, job.id));
      summary.resolved++;
    } else {
      // Keep it visible and applicable by hand, but never queue it for a
      // worker that would only hit a regional block.
      await db.update(jobs).set({
        visaNote: job.visaNote,
        skipReason: `Listed on ${job.source}, whose apply page is geo-blocked from your location. Search the employer's own careers site for "${truncate(job.title, 60)}".`,
      }).where(eq(jobs.id, job.id));
      summary.unreachable++;
    }
  }

  if (summary.checked) {
    await logEvent(
      "resolve",
      `Resolved ${summary.resolved} apply links, ${summary.unreachable} unreachable`,
      { meta: summary as unknown as Record<string, unknown> },
    );
  }
  return summary;
}
