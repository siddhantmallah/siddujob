import { fetchJson, stripHtml, isRemote } from "@/lib/utils";
import { guessCountry, currencyFor, type JobSource, type RawJob, type SourceContext } from "./types";

/**
 * Company career boards read straight from the ATS.
 *
 * These are the highest-value source in the whole app: postings appear here
 * hours before they reach aggregators, there is no recruiter middleman, and the
 * application forms are machine-fillable — so the browser worker can complete
 * them end to end. Add employers you actually want in GREENHOUSE_BOARDS /
 * LEVER_BOARDS / ASHBY_BOARDS.
 */

function envTokens(envVar: string): string[] {
  return (process.env[envVar] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Boards come from two places: whatever you listed by hand, and whatever the
 * sponsor-register crawler confirmed is live. Merged and de-duplicated so the
 * discovered set grows on its own without you editing anything.
 */
function boardsFor(
  envVar: string,
  platform: "greenhouse" | "lever" | "ashby",
  ctx: SourceContext,
): string[] {
  return [...new Set([...envTokens(envVar), ...(ctx.discoveredBoards?.[platform] ?? [])])];
}

/** "monzo-bank" -> "Monzo Bank". Sponsor matching normalizes this again anyway. */
function prettyCompany(token: string): string {
  return token
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ───────────────────────────── Greenhouse ───────────────────────────── */

type GreenhouseResponse = {
  jobs?: Array<{
    id: number;
    title?: string;
    updated_at?: string;
    absolute_url?: string;
    content?: string;
    location?: { name?: string };
  }>;
};

export const greenhouse: JobSource = {
  name: "greenhouse",
  regions: "all",
  enabled: () => true,

  async fetch(ctx) {
    const out: RawJob[] = [];
    for (const token of boardsFor("GREENHOUSE_BOARDS", "greenhouse", ctx)) {
      try {
        const data = await fetchJson<GreenhouseResponse>(
          `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
        );
        const company = prettyCompany(token);

        for (const j of data.jobs ?? []) {
          if (!j.title) continue;
          const location = j.location?.name ?? "";
          // Greenhouse double-encodes: entities first, then tags.
          const description = stripHtml(stripHtml(j.content ?? ""));

          out.push({
            source: "greenhouse",
            externalId: String(j.id),
            url: j.absolute_url ?? `https://boards.greenhouse.io/${token}/jobs/${j.id}`,
            applyUrl: j.absolute_url ? `${j.absolute_url}#app` : null,
            title: j.title.trim(),
            company,
            location,
            country: guessCountry(location),
            description,
            currency: currencyFor(guessCountry(location)),
            postedAt: j.updated_at ? new Date(j.updated_at) : null,
            remote: isRemote(j.title, location, description),
            atsType: "greenhouse",
            atsToken: token,
          });
        }
      } catch (err) {
        console.warn(`[greenhouse] board "${token}" failed:`, (err as Error).message);
      }
    }
    return out;
  },
};

/* ─────────────────────────────── Lever ─────────────────────────────── */

type LeverPosting = {
  id: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  workplaceType?: string;
  categories?: { location?: string; team?: string; commitment?: string };
};

export const lever: JobSource = {
  name: "lever",
  regions: "all",
  enabled: () => true,

  async fetch(ctx) {
    const out: RawJob[] = [];
    for (const token of boardsFor("LEVER_BOARDS", "lever", ctx)) {
      try {
        const data = await fetchJson<LeverPosting[]>(
          `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
        );
        const company = prettyCompany(token);

        for (const j of data ?? []) {
          if (!j.text) continue;
          const location = j.categories?.location ?? "";
          const description = [j.descriptionPlain, j.additionalPlain].filter(Boolean).join("\n\n");

          out.push({
            source: "lever",
            externalId: j.id,
            url: j.hostedUrl ?? `https://jobs.lever.co/${token}/${j.id}`,
            applyUrl: j.applyUrl ?? (j.hostedUrl ? `${j.hostedUrl}/apply` : null),
            title: j.text.trim(),
            company,
            location,
            country: guessCountry(location),
            description,
            currency: currencyFor(guessCountry(location)),
            postedAt: j.createdAt ? new Date(j.createdAt) : null,
            remote: j.workplaceType === "remote" || isRemote(j.text, location, description),
            atsType: "lever",
            atsToken: token,
          });
        }
      } catch (err) {
        console.warn(`[lever] board "${token}" failed:`, (err as Error).message);
      }
    }
    return out;
  },
};

/* ─────────────────────────────── Ashby ─────────────────────────────── */

type AshbyResponse = {
  jobs?: Array<{
    id: string;
    title?: string;
    location?: string;
    descriptionPlain?: string;
    jobUrl?: string;
    applyUrl?: string;
    publishedAt?: string;
    isRemote?: boolean;
    compensation?: {
      compensationTierSummary?: string;
      summaryComponents?: Array<{
        compensationType?: string;
        minValue?: number;
        maxValue?: number;
        currencyCode?: string;
      }>;
    };
  }>;
};

export const ashby: JobSource = {
  name: "ashby",
  regions: "all",
  enabled: () => true,

  async fetch(ctx) {
    const out: RawJob[] = [];
    for (const token of boardsFor("ASHBY_BOARDS", "ashby", ctx)) {
      try {
        const data = await fetchJson<AshbyResponse>(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
        );
        const company = prettyCompany(token);

        for (const j of data.jobs ?? []) {
          if (!j.title) continue;
          const location = j.location ?? "";
          const salary = (j.compensation?.summaryComponents ?? []).find(
            (c) => c.compensationType === "Salary",
          );

          out.push({
            source: "ashby",
            externalId: j.id,
            url: j.jobUrl ?? "",
            applyUrl: j.applyUrl ?? j.jobUrl ?? null,
            title: j.title.trim(),
            company,
            location,
            country: guessCountry(location),
            description: j.descriptionPlain ?? "",
            salaryMin: salary?.minValue ?? null,
            salaryMax: salary?.maxValue ?? null,
            currency: salary?.currencyCode ?? currencyFor(guessCountry(location)),
            postedAt: j.publishedAt ? new Date(j.publishedAt) : null,
            remote: j.isRemote ?? isRemote(j.title, location, j.descriptionPlain ?? ""),
            atsType: "ashby",
            atsToken: token,
          });
        }
      } catch (err) {
        console.warn(`[ashby] board "${token}" failed:`, (err as Error).message);
      }
    }
    return out.filter((j) => j.url);
  },
};
