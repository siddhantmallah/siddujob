import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { runIngest } from "../src/pipeline/ingest";
import { runScoring } from "../src/pipeline/score";
import { usageTotals, MODEL } from "../src/lib/llm";

/** One discovery pass: fetch, dedupe, visa-gate, score. Applies to nothing. */
(async () => {
  const ingest = await runIngest();
  console.log(`fetched ${ingest.fetched}, new ${ingest.inserted}, dupes ${ingest.duplicates}, blocked ${ingest.blocked}`);
  for (const s of ingest.sources) {
    console.log(`  ${s.source.padEnd(12)} ${String(s.count).padStart(4)}  ${s.ms}ms${s.error ? "  ERR " + s.error.slice(0, 90) : ""}`);
  }

  const score = await runScoring(20);
  const u = usageTotals();
  console.log(`\nscored ${score.scored}, kept ${score.keptAboveThreshold}, early-rejected ${score.skippedEarly}, visa-blocked ${score.visaBlocked}, errors ${score.errors}`);
  console.log(`model ${MODEL}: ${u.calls} calls, cache read ${u.cacheReadTokens} tokens`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
