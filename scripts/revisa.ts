import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { eq, sql } from "drizzle-orm";
import { db, jobs, getProfile } from "../src/db";
import { assessVisa } from "../src/pipeline/score";
import { lookupSponsors } from "../src/pipeline/sponsors";

/** Recomputes the visa verdict for every stored job. No model calls. */
(async () => {
  const profile = await getProfile();
  const all = await db.select().from(jobs);
  const map = await lookupSponsors(all.map((j) => j.companyNorm));

  let changed = 0;
  const counts: Record<string, number> = {};

  for (const job of all) {
    const v = assessVisa(job, profile, map.get(job.companyNorm) ?? null);
    counts[v.sponsorStatus] = (counts[v.sponsorStatus] ?? 0) + 1;
    if (v.sponsorStatus !== job.sponsorStatus) {
      changed++;
      await db.update(jobs).set({
        sponsorStatus: v.sponsorStatus,
        sponsorMatchedName: v.sponsorMatchedName,
        sponsorRoutes: v.sponsorRoutes,
        visaNote: v.note,
      }).where(eq(jobs.id, job.id));
    }
  }

  console.log(`${all.length} jobs re-checked, ${changed} changed`);
  console.log("status:", Object.entries(counts).map(([k, n]) => `${k}=${n}`).join("  "));

  const gb = await db.select({
    total: sql<number>`count(*)::int`,
    licensed: sql<number>`count(*) filter (where sponsor_status='licensed')::int`,
    likely: sql<number>`count(*) filter (where sponsor_status='likely')::int`,
  }).from(jobs).where(eq(jobs.country, "gb"));
  const r = gb[0];
  const reachable = r.licensed + r.likely;
  console.log(`\nUK: ${r.total} jobs — ${r.licensed} exact + ${r.likely} likely = ${reachable} reachable (${Math.round(reachable / r.total * 100)}%)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
