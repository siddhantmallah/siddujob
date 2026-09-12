import { parse } from "csv-parse/sync";
import { eq, inArray, or, like } from "drizzle-orm";
import { db, sponsors, sponsorMeta, logEvent } from "@/db";
import { normalizeCompany, truncate } from "@/lib/utils";

/**
 * Syncs the UK Home Office "Register of licensed sponsors: workers".
 *
 * If an employer is not on this list they cannot sponsor a Skilled Worker visa,
 * full stop. Checking it before you apply is the single highest-leverage filter
 * in the app — it is the difference between 200 applications into a void and 40
 * to employers who can actually hire you.
 *
 * The CSV filename changes every publish, so we scrape the publication page for
 * whatever the current asset URL is.
 */

const PUBLICATION_PAGE =
  "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers";

async function findCsvUrl(): Promise<string> {
  const res = await fetch(PUBLICATION_PAGE, {
    headers: { "user-agent": "job-finder/1.0 (personal job search tool)" },
  });
  if (!res.ok) throw new Error(`gov.uk publication page returned HTTP ${res.status}`);
  const html = await res.text();

  const matches = [
    ...html.matchAll(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"'\s<>\\]+?\.csv/gi),
  ].map((m) => m[0]);

  if (!matches.length) {
    throw new Error("Could not find a CSV link on the gov.uk sponsor register page");
  }
  // Prefer the worker register over any other attachment on the page.
  return matches.find((u) => /worker/i.test(u)) ?? matches[0];
}

type SponsorRow = {
  name: string;
  nameNorm: string;
  town: string;
  county: string;
  rating: string;
  routes: string[];
};

function pick(row: Record<string, string>, candidates: string[]): string {
  for (const key of Object.keys(row)) {
    const k = key.toLowerCase().replace(/[^a-z]/g, "");
    if (candidates.some((c) => k.includes(c))) return (row[key] ?? "").trim();
  }
  return "";
}

export function parseSponsorCsv(csv: string): SponsorRow[] {
  // The file occasionally ships with a BOM and a preamble line.
  const cleaned = csv.replace(/^﻿/, "");

  const records = parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  }) as Array<Record<string, string>>;

  // One org can appear several times, once per immigration route.
  const byKey = new Map<string, SponsorRow>();

  for (const record of records) {
    const name = pick(record, ["organisationname", "organisation", "name"]);
    if (!name) continue;

    const nameNorm = normalizeCompany(name);
    if (!nameNorm) continue;

    const town = pick(record, ["towncity", "town", "city"]);
    const county = pick(record, ["county"]);
    const rating = pick(record, ["typerating", "rating", "type"]);
    const route = pick(record, ["route"]);

    const key = `${nameNorm}|${town.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      if (route && !existing.routes.includes(route)) existing.routes.push(route);
    } else {
      byKey.set(key, {
        name, nameNorm, town, county, rating, routes: route ? [route] : [],
      });
    }
  }

  return [...byKey.values()];
}

export async function syncSponsorRegister(): Promise<{
  ok: boolean; rowCount: number; sourceUrl?: string; error?: string;
}> {
  try {
    const url = await findCsvUrl();
    const res = await fetch(url, {
      headers: { "user-agent": "job-finder/1.0 (personal job search tool)" },
    });
    if (!res.ok) throw new Error(`CSV download returned HTTP ${res.status}`);

    const rows = parseSponsorCsv(await res.text());
    if (rows.length < 1000) {
      // The real register has ~120k rows. Anything tiny means the format moved,
      // and replacing a good table with junk would silently break every check.
      throw new Error(`Parsed only ${rows.length} sponsors — refusing to overwrite the table`);
    }

    await db.delete(sponsors);

    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(sponsors).values(rows.slice(i, i + CHUNK));
    }

    const meta = {
      id: 1, lastSyncAt: new Date(), rowCount: rows.length, sourceUrl: url,
    };
    await db
      .insert(sponsorMeta)
      .values(meta)
      .onConflictDoUpdate({ target: sponsorMeta.id, set: meta });

    await logEvent("sponsors.sync", `Synced ${rows.length} licensed sponsors`, {
      meta: { rowCount: rows.length, url },
    });
    return { ok: true, rowCount: rows.length, sourceUrl: url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent("sponsors.sync", `Sponsor sync failed: ${truncate(message, 300)}`, {
      level: "error",
    });
    return { ok: false, rowCount: 0, error: message };
  }
}

export type SponsorHit = {
  name: string;
  routes: string[];
  town: string;
  /** exact = names are identical once normalised. prefix = one contains the other. */
  match: "exact" | "prefix";
} | null;

/**
 * Company names that must never drive a prefix match. Each is a real word that
 * also happens to be a company name, so "Remote" would otherwise match
 * "Remote Solutions Ltd" and wrongly report the employer as a licensed sponsor.
 * A false "licensed" badge is worse than a miss: it sends an application that
 * could never have led anywhere.
 */
const AMBIGUOUS = new Set([
  "remote", "global", "digital", "data", "cloud", "tech", "first", "one", "core",
  "next", "prime", "apex", "focus", "vision", "insight", "bridge", "summit",
  "capital", "partners", "consulting", "recruitment", "resourcing", "staffing",
  "agency", "talent", "people", "search", "select", "network", "systems",
  "security", "software", "media", "energy", "health", "care", "support",
]);

/** Recruitment agencies advertise other employers' roles — never their own licence. */
const AGENCY_MARKERS = /\b(recruit|recruitment|resourcing|staffing|talent|consultan|agency|search|selection|personnel|manpower|hays|reed|adecco|randstad)\b/;

/**
 * Looks up many companies at once.
 *
 * Job boards rarely print the registered legal name: the register says
 * "Monzo Bank Ltd", the advert says "Monzo". Exact matching alone found 10
 * sponsors in 1,005 UK adverts, which is useless, so this also matches when one
 * normalised name is a whole-token prefix of the other — guarded, because a
 * wrong match is worse than none.
 */
export async function lookupSponsors(
  companyNorms: string[],
): Promise<Map<string, SponsorHit>> {
  const result = new Map<string, SponsorHit>();
  const unique = [...new Set(companyNorms.filter((n) => n && n.length >= 3))];
  if (!unique.length) return result;

  for (const norm of unique) result.set(norm, null);

  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);

    // Leading-token forms cover the other direction: advert says
    // "Centrica - CHP" -> "centrica chp", register says "Centrica plc".
    const leading = new Set<string>();
    for (const norm of batch) {
      const parts = norm.split(" ");
      if (parts.length > 1) {
        if (parts[0].length >= 4 && !AMBIGUOUS.has(parts[0])) leading.add(parts[0]);
        if (parts.length > 2) leading.add(parts.slice(0, 2).join(" "));
      }
    }

    const exactKeys = [...new Set([...batch, ...leading])];
    const prefixable = batch.filter((n) => n.length >= 5 && !AMBIGUOUS.has(n));

    const conditions = [inArray(sponsors.nameNorm, exactKeys)];
    if (prefixable.length) {
      // "monzo" -> "monzo %" matches "monzo bank" but never "monzobank ltd",
      // so the boundary is a real word break rather than a substring.
      conditions.push(or(...prefixable.map((n) => like(sponsors.nameNorm, `${n} %`)))!);
    }

    const rows = await db
      .select({
        name: sponsors.name, nameNorm: sponsors.nameNorm,
        routes: sponsors.routes, town: sponsors.town,
      })
      .from(sponsors)
      .where(or(...conditions));

    for (const norm of batch) {
      if (result.get(norm)) continue;

      const exact = rows.find((r) => r.nameNorm === norm);
      if (exact) {
        result.set(norm, {
          name: exact.name, routes: exact.routes, town: exact.town, match: "exact",
        });
        continue;
      }

      // Register name extends the advert name: "monzo" -> "monzo bank".
      const extended = !AMBIGUOUS.has(norm) && norm.length >= 5
        ? rows.find((r) => r.nameNorm.startsWith(`${norm} `))
        : undefined;
      if (extended) {
        result.set(norm, {
          name: extended.name, routes: extended.routes, town: extended.town, match: "prefix",
        });
        continue;
      }

      // Advert name extends the register name: "centrica chp" -> "centrica".
      const shortened = rows.find(
        (r) =>
          norm.startsWith(`${r.nameNorm} `) &&
          r.nameNorm.length >= 4 &&
          !AMBIGUOUS.has(r.nameNorm),
      );
      if (shortened) {
        result.set(norm, {
          name: shortened.name, routes: shortened.routes, town: shortened.town, match: "prefix",
        });
      }
    }
  }

  return result;
}

/** True when the advertiser is an agency, so its own licence proves nothing. */
export function looksLikeAgency(company: string): boolean {
  return AGENCY_MARKERS.test(company.toLowerCase());
}

/** True when the register has been populated at least once. */
export async function sponsorRegisterReady(): Promise<{ ready: boolean; rowCount: number; lastSyncAt: Date | null }> {
  const [meta] = await db.select().from(sponsorMeta).where(eq(sponsorMeta.id, 1));
  return {
    ready: Boolean(meta && meta.rowCount > 0),
    rowCount: meta?.rowCount ?? 0,
    lastSyncAt: meta?.lastSyncAt ?? null,
  };
}
