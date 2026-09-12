import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { desc, isNotNull, sql, eq } from "drizzle-orm";
import { db, jobs } from "../src/db";

(async () => {
  const scored = await db.select().from(jobs).where(isNotNull(jobs.score)).orderBy(desc(jobs.score)).limit(14);
  console.log("TOP SCORED\n");
  for (const j of scored) {
    console.log(`${String(j.score).padStart(3)} (pre ${Math.round(j.preScore ?? 0)})  ${j.title.slice(0, 52).padEnd(52)} | ${j.company.slice(0, 26).padEnd(26)} | ${j.country} | ${j.sponsorStatus}`);
    if (j.skipReason) console.log(`      skip: ${j.skipReason}`);
    if (j.visaNote) console.log(`      visa: ${j.visaNote.slice(0, 130)}`);
  }

  const byCountry = await db.select({
    country: jobs.country, n: sql<number>`count(*)::int`,
  }).from(jobs).groupBy(jobs.country).orderBy(sql`count(*) desc`).limit(8);
  console.log("\nBY COUNTRY:", byCountry.map((r) => `${r.country || "??"}=${r.n}`).join("  "));

  const gbTotal = await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.country, "gb"));
  const gbLicensed = await db.select({ n: sql<number>`count(*)::int` })
    .from(jobs).where(sql`${jobs.country} = 'gb' and ${jobs.sponsorStatus} = 'licensed'`);
  console.log(`\nUK jobs: ${gbTotal[0].n}  matched to a licensed sponsor: ${gbLicensed[0].n}`);

  const unmatched = await db.select({ company: jobs.company, norm: jobs.companyNorm })
    .from(jobs).where(sql`${jobs.country} = 'gb' and ${jobs.sponsorStatus} <> 'licensed'`).limit(12);
  console.log("\nUK employers NOT matched to the register (sample):");
  for (const u of unmatched) console.log(`  ${u.company.slice(0, 44).padEnd(44)} -> "${u.norm}"`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
