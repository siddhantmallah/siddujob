import { fetchJson, stripHtml, isRemote } from "@/lib/utils";
import type { JobSource, RawJob } from "./types";

type ReedSearch = {
  results?: Array<{
    jobId: number;
    jobTitle?: string;
    employerName?: string;
    locationName?: string;
    minimumSalary?: number | null;
    maximumSalary?: number | null;
    currency?: string | null;
    date?: string;
    jobDescription?: string;
    jobUrl?: string;
    applications?: number;
  }>;
};

/** Pages of 100 to read per query. Reed is UK-only, so depth pays here. */
const REED_PAGES = 3;

/** Reed uses HTTP Basic with the API key as the username and a blank password. */
function authHeader(): string {
  return "Basic " + Buffer.from(`${process.env.REED_API_KEY}:`).toString("base64");
}

/** Reed dates arrive as dd/MM/yyyy. */
function parseReedDate(d?: string): Date | null {
  if (!d) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim());
  if (!m) {
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
}

export const reed: JobSource = {
  name: "reed",
  regions: ["gb"],
  enabled: () => Boolean(process.env.REED_API_KEY),

  async fetch(ctx) {
    if (!ctx.countries.includes("gb")) return [];
    const out: RawJob[] = [];

    for (const query of ctx.queries) {
      // Reed is UK-only and carries exactly the traditional employers this
      // search targets, so it is worth paging rather than taking the first
      // hundred and moving on.
      for (let page = 0; page < REED_PAGES; page++) {
        if (ctx.deadline && Date.now() > ctx.deadline) return out;
        const params = new URLSearchParams({
          keywords: query,
          resultsToTake: "100",
          resultsToSkip: String(page * 100),
          postedByRecruitmentAgency: "true",
          postedByDirectEmployer: "true",
        });

        let data: ReedSearch;
        try {
          data = await fetchJson<ReedSearch>(
            `https://www.reed.co.uk/api/1.0/search?${params}`,
            { headers: { authorization: authHeader() } },
          );
        } catch (err) {
          console.warn(`[reed] "${query}" p${page} failed:`, (err as Error).message);
          break;
        }

        if (!data.results?.length) break;

        for (const r of data.results) {
          if (!r.jobTitle) continue;
          const location = r.locationName ?? "";
          const description = stripHtml(r.jobDescription ?? "");

          out.push({
            source: "reed",
            externalId: String(r.jobId),
            url: r.jobUrl ?? `https://www.reed.co.uk/jobs/${r.jobId}`,
            title: r.jobTitle.trim(),
            company: (r.employerName ?? "Unknown").trim(),
            location,
            country: "gb",
            description,
            salaryMin: r.minimumSalary ?? null,
            salaryMax: r.maximumSalary ?? null,
            currency: r.currency ?? "GBP",
            postedAt: parseReedDate(r.date),
            remote: isRemote(r.jobTitle, location, description),
          });
        }

        if (data.results.length < 100) break;
      }
    }
    return out;
  },
};
