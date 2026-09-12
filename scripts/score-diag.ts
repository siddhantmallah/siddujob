import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { sql, inArray, desc, isNotNull } from "drizzle-orm";
import { db, jobs, getSettings } from "../src/db";
import { runScoring } from "../src/pipeline/score";
import { usageTotals, MODEL } from "../src/lib/llm";

/** Scores a batch and prints EVERY verdict, kept or not, with the reasoning. */
(async () => {
  const n = Number(process.argv[2] ?? 18);
  await db.update(jobs).set({ status: "new", score: null, preScore: null, skipReason: null })
    .where(inArray(jobs.status, ["scored", "skipped"]));

  const s = await runScoring(n);
  const settings = await getSettings();

  const judged = await db.select().from(jobs)
    .where(isNotNull(jobs.score)).orderBy(desc(jobs.score)).limit(n + 4);

  console.log(`keepThreshold=${settings.keepThreshold}  autoApplyThreshold=${settings.autoApplyThreshold}\n`);
  for (const j of judged) {
    const mark = j.status === "scored" ? "KEEP" : "drop";
    console.log(`${mark} ${String(j.score).padStart(3)} (pre ${Math.round(j.preScore ?? 0)})  ${j.title.slice(0, 46).padEnd(46)} | ${j.company.slice(0, 20).padEnd(20)} | ${j.country} ${j.sponsorStatus}`);
    for (const r of (j.scoreReasons ?? []).slice(0, 2)) console.log(`        + ${r.slice(0, 115)}`);
    for (const c of (j.scoreConcerns ?? []).slice(0, 2)) console.log(`        - ${c.slice(0, 115)}`);
    if (j.skipReason) console.log(`        why: ${j.skipReason.slice(0, 115)}`);
  }
  const u = usageTotals();
  console.log(`\nscored ${s.scored}  kept ${s.keptAboveThreshold}  visa-blocked ${s.visaBlocked}  errors ${s.errors}`);
  console.log(`${MODEL}: ${u.calls} calls  cache-read ${u.cacheReadTokens}  fresh-in ${u.inputTokens}  out ${u.outputTokens}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
