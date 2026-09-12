import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { sql } from "drizzle-orm";
import { db, jobs, getProfile } from "../src/db";
import { preScore } from "../src/pipeline/score";

/** Free diagnostic: is the cheap first-pass ranking picking the right jobs? */
(async () => {
  const profile = await getProfile();
  const pool = await db.select().from(jobs)
    .where(sql`sponsor_status in ('licensed','likely') or country <> 'gb'`);

  const ranked = pool
    .map((j) => ({ job: j, pre: preScore(j, profile).value }))
    .sort((a, b) => b.pre - a.pre);

  console.log(`pool ${pool.length} jobs\n\nTOP 22 BY FIRST-PASS SCORE`);
  for (const { job, pre } of ranked.slice(0, 22)) {
    console.log(`${String(pre).padStart(3)}  ${job.title.slice(0, 54).padEnd(54)} | ${job.company.slice(0, 22).padEnd(22)} | ${job.country} ${job.sponsorStatus}`);
  }

  const secRe = /secur|soc|siem|cyber|infosec|grc|iso 27001|risk|compliance|infrastructure|system|network|sysadmin|it manager|identity|iam/i;
  const relevant = ranked.slice(0, 40).filter((r) => secRe.test(r.job.title)).length;
  console.log(`\n${relevant}/40 of the top-ranked jobs are security/infrastructure titles`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
