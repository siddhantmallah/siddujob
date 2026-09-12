import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

type QueueItem = { company: string; url: string; score: number; title: string };

/**
 * Where does an aggregator link actually end up, and is a fillable form
 * reachable from it? This decides whether the browser worker can submit these
 * at all, or whether the apply URL needs resolving further upstream.
 */
const LINK = /https?:\/\/[^"'\s<>\\]{10,220}/g;

const NOISE =
  /adzuna|google|gstatic|googleapis|facebook|twitter|x\.com|cloudflare|doubleclick|cookielaw|onetrust|schema\.org|w3\.org|bing|jsdelivr|cdn\.|sentry|hotjar|segment|licdn/i;

const ATS =
  /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|teamtailor|personio|recruitee|bamboohr|jobvite|icims|myworkdayjobs|workday|taleo|successfactors|eploy|networx|tribepad|hireful|applytojob|breezy|jazzhr|pinpointhq/i;

async function inspect(item: QueueItem) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`${item.score}  ${item.company} — ${item.title.slice(0, 46)}`);

  let html: string;
  let landed: string;
  try {
    const res = await fetch(item.url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    landed = new URL(res.url).hostname;
    html = await res.text();
  } catch (err) {
    console.log(`  fetch failed: ${(err as Error).message.slice(0, 70)}`);
    return null;
  }

  const links = [...new Set([...html.matchAll(LINK)].map((m) => m[0]))];
  const external = links.filter((u) => !NOISE.test(u));
  const ats = external.filter((u) => ATS.test(u));

  console.log(`  landed on   ${landed}`);
  console.log(`  page        ${(html.length / 1024).toFixed(0)} KB, ${external.length} external links`);

  if (ats.length) {
    console.log(`  FILLABLE    ${ats[0].slice(0, 110)}`);
    return ats[0];
  }

  const applyish = external.filter((u) => /apply|vacanc|career|recruit|job/i.test(u));
  if (applyish.length) {
    console.log(`  maybe       ${applyish[0].slice(0, 110)}`);
    return applyish[0];
  }
  console.log("  no onward link in the raw HTML — the destination is behind JavaScript");
  return null;
}

(async () => {
  const data = (await fetch(process.env.APP_URL + "/api/worker", {
    headers: { authorization: "Bearer " + process.env.CRON_SECRET },
  }).then((r) => r.json())) as { queue: QueueItem[] };

  let fillable = 0;
  for (const item of data.queue.slice(0, 6)) {
    if (await inspect(item)) fillable++;
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log(`${fillable} of ${Math.min(6, data.queue.length)} had a reachable onward link in raw HTML.`);
  console.log("Anything else needs a real browser to click through the interstitial.");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
