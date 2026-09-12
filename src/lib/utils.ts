import { createHash } from "node:crypto";

/** Strip HTML tags and decode the handful of entities job boards actually emit. */
export function stripHtml(input: string): string {
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const COMPANY_SUFFIXES = [
  "limited", "ltd", "llp", "lp", "plc", "inc", "incorporated", "corp", "corporation",
  "company", "co", "gmbh", "mbh", "ag", "kg", "bv", "nv", "sa", "sas", "sarl", "srl",
  "spa", "oy", "ab", "as", "aps", "sp z oo", "sro", "holdings", "holding", "group",
  "uk", "ireland", "europe", "emea", "international", "global", "services", "solutions",
  "technologies", "technology",
];

/**
 * Canonical company key used to join job postings against the sponsor register.
 * Lowercase, punctuation dropped, legal suffixes removed. Deliberately lossy:
 * "Monzo Bank Ltd." and "MONZO BANK" must collapse to the same key.
 */
export function normalizeCompany(raw: string): string {
  let s = (raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (s.startsWith("the ")) s = s.slice(4);

  // Peel suffixes off the end repeatedly: "acme tech solutions ltd" -> "acme"
  let changed = true;
  while (changed && s.includes(" ")) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

/** Stable identity for a posting across sources, so the same job is stored once. */
export function jobHash(parts: {
  company: string; title: string; location: string; externalId?: string; source?: string;
}): string {
  const normTitle = (parts.title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(m|f|d|w|x)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normLoc = (parts.location || "").toLowerCase().split(",")[0].replace(/[^a-z0-9]+/g, "").trim();
  return createHash("sha256")
    .update([normalizeCompany(parts.company), normTitle, normLoc].join("|"))
    .digest("hex")
    .slice(0, 40);
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Junk addresses that appear in job text but are never the hiring contact. */
const EMAIL_DENYLIST = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "privacy", "gdpr", "dpo",
  "unsubscribe", "support@indeed", "info@adzuna", "example.com", "sentry.io",
  "@wixpress", "@sentry", "@google", "@w3.org", "@schema.org",
];

/**
 * Pull a hiring contact address out of a job description.
 * Returns null when nothing trustworthy is present — which is the common case,
 * and is exactly why most jobs route to the browser worker instead of email.
 */
export function extractContactEmail(text: string): string | null {
  const found = text.match(EMAIL_RE);
  if (!found) return null;
  const candidates = found
    .map((e) => e.toLowerCase())
    .filter((e) => !EMAIL_DENYLIST.some((bad) => e.includes(bad)))
    .filter((e) => !/\.(png|jpe?g|gif|svg|css|js)$/.test(e));
  if (!candidates.length) return null;

  // Prefer addresses that look like they belong to a human or a hiring inbox.
  const preferredPrefix = /^(careers|jobs|recruit|recruitment|hiring|hr|talent|apply|cv|vacancies)@/;
  return candidates.find((e) => preferredPrefix.test(e)) ?? candidates[0];
}

/**
 * Salary columns are integers, but job boards happily return floats
 * (Adzuna sends values like 36137.5) and occasionally junk. Coerce at the
 * ingest boundary so a single odd advert cannot abort a whole run.
 */
export function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  // Postgres int4 bounds — anything outside is bad data, not a salary.
  if (rounded < 0 || rounded > 2_147_483_647) return null;
  return rounded;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Run promises with a concurrency ceiling — job APIs rate-limit aggressively. */
export async function mapLimit<T, R>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** fetch with a timeout, because a hung job board must not hang the cron run. */
export async function fetchJson<T>(
  url: string, init: RequestInit = {}, timeoutMs = 20_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "job-finder/1.0", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${truncate(body, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function isRemote(title: string, location: string, description: string): boolean {
  const hay = `${title} ${location} ${description.slice(0, 1200)}`.toLowerCase();
  if (/\b(hybrid)\b/.test(hay) && !/\bfully remote\b/.test(hay)) return false;
  return /\b(remote|work from home|wfh|home[- ]based|telecommute)\b/.test(hay);
}
