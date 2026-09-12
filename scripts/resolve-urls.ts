import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { resolveApplyUrls } from "../src/pipeline/resolve";

(async () => {
  const r = await resolveApplyUrls(Number(process.argv[2] ?? 20));
  console.log(`checked ${r.checked}   resolved to a reachable link ${r.resolved}   unreachable ${r.unreachable}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
