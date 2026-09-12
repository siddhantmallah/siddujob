import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { analyseCvGaps, concernFrequencies } from "../src/pipeline/cvgaps";
import { usageTotals, MODEL } from "../src/lib/llm";

(async () => {
  const freq = await concernFrequencies();
  console.log("HOW OFTEN EACH TERM APPEARS IN REJECTION NOTES");
  for (const f of freq.slice(0, 14)) {
    console.log(`  ${String(f.n).padStart(3)}  ${f.term}`);
  }

  const a = await analyseCvGaps();
  console.log(`\n\nANALYSIS OF ${a.jobsAnalysed} SCORED ADVERTS\n`);
  console.log(`POSITIONING\n  ${a.positioning}\n`);
  console.log(`SUGGESTED HEADLINE\n  ${a.headline_suggestion}\n`);
  console.log("WHAT WORKS FOR YOU");
  for (const s of a.strengths) console.log(`  + ${s}`);

  console.log("\nGAPS, MOST DAMAGING FIRST");
  for (const g of a.gaps) {
    const tag = g.kind === "unstated" ? "FIXABLE NOW" : g.kind === "weak_evidence" ? "NEEDS PROOF" : "REAL GAP";
    console.log(`\n  [${tag}] ${g.requirement}  (${g.impact} impact, seen ${g.frequency}x)`);
    console.log(`    ${g.advice}`);
    if (g.suggested_line) console.log(`    -> "${g.suggested_line}"`);
  }
  const u = usageTotals();
  console.log(`\n${MODEL}: ${u.calls} calls, ${u.inputTokens} in, ${u.outputTokens} out`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
