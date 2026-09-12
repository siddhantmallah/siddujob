import { fetchJson, stripHtml, isRemote } from "@/lib/utils";
import { guessCountry, currencyFor, type JobSource, type RawJob } from "./types";

/**
 * Keyless public feeds. They need no signup, so the app produces results on day
 * one even before you have any API keys, and they cover EU/remote roles the
 * paid aggregators miss.
 */

/* ───────────────────────── Arbeitnow (EU-heavy) ───────────────────────── */

type ArbeitnowResponse = {
  data?: Array<{
    slug?: string;
    company_name?: string;
    title?: string;
    description?: string;
    remote?: boolean;
    url?: string;
    tags?: string[];
    job_types?: string[];
    location?: string;
    created_at?: number;
  }>;
};

export const arbeitnow: JobSource = {
  name: "arbeitnow",
  regions: ["de", "nl", "at", "ch", "pl", "gb", "fr", "es", "pt", "cz"],
  enabled: () => true,

  async fetch(ctx) {
    const out: RawJob[] = [];
    // The feed is paginated and unfiltered; a few pages is plenty per run.
    for (let page = 1; page <= 3; page++) {
      try {
        const data = await fetchJson<ArbeitnowResponse>(
          `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
        );
        if (!data.data?.length) break;

        for (const j of data.data) {
          if (!j.title || !j.url) continue;
          const location = j.location ?? "";
          const country = guessCountry(location, "de");
          if (ctx.countries.length && !ctx.countries.includes(country) && !j.remote) continue;

          const description = stripHtml(j.description ?? "");

          out.push({
            source: "arbeitnow",
            externalId: j.slug ?? j.url,
            url: j.url,
            title: j.title.trim(),
            company: (j.company_name ?? "Unknown").trim(),
            location,
            country,
            description,
            currency: currencyFor(country),
            postedAt: j.created_at ? new Date(j.created_at * 1000) : null,
            remote: j.remote ?? isRemote(j.title, location, description),
          });
        }
      } catch (err) {
        console.warn(`[arbeitnow] page ${page} failed:`, (err as Error).message);
        break;
      }
    }
    return out;
  },
};

/* ────────────────────────── Remotive (remote only) ────────────────────── */

type RemotiveResponse = {
  jobs?: Array<{
    id?: number;
    url?: string;
    title?: string;
    company_name?: string;
    candidate_required_location?: string;
    description?: string;
    publication_date?: string;
    salary?: string;
    job_type?: string;
  }>;
};

/** Remote roles are only useful to you if they allow hiring in UK/EU. */
function remoteRegionAllowed(region: string, countries: string[]): boolean {
  const r = region.toLowerCase();
  if (!r || /worldwide|anywhere/.test(r)) return true;
  if (/\b(emea|europe|eu)\b/.test(r)) return true;
  const guessed = guessCountry(r);
  if (guessed && countries.includes(guessed)) return true;
  // "USA Only", "LATAM", "Canada" and friends are dead ends — drop them.
  return false;
}

export const remotive: JobSource = {
  name: "remotive",
  regions: "all",
  enabled: () => true,

  async fetch(ctx) {
    const out: RawJob[] = [];
    for (const query of ctx.queries.slice(0, 6)) {
      try {
        const data = await fetchJson<RemotiveResponse>(
          `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${Math.min(ctx.maxPerQuery, 50)}`,
        );

        for (const j of data.jobs ?? []) {
          if (!j.title || !j.url) continue;
          const region = j.candidate_required_location ?? "";
          if (!remoteRegionAllowed(region, ctx.countries)) continue;

          const description = stripHtml(j.description ?? "");
          const country = guessCountry(region);

          out.push({
            source: "remotive",
            externalId: String(j.id ?? j.url),
            url: j.url,
            title: j.title.trim(),
            company: (j.company_name ?? "Unknown").trim(),
            location: region || "Remote",
            country,
            description,
            currency: country ? currencyFor(country) : null,
            postedAt: j.publication_date ? new Date(j.publication_date) : null,
            remote: true,
          });
        }
      } catch (err) {
        console.warn(`[remotive] "${query}" failed:`, (err as Error).message);
      }
    }
    return out;
  },
};

/* ─────────────────────────────── Jobicy ─────────────────────────────── */

type JobicyResponse = {
  jobs?: Array<{
    id?: number | string;
    url?: string;
    jobTitle?: string;
    companyName?: string;
    jobGeo?: string;
    jobDescription?: string;
    pubDate?: string;
    annualSalaryMin?: number | string | null;
    annualSalaryMax?: number | string | null;
    salaryCurrency?: string | null;
  }>;
};

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const jobicy: JobSource = {
  name: "jobicy",
  regions: "all",
  enabled: () => true,

  async fetch(ctx) {
    const out: RawJob[] = [];
    const geos = ["uk", "europe"];

    for (const geo of geos) {
      try {
        const data = await fetchJson<JobicyResponse>(
          `https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}`,
        );

        for (const j of data.jobs ?? []) {
          if (!j.jobTitle || !j.url) continue;
          const location = j.jobGeo ?? "";
          const country = guessCountry(location, geo === "uk" ? "gb" : "");
          if (ctx.countries.length && country && !ctx.countries.includes(country)) continue;

          const description = stripHtml(j.jobDescription ?? "");

          out.push({
            source: "jobicy",
            externalId: String(j.id ?? j.url),
            url: j.url,
            title: j.jobTitle.trim(),
            company: (j.companyName ?? "Unknown").trim(),
            location: location || "Remote",
            country,
            description,
            salaryMin: toNumber(j.annualSalaryMin),
            salaryMax: toNumber(j.annualSalaryMax),
            currency: j.salaryCurrency ?? (country ? currencyFor(country) : null),
            postedAt: j.pubDate ? new Date(j.pubDate) : null,
            remote: true,
          });
        }
      } catch (err) {
        console.warn(`[jobicy] geo=${geo} failed:`, (err as Error).message);
      }
    }
    return out;
  },
};

/* ─────────────────────────────── Jooble ─────────────────────────────── */

type JoobleResponse = {
  jobs?: Array<{
    title?: string;
    location?: string;
    snippet?: string;
    salary?: string;
    link?: string;
    company?: string;
    updated?: string;
    id?: number | string;
  }>;
};

const JOOBLE_HOSTS: Record<string, string> = {
  gb: "uk.jooble.org", de: "de.jooble.org", nl: "nl.jooble.org", ie: "ie.jooble.org",
  fr: "fr.jooble.org", es: "es.jooble.org", pl: "pl.jooble.org", it: "it.jooble.org",
  pt: "pt.jooble.org", se: "se.jooble.org", at: "at.jooble.org", be: "be.jooble.org",
  cz: "cz.jooble.org", dk: "dk.jooble.org", fi: "fi.jooble.org",
};

export const jooble: JobSource = {
  name: "jooble",
  regions: Object.keys(JOOBLE_HOSTS),
  enabled: () => Boolean(process.env.JOOBLE_API_KEY),

  async fetch(ctx) {
    const out: RawJob[] = [];

    for (const country of ctx.countries) {
      const host = JOOBLE_HOSTS[country];
      if (!host) continue;

      for (const query of ctx.queries.slice(0, 4)) {
        try {
          const data = await fetchJson<JoobleResponse>(
            `https://${host}/api/${process.env.JOOBLE_API_KEY}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ keywords: query, page: "1" }),
            },
          );

          for (const j of data.jobs ?? []) {
            if (!j.title || !j.link) continue;
            const description = stripHtml(j.snippet ?? "");

            out.push({
              source: "jooble",
              externalId: String(j.id ?? j.link),
              url: j.link,
              title: j.title.trim(),
              company: (j.company ?? "Unknown").trim(),
              location: j.location ?? "",
              country,
              description,
              currency: currencyFor(country),
              postedAt: j.updated ? new Date(j.updated) : null,
              remote: isRemote(j.title, j.location ?? "", description),
            });
          }
        } catch (err) {
          console.warn(`[jooble] ${country}/"${query}" failed:`, (err as Error).message);
        }
      }
    }
    return out;
  },
};
