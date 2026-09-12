import { and, eq, sql, inArray, desc } from "drizzle-orm";
import { db, atsBoards, sponsors, jobs, logEvent } from "@/db";
import { mapLimit, normalizeCompany } from "@/lib/utils";

/**
 * Turns the sponsor register from a filter into a source.
 *
 * You already hold 127,000 employers who can legally sponsor you. Many of them
 * publish openings on Greenhouse, Lever or Ashby — boards that appear hours
 * before the aggregators see them, have no recruiter in between, and use forms
 * the browser worker can complete. Finding which sponsors run one is the
 * highest-value thing this database can do.
 *
 * Probing 127,000 names against three public APIs would be abusive, so this is
 * deliberately incremental and cached: every probe is stored, nothing is ever
 * requested twice, and each run works through a prioritised batch.
 */

type Platform = "greenhouse" | "lever" | "ashby";

const PROBE: Record<Platform, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json&limit=1`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
};

/**
 * Company names that would generate slugs matching somebody else's board.
 * "systems" or "digital" as a slug is certain to belong to an unrelated firm.
 */
const TOO_GENERIC = new Set([
  "systems", "digital", "data", "cloud", "tech", "software", "security",
  "consulting", "solutions", "services", "group", "holdings", "partners",
  "capital", "global", "care", "health", "energy", "media", "people",
  "support", "network", "first", "one", "core", "next", "prime", "apex",
  "talent", "search", "select", "recruitment", "training", "academy",
]);

/** Names that are almost never on a modern engineering ATS — skip the request. */
const UNLIKELY = /\b(takeaway|restaurant|kebab|pizza|cafe|barber|salon|nursing home|care home|residential home|dental|dentist|pharmacy|newsagent|grocer|launderette|taxi|minicab|driving school|nursery|childcare|church|mosque|temple|charity shop|funeral|catering|cleaning|scaffolding|plumbing|roofing|joinery|builders merchant|farm|fisheries|abattoir)\b/i;

/** Tokens suggesting an employer likely to use Greenhouse / Lever / Ashby. */
const LIKELY = /\b(tech|technolog|software|digital|data|cyber|secur|cloud|labs?|ai|analytics|fintech|bank|financial|capital|insur|payments?|platform|systems?|consult|engineering|telecom|media|gaming|games|health ?tech|bio|pharma|robotic|semiconductor|network)\b/i;

/** Candidate board slugs for one company name, best guess first. */
export function slugsFor(name: string): string[] {
  const norm = normalizeCompany(name);
  if (!norm || norm.length < 3 || TOO_GENERIC.has(norm)) return [];

  const tokens = norm.split(" ").filter(Boolean);
  const out = new Set<string>();

  out.add(tokens.join(""));
  if (tokens.length > 1) {
    out.add(tokens.join("-"));
    // A one-word parent brand is the most common board name: "monzo bank" -> "monzo".
    if (tokens[0].length >= 4 && !TOO_GENERIC.has(tokens[0])) out.add(tokens[0]);
  }

  return [...out].filter((s) => s.length >= 3 && s.length <= 40 && !TOO_GENERIC.has(s));
}

type ProbeResult = { found: boolean; openings: number };

async function probeOne(platform: Platform, slug: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(PROBE[platform](slug), {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "job-finder/1.0 (personal job search)" },
    });
    if (!res.ok) return { found: false, openings: 0 };

    const body = (await res.json()) as unknown;
    if (platform === "lever") {
      // Lever returns an array; an unknown site 404s rather than returning [].
      return Array.isArray(body) ? { found: true, openings: body.length } : { found: false, openings: 0 };
    }
    const jobsArray = (body as { jobs?: unknown[] })?.jobs;
    if (!Array.isArray(jobsArray)) return { found: false, openings: 0 };
    return { found: true, openings: jobsArray.length };
  } catch {
    return { found: false, openings: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export type DiscoverySummary = {
  probed: number;
  found: number;
  boards: Array<{ platform: Platform; slug: string; company: string; openings: number }>;
  remaining: number;
};

/**
 * Builds the work queue, most promising first:
 *   1. sponsors already advertising in your jobs table — proven active hirers
 *   2. sponsors whose names suggest tech, finance or engineering
 * Anything already probed is excluded, so runs never repeat work.
 */
async function buildQueue(limit: number): Promise<Array<{ name: string; norm: string }>> {
  const done = new Set(
    (await db.select({ slug: atsBoards.slug }).from(atsBoards)).map((r) => r.slug),
  );

  const queue: Array<{ name: string; norm: string }> = [];
  const seen = new Set<string>();

  const push = (name: string, norm: string) => {
    if (seen.has(norm) || !norm) return;
    if (UNLIKELY.test(name)) return;
    if (slugsFor(name).every((s) => done.has(s))) return;
    seen.add(norm);
    queue.push({ name, norm });
  };

  // 1. Sponsors that are actively advertising somewhere we can see.
  const active = await db
    .select({ name: sponsors.name, norm: sponsors.nameNorm })
    .from(sponsors)
    .innerJoin(jobs, eq(jobs.companyNorm, sponsors.nameNorm))
    .groupBy(sponsors.name, sponsors.nameNorm)
    .limit(limit * 2);
  for (const row of active) push(row.name, row.norm);

  // 2. Sponsors whose names read like technology or financial employers.
  if (queue.length < limit) {
    const likely = await db
      .select({ name: sponsors.name, norm: sponsors.nameNorm })
      .from(sponsors)
      .where(sql`${sponsors.name} ~* '(tech|software|digital|cyber|secur|cloud|data|fintech|bank|financial|capital|payment|platform|consult|engineering|analytics|labs)'`)
      .orderBy(sql`length(${sponsors.nameNorm})`)
      .limit(limit * 6);
    for (const row of likely) {
      if (queue.length >= limit * 2) break;
      if (LIKELY.test(row.name)) push(row.name, row.norm);
    }
  }

  return queue.slice(0, limit);
}

export async function discoverAtsBoards(limit = 400): Promise<DiscoverySummary> {
  const queue = await buildQueue(limit);
  const platforms: Platform[] = ["greenhouse", "lever", "ashby"];

  const tasks: Array<{ platform: Platform; slug: string; name: string; norm: string }> = [];
  const alreadyQueued = new Set<string>();

  for (const company of queue) {
    for (const slug of slugsFor(company.name)) {
      for (const platform of platforms) {
        const key = `${platform}:${slug}`;
        if (alreadyQueued.has(key)) continue;
        alreadyQueued.add(key);
        tasks.push({ platform, slug, name: company.name, norm: company.norm });
      }
    }
  }

  // Skip anything already on record.
  const existing = new Set(
    (await db.select({ slug: atsBoards.slug, platform: atsBoards.platform }).from(atsBoards))
      .map((r) => `${r.platform}:${r.slug}`),
  );
  const work = tasks.filter((t) => !existing.has(`${t.platform}:${t.slug}`));

  const found: DiscoverySummary["boards"] = [];

  // Modest concurrency: these are other people's public endpoints.
  const results = await mapLimit(work, 8, async (task) => {
    const result = await probeOne(task.platform, task.slug);
    return { ...task, ...result };
  });

  for (let i = 0; i < results.length; i += 200) {
    const batch = results.slice(i, i + 200).map((r) => ({
      slug: r.slug,
      platform: r.platform,
      sponsorName: r.name,
      sponsorNorm: r.norm,
      found: r.found,
      openings: r.openings,
      probedAt: new Date(),
    }));
    if (batch.length) {
      await db.insert(atsBoards).values(batch).onConflictDoNothing();
    }
  }

  for (const r of results) {
    if (r.found) {
      found.push({ platform: r.platform, slug: r.slug, company: r.name, openings: r.openings });
    }
  }

  const [{ n: remaining }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sponsors);

  await logEvent("ats.discover", `Probed ${work.length} slugs, found ${found.length} live boards`, {
    meta: { probed: work.length, found: found.length },
  });

  return { probed: work.length, found: found.length, boards: found, remaining };
}

/** Every confirmed board, grouped by platform — this is what ingest consumes. */
export async function confirmedBoards(): Promise<Record<Platform, string[]>> {
  const rows = await db
    .select({ slug: atsBoards.slug, platform: atsBoards.platform })
    .from(atsBoards)
    .where(and(eq(atsBoards.found, true), eq(atsBoards.enabled, true)))
    .orderBy(desc(atsBoards.openings));

  const out: Record<Platform, string[]> = { greenhouse: [], lever: [], ashby: [] };
  for (const row of rows) out[row.platform].push(row.slug);
  return out;
}

export async function discoveryStats() {
  const [row] = await db
    .select({
      probed: sql<number>`count(*)::int`,
      found: sql<number>`count(*) filter (where found)::int`,
      openings: sql<number>`coalesce(sum(openings) filter (where found), 0)::int`,
    })
    .from(atsBoards);
  return row ?? { probed: 0, found: 0, openings: 0 };
}
