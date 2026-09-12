import { inArray } from "drizzle-orm";
import { db, jobs, getProfile, getSettings, logEvent, type NewJob } from "@/db";
import { fetchAllSources, type SourceResult } from "@/sources";
import { confirmedBoards } from "./atsdiscovery";
import { jobHash, normalizeCompany, extractContactEmail, truncate, toInt } from "@/lib/utils";

/** Fallback searches if you have not filled in target titles yet. */
const DEFAULT_QUERIES = [
  "IT Support Engineer",
  "Infrastructure Engineer",
  "DevOps Engineer",
  "Systems Administrator",
  "Cloud Engineer",
  "Service Desk Analyst",
  "Network Engineer",
  "Site Reliability Engineer",
];

const DEFAULT_COUNTRIES = ["gb", "ie", "de", "nl"];

export type IngestSummary = {
  fetched: number;
  inserted: number;
  duplicates: number;
  blocked: number;
  sources: SourceResult[];
};

export async function runIngest(): Promise<IngestSummary> {
  const profile = await getProfile();
  const settings = await getSettings();

  const queries = profile.targetTitles.length ? profile.targetTitles : DEFAULT_QUERIES;
  const countries = profile.targetCountries.length ? profile.targetCountries : DEFAULT_COUNTRIES;

  // Boards confirmed against the sponsor register feed in automatically.
  const discoveredBoards = await confirmedBoards();

  const { jobs: raw, results } = await fetchAllSources({
    queries: queries.slice(0, 10),
    countries,
    maxPerQuery: 50,
    discoveredBoards,
  });

  // Company ATS boards return their whole global board, so a Greenhouse feed
  // happily hands back San Francisco roles. Drop anything outside the countries
  // you can actually work in; an unknown country is kept and judged later.
  const wantedCountries = new Set(countries);
  let offCountry = 0;

  const blockedCompanies = new Set(settings.blockedCompanies.map(normalizeCompany));
  const blockedKeywords = settings.blockedKeywords.map((k) => k.toLowerCase()).filter(Boolean);

  // Collapse duplicates inside this batch before touching the database.
  const candidates = new Map<string, NewJob>();
  let blocked = 0;

  for (const r of raw) {
    if (!r.title || !r.company || !r.url) continue;

    if (r.country && wantedCountries.size && !wantedCountries.has(r.country)) {
      offCountry++;
      continue;
    }

    const companyNorm = normalizeCompany(r.company);
    if (blockedCompanies.has(companyNorm)) {
      blocked++;
      continue;
    }

    const haystack = `${r.title} ${r.description}`.toLowerCase();
    if (blockedKeywords.some((k) => haystack.includes(k))) {
      blocked++;
      continue;
    }

    const hash = jobHash({
      company: r.company, title: r.title, location: r.location,
    });

    const row: NewJob = {
      hash,
      source: r.source,
      externalId: r.externalId,
      url: r.url,
      applyUrl: r.applyUrl ?? null,
      title: truncate(r.title, 300),
      company: truncate(r.company, 200),
      companyNorm,
      location: truncate(r.location, 200),
      country: r.country,
      remote: r.remote ?? false,
      // Descriptions can be enormous; the scorer only reads the first few KB.
      description: truncate(r.description, 12_000),
      salaryMin: toInt(r.salaryMin),
      salaryMax: toInt(r.salaryMax),
      currency: r.currency ?? null,
      postedAt: r.postedAt && !Number.isNaN(r.postedAt.getTime()) ? r.postedAt : null,
      contactEmail: extractContactEmail(r.description),
      atsType: r.atsType ?? null,
      atsToken: r.atsToken ?? null,
      status: "new",
    };

    const existing = candidates.get(hash);
    // Prefer the record that carries the most application signal.
    if (!existing || score(row) > score(existing)) candidates.set(hash, row);
  }

  const hashes = [...candidates.keys()];
  const seen = new Set<string>();

  const CHUNK = 300;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const batch = hashes.slice(i, i + CHUNK);
    const rows = await db.select({ hash: jobs.hash }).from(jobs).where(inArray(jobs.hash, batch));
    for (const row of rows) seen.add(row.hash);
  }

  const fresh = [...candidates.values()].filter((j) => !seen.has(j.hash!));

  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const batch = fresh.slice(i, i + 200);
    const rows = await db
      .insert(jobs)
      .values(batch)
      .onConflictDoNothing({ target: jobs.hash })
      .returning({ id: jobs.id });
    inserted += rows.length;
  }

  const summary: IngestSummary = {
    fetched: raw.length,
    inserted,
    duplicates: raw.length - fresh.length - blocked - offCountry,
    blocked: blocked + offCountry,
    sources: results,
  };

  await logEvent(
    "ingest",
    `Fetched ${raw.length} postings, ${inserted} new`,
    { meta: summary as unknown as Record<string, unknown> },
  );

  return summary;
}

/** Ranks two versions of the same posting — richer record wins. */
function score(j: NewJob): number {
  let n = 0;
  if (j.atsType) n += 10;          // direct ATS beats any aggregator
  if (j.contactEmail) n += 6;      // an email means we can actually auto-send
  if (j.salaryMin || j.salaryMax) n += 4;
  if (j.applyUrl) n += 2;
  n += Math.min((j.description ?? "").length / 2000, 4);
  return n;
}
