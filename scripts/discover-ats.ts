import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { discoverAtsBoards, discoveryStats, confirmedBoards } from "../src/pipeline/atsdiscovery";

/** npx tsx scripts/discover-ats.ts [batchSize] */
(async () => {
  const limit = Number(process.argv[2] ?? 400);
  const before = await discoveryStats();
  console.log(`already probed ${before.probed} slugs, ${before.found} live boards\n`);

  const t0 = Date.now();
  const r = await discoverAtsBoards(limit);
  console.log(`probed ${r.probed} new slugs in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${r.found} live boards found\n`);

  for (const b of r.boards.sort((a, z) => z.openings - a.openings)) {
    console.log(`  ${b.platform.padEnd(11)} ${b.slug.padEnd(26)} ${String(b.openings).padStart(4)} openings   ${b.company}`);
  }

  const all = await confirmedBoards();
  const after = await discoveryStats();
  console.log(`\ntotal: ${after.found} boards across ${after.probed} probes, ${after.openings} openings visible`);
  console.log(`\nGREENHOUSE_BOARDS="${all.greenhouse.join(",")}"`);
  console.log(`LEVER_BOARDS="${all.lever.join(",")}"`);
  console.log(`ASHBY_BOARDS="${all.ashby.join(",")}"`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
