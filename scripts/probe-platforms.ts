import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

/**
 * Do the other ATS platforms expose a public job list the way Greenhouse and
 * Lever do? UK mid-market employers — the ones that actually hire Windows
 * infrastructure staff — mostly do not use Greenhouse, so this decides whether
 * the sponsor-register crawler can reach them at all.
 *
 * Probed with real company slugs so a 404 means "no public endpoint" rather
 * than "that company does not exist".
 */
const CANDIDATES: Array<{ platform: string; url: (s: string) => string; slugs: string[] }> = [
  {
    platform: "workable",
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    slugs: ["deliveroo", "typeform", "vodafone"],
  },
  {
    platform: "workable-alt",
    url: (s) => `https://${s}.workable.com/api/v1/jobs`,
    slugs: ["deliveroo", "typeform"],
  },
  {
    platform: "teamtailor",
    url: (s) => `https://${s}.teamtailor.com/jobs.json`,
    slugs: ["teamtailor", "kry", "lendo"],
  },
  {
    platform: "recruitee",
    url: (s) => `https://${s}.recruitee.com/api/offers/`,
    slugs: ["recruitee", "bynder", "framer"],
  },
  {
    platform: "personio",
    url: (s) => `https://${s}.jobs.personio.de/xml`,
    slugs: ["personio", "getsafe"],
  },
  {
    platform: "smartrecruiters",
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings`,
    slugs: ["Bosch", "Visa", "McDonalds"],
  },
];

(async () => {
  for (const c of CANDIDATES) {
    const results: string[] = [];
    for (const slug of c.slugs) {
      try {
        const res = await fetch(c.url(slug), {
          headers: { accept: "application/json,application/xml,text/xml", "user-agent": "job-finder/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.text();
        let count = "";
        if (res.ok) {
          try {
            const json = JSON.parse(body) as Record<string, unknown>;
            const arr =
              (json.jobs as unknown[]) ??
              (json.offers as unknown[]) ??
              (json.content as unknown[]) ??
              (Array.isArray(json) ? json : null);
            count = Array.isArray(arr) ? ` ${arr.length} jobs` : " (json, shape?)";
          } catch {
            count = body.includes("<") ? " (xml)" : " (text)";
          }
        }
        results.push(`${slug}=${res.status}${count}`);
      } catch (err) {
        results.push(`${slug}=ERR`);
      }
    }
    const works = results.some((r) => r.includes("=200"));
    console.log(`${works ? "USABLE " : "no     "} ${c.platform.padEnd(16)} ${results.join("  ")}`);
  }
})();
