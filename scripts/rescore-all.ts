import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { sql, inArray, desc, isNotNull } from "drizzle-orm";
import { db, jobs } from "../src/db";
import { runScoring } from "../src/pipeline/score";
import { usageTotals, MODEL } from "../src/lib/llm";

/** Puts previously judged jobs back in the queue so new rules apply. */
(async () => {
  const n = Number(process.argv[2] ?? 20);
  const reset = await db.update(jobs)
    .set({ status: "new", score: null, preScore: null, skipReason: null })
    .where(inArray(jobs.status, ["scored", "skipped"]))
    .returning({ id: jobs.id });
  console.log(`reset ${reset.length} jobs, scoring top ${n}\n`);

  const s = await runScoring(n);
  const u = usageTotals();

  const kept = await db.select().from(jobs)
    .where(sql`status = 'scored'`).orderBy(desc(jobs.score)).limit(15);

  console.log("KEPT\n");
  for (const j of kept) {
    console.log(`${String(j.score).padStart(3)}  ${j.title.slice(0, 50).padEnd(50)} | ${j.company.slice(0, 24).padEnd(24)} | ${j.country} ${j.sponsorStatus}`);
    for (const r of (j.scoreReasons ?? []).slice(0, 2)) console.log(`     + ${r.slice(0, 110)}`);
    for (const c of (j.scoreConcerns ?? []).slice(0, 1)) console.log(`     - ${c.slice(0, 110)}`);
  }

  console.log(`\nscored ${s.scored}  kept ${s.keptAboveThreshold}  visa-blocked ${s.visaBlocked}  early-rejected ${s.skippedEarly}  errors ${s.errors}`);
  console.log(`${MODEL}: ${u.calls} calls, cache read ${u.cacheReadTokens}, fresh in ${u.inputTokens}, out ${u.outputTokens}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
