import { fetchJson, stripHtml, isRemote } from "@/lib/utils";
import { currencyFor, type JobSource, type RawJob } from "./types";

/** Countries Adzuna actually serves. Anything else must come from another feed. */
/** Pages to read per query per country. Each page is up to 50 postings. */
const ADZUNA_PAGES = 4;

const ADZUNA_COUNTRIES = new Set([
  "gb", "de", "nl", "fr", "es", "it", "pl", "at", "be", "ch", "se", "us", "ca", "in",
]);

type AdzunaResponse = {
  results?: Array<{
    id?: string;
    title?: string;
    description?: string;
    redirect_url?: string;
    created?: string;
    salary_min?: number;
    salary_max?: number;
    salary_is_predicted?: string;
    company?: { display_name?: string };
    location?: { display_name?: string; area?: string[] };
    contract_time?: string;
  }>;
};

export const adzuna: JobSource = {
  name: "adzuna",
  regions: [...ADZUNA_COUNTRIES],
  enabled: () => Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),

  async fetch(ctx) {
    const out: RawJob[] = [];
    const countries = ctx.countries.filter((c) => ADZUNA_COUNTRIES.has(c));

    for (const country of countries) {
      for (const query of ctx.queries) {
        // Aggregators carry the traditional employers — manufacturers, universities,
        // councils, research institutes — that actually hire Windows infrastructure
        // staff, and they are where every match so far has come from. Reading
        // several pages deep matters more here than on any other source.
        for (let page = 1; page <= ADZUNA_PAGES; page++) {
          if (ctx.deadline && Date.now() > ctx.deadline) return out;
          const params = new URLSearchParams({
            app_id: process.env.ADZUNA_APP_ID!,
            app_key: process.env.ADZUNA_APP_KEY!,
            results_per_page: String(Math.min(ctx.maxPerQuery, 50)),
            what: query,
            max_days_old: "21",
            sort_by: "date",
            "content-type": "application/json",
          });

          try {
            const data = await fetchJson<AdzunaResponse>(
              `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params}`,
            );
            if (!data.results?.length) break;

            for (const r of data.results) {
              if (!r.title || !r.redirect_url) continue;
              const location = r.location?.display_name ?? "";
              const description = stripHtml(r.description ?? "");

              out.push({
                source: "adzuna",
                externalId: String(r.id ?? r.redirect_url),
                url: r.redirect_url,
                title: r.title.trim(),
                company: (r.company?.display_name ?? "Unknown").trim(),
                location,
                country,
                description,
                // Adzuna predicts salaries when the ad omits them; a guess must
                // not be allowed to fail a visa salary-floor check, so drop those.
                salaryMin: r.salary_is_predicted === "1" ? null : r.salary_min ?? null,
                salaryMax: r.salary_is_predicted === "1" ? null : r.salary_max ?? null,
                currency: currencyFor(country),
                postedAt: r.created ? new Date(r.created) : null,
                remote: isRemote(r.title, location, description),
              });
            }
          } catch (err) {
            console.warn(`[adzuna] ${country}/"${query}" p${page} failed:`, (err as Error).message);
            break;
          }
        }
      }
    }
    return out;
  },
};
