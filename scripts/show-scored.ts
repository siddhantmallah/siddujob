import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { desc, isNotNull, sql } from "drizzle-orm";
import { db, jobs, getSettings } from "../src/db";

(async () => {
  const s = await getSettings();
  const rows = await db.select().from(jobs).where(isNotNull(jobs.score)).orderBy(desc(jobs.score)).limit(16);
  console.log(`keepThreshold=${s.keepThreshold}\n`);
  for (const j of rows) {
    console.log(`${j.status === "scored" ? "KEEP" : "drop"} ${String(j.score).padStart(3)} (pre ${Math.round(j.preScore ?? 0)})  ${j.title.slice(0, 44).padEnd(44)} | ${j.company.slice(0, 18).padEnd(18)} | ${j.country} ${j.sponsorStatus} | ${j.source}`);
    for (const c of (j.scoreConcerns ?? []).slice(0, 1)) console.log(`      - ${c.slice(0, 118)}`);
  }
  const agg = await db.select({
    src: jobs.source, n: sql<number>`count(*)::int`,
  }).from(jobs).where(sql`status <> 'blocked'`).groupBy(jobs.source).orderBy(sql`count(*) desc`);
  console.log("\nactive pool by source:", agg.map((a) => `${a.src}=${a.n}`).join("  "));
  const gb = await db.select({
    n: sql<number>`count(*)::int`,
    ok: sql<number>`count(*) filter (where sponsor_status in ('licensed','likely'))::int`,
  }).from(jobs).where(sql`country='gb' and status <> 'blocked'`);
  console.log(`UK pool: ${gb[0].n}, sponsor-reachable ${gb[0].ok}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
