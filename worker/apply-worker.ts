/**
 * Local browser worker.
 *
 * Vercel cannot run a headless browser, so anything that needs a form filled in
 * happens here, on your machine. It pulls the queue the web app built (job +
 * finished cover letter + your CV), drives the ATS form, and reports back.
 *
 *   npm run worker            dry run — fills everything, submits nothing
 *   npm run worker -- --submit   live — actually submits
 *   npm run worker -- --headed   watch it work
 *
 * First run: npm run worker:install
 *
 * It handles Greenhouse, Lever, Ashby, Workable and generic forms. Anything
 * with a login wall, a CAPTCHA or unusual custom questions is reported back as
 * "needs_human" and left for you — by design. Guessing at a question you have
 * not seen is how a good application becomes an embarrassing one.
 */

import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { chromium, type Page, type Browser, type Locator } from "playwright";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const CRON_SECRET = process.env.CRON_SECRET ?? "";

const args = process.argv.slice(2);
const SUBMIT = args.includes("--submit");
const HEADED = args.includes("--headed");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 10);

type QueueItem = {
  applicationId: number;
  jobId: number;
  title: string;
  company: string;
  url: string;
  atsType: string | null;
  score: number | null;
  subject: string | null;
  coverLetter: string | null;
};

type WorkerProfile = {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
  cvFileName: string;
  cvBase64: string | null;
  needsSponsorship: boolean;
  yearsExperience: number;
};

/* ────────────────────────────── API ────────────────────────────── */

async function fetchQueue(): Promise<{ profile: WorkerProfile; queue: QueueItem[] }> {
  const res = await fetch(`${APP_URL}/api/worker`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  if (!res.ok) throw new Error(`Queue fetch failed: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ profile: WorkerProfile; queue: QueueItem[] }>;
}

async function report(
  applicationId: number,
  outcome: "submitted" | "failed" | "needs_human",
  detail: { error?: string; note?: string } = {},
): Promise<void> {
  if (!SUBMIT) return; // A dry run must never change server state.
  const res = await fetch(`${APP_URL}/api/worker`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationId, outcome, ...detail }),
  });
  if (!res.ok) console.warn(`  ! could not report result: HTTP ${res.status}`);
}

/* ─────────────────────────── field matching ────────────────────── */

type FieldSpec = {
  key: string;
  patterns: RegExp[];
  value: string;
  /** Skip if the field already has content. */
  skipIfFilled?: boolean;
};

/**
 * Everything we can say about a field: its name, id, placeholder, aria-label
 * and the text of its <label>. Matching on the union is far more reliable than
 * per-ATS selector lists that rot the moment a vendor ships a redesign.
 */
async function describeField(input: Locator): Promise<string> {
  const parts = await input.evaluate((el: Element) => {
    const node = el as HTMLInputElement;
    const bits: string[] = [
      node.name ?? "", node.id ?? "",
      node.getAttribute("placeholder") ?? "",
      node.getAttribute("aria-label") ?? "",
      node.getAttribute("data-qa") ?? "",
      node.getAttribute("autocomplete") ?? "",
    ];
    if (node.id) {
      const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (label) bits.push(label.textContent ?? "");
    }
    const wrapping = node.closest("label");
    if (wrapping) bits.push(wrapping.textContent ?? "");
    // Many React forms put the label in a sibling of the field's container.
    const container = node.closest("div,fieldset,section");
    if (container) {
      const heading = container.querySelector("label,legend,span[class*=label]");
      if (heading) bits.push(heading.textContent ?? "");
    }
    return bits.join(" ");
  });
  return parts.toLowerCase().replace(/\s+/g, " ").trim();
}

function specsFor(profile: WorkerProfile, item: QueueItem): FieldSpec[] {
  const [first, ...rest] = profile.fullName.split(/\s+/);
  const last = rest.join(" ");

  return [
    { key: "first name", patterns: [/first.?name|given.?name|forename/], value: first ?? "" },
    { key: "last name", patterns: [/last.?name|family.?name|surname/], value: last || first || "" },
    { key: "full name", patterns: [/^(.*\b)?(full.?name|your name|name)\b/], value: profile.fullName },
    { key: "email", patterns: [/e.?mail/], value: profile.email },
    { key: "phone", patterns: [/phone|mobile|telephone|tel\b/], value: profile.phone },
    { key: "linkedin", patterns: [/linked.?in/], value: profile.linkedin },
    { key: "github", patterns: [/git.?hub/], value: profile.github },
    { key: "website", patterns: [/website|portfolio|personal.?site|url/], value: profile.website },
    { key: "location", patterns: [/location|city|where are you based|current.?location/], value: profile.location },
    { key: "cover letter", patterns: [/cover.?letter|why do you want|message|additional information|tell us/], value: item.coverLetter ?? "" },
  ].filter((s) => s.value.trim().length > 0);
}

/** Questions we refuse to guess at — these hand the job back to you. */
const RISKY_QUESTION = /(salary|compensation|expected pay|notice period|right to work|visa|sponsorship|criminal|disability|ethnicity|gender|veteran|start date|available from|why do you want to work)/i;

/* ─────────────────────────── form driving ──────────────────────── */

async function fillForm(
  page: Page, profile: WorkerProfile, item: QueueItem, cvPath: string | null,
): Promise<{ filled: string[]; unanswered: string[] }> {
  const specs = specsFor(profile, item);
  const filled: string[] = [];
  const unanswered: string[] = [];

  const inputs = page.locator(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea',
  );
  const count = Math.min(await inputs.count(), 60);

  for (let i = 0; i < count; i++) {
    const field = inputs.nth(i);
    if (!(await field.isVisible().catch(() => false))) continue;
    if (!(await field.isEditable().catch(() => false))) continue;

    const description = await describeField(field).catch(() => "");
    if (!description) continue;

    const existing = await field.inputValue().catch(() => "");
    if (existing.trim()) continue;

    const spec = specs.find((s) => s.patterns.some((p) => p.test(description)));
    if (spec) {
      await field.fill(spec.value).catch(() => {});
      filled.push(spec.key);
      continue;
    }

    // A required field we have no answer for is a stop sign.
    const required = await field.evaluate(
      (el: Element) =>
        (el as HTMLInputElement).required ||
        el.getAttribute("aria-required") === "true",
    ).catch(() => false);

    if (required || RISKY_QUESTION.test(description)) {
      unanswered.push(description.slice(0, 90));
    }
  }

  // CV upload — almost always the field that decides whether this works.
  if (cvPath) {
    const fileInputs = page.locator('input[type="file"]');
    const fileCount = Math.min(await fileInputs.count(), 6);
    for (let i = 0; i < fileCount; i++) {
      const input = fileInputs.nth(i);
      const description = await describeField(input).catch(() => "");
      if (/cover.?letter/.test(description) && !/resume|cv/.test(description)) continue;
      await input.setInputFiles(cvPath).catch(() => {});
      filled.push("cv");
      break;
    }
  }

  return { filled, unanswered };
}

async function findSubmit(page: Page): Promise<Locator | null> {
  const candidates = [
    page.getByRole("button", { name: /submit application|submit|send application|apply now|apply$/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ];
  for (const candidate of candidates) {
    const first = candidate.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  return null;
}

/** Cookie banners swallow clicks on the submit button. Dismiss politely. */
async function dismissCookieBanner(page: Page): Promise<void> {
  const rejectFirst = page.getByRole("button", {
    name: /reject all|decline all|only necessary|essential only|reject/i,
  }).first();
  if (await rejectFirst.isVisible().catch(() => false)) {
    await rejectFirst.click({ timeout: 2500 }).catch(() => {});
    return;
  }
  const accept = page.getByRole("button", { name: /accept all|accept cookies|i agree|got it/i }).first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click({ timeout: 2500 }).catch(() => {});
  }
}

/**
 * Aggregators do not link to the employer — they link to their own landing
 * page, and put the real destination behind JavaScript. Measured: zero of six
 * Adzuna links exposed an onward URL in raw HTML. So the first job is to click
 * through to wherever the employer actually takes applications, which may open
 * in a new tab.
 */
const AGGREGATOR = /adzuna\.|reed\.co\.uk|indeed\.|totaljobs\.|cv-library\.|jobsite\.|monster\.|glassdoor\.|jobbird|stepstone/i;

async function followToEmployer(page: Page): Promise<Page> {
  if (!AGGREGATOR.test(page.url())) return page;

  const context = page.context();
  const before = page.url();

  const applyButton = page
    .getByRole("link", { name: /apply (now|for this|on)|apply$|view job|continue to/i })
    .or(page.getByRole("button", { name: /apply (now|for this|on)|apply$|continue to/i }))
    .first();

  if (!(await applyButton.isVisible().catch(() => false))) {
    return page;
  }

  // The click may navigate this tab or open a new one; handle both.
  const popupPromise = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await applyButton.click({ timeout: 12_000 }).catch(() => {});
  const popup = await popupPromise;

  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
    console.log(`  followed to ${safeHost(popup.url())} (new tab)`);
    return popup;
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  if (page.url() !== before) console.log(`  followed to ${safeHost(page.url())}`);
  return page;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

/** Some boards hide the form behind an "Apply for this job" button. */
async function revealForm(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /apply for this job|apply now|start application/i }).first();
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  const link = page.getByRole("link", { name: /apply for this job|apply now/i }).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
}

async function hasBlocker(page: Page): Promise<string | null> {
  const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (/recaptcha|hcaptcha|are you a robot|verify you are human/.test(body)) return "CAPTCHA on the page";
  if (/sign in to apply|log in to apply|create an account to apply/.test(body)) return "Requires an account";
  const iframes = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').count().catch(() => 0);
  if (iframes > 0) return "CAPTCHA iframe present";
  return null;
}

/* ──────────────────────────── main ─────────────────────────────── */

async function processOne(
  browser: Browser, profile: WorkerProfile, item: QueueItem, cvPath: string | null, shotDir: string,
): Promise<void> {
  const label = `${item.title} @ ${item.company}`;
  console.log(`\n→ ${label}  (score ${item.score ?? "?"})`);
  console.log(`  ${item.url}`);

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    locale: "en-GB",
  });
  const page = await context.newPage();

  try {
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
    await dismissCookieBanner(page);

    // An aggregator link lands on its own page, not the employer's form.
    const active = await followToEmployer(page);
    if (active !== page) await active.waitForTimeout(1500);
    await dismissCookieBanner(active);
    await revealForm(active);

    const blocker = await hasBlocker(active);
    if (blocker) {
      console.log(`  ⊘ ${blocker} — handing back to you`);
      await report(item.applicationId, "needs_human", { note: blocker });
      return;
    }

    const { filled, unanswered } = await fillForm(active, profile, item, cvPath);
    console.log(`  filled: ${filled.join(", ") || "nothing"}`);

    const shot = join(shotDir, `app-${item.applicationId}.png`);
    await active.screenshot({ path: shot, fullPage: true }).catch(() => {});

    if (!filled.includes("email")) {
      console.log("  ⊘ could not find an email field — this is not a standard form");
      await report(item.applicationId, "needs_human", { note: `No recognisable form at ${safeHost(active.url())}` });
      return;
    }

    if (unanswered.length) {
      console.log(`  ⊘ ${unanswered.length} question(s) I will not guess at:`);
      for (const q of unanswered.slice(0, 5)) console.log(`      · ${q}`);
      await report(item.applicationId, "needs_human", {
        note: `Unanswered: ${unanswered.slice(0, 4).join(" | ")}`,
      });
      return;
    }

    const submit = await findSubmit(active);
    if (!submit) {
      console.log("  ⊘ no submit button found");
      await report(item.applicationId, "needs_human", { note: "No submit button found" });
      return;
    }

    if (!SUBMIT) {
      console.log(`  ✓ DRY RUN — form is complete and would be submitted`);
      console.log(`    screenshot: ${shot}`);
      return;
    }

    await submit.click({ timeout: 15_000 });
    await active.waitForTimeout(4000);

    const after = (await active.locator("body").innerText().catch(() => "")).toLowerCase();
    const confirmed = /thank you|application (has been )?(received|submitted|sent)|we.{0,10}(have|ve) received|successfully applied|application complete/.test(after);

    await active.screenshot({ path: join(shotDir, `app-${item.applicationId}-after.png`), fullPage: true }).catch(() => {});

    if (confirmed) {
      console.log("  ✓ submitted and confirmed");
      await report(item.applicationId, "submitted", { note: "Confirmation text seen on the page" });
    } else {
      // Clicked, but nothing said it worked. Never claim a send we cannot prove.
      console.log("  ? submitted but no confirmation text — flagged for you to verify");
      await report(item.applicationId, "needs_human", {
        note: "Clicked submit but saw no confirmation — check whether it went through",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${message}`);
    await report(item.applicationId, "failed", { error: message });
  } finally {
    await context.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  if (!CRON_SECRET) {
    console.error("CRON_SECRET is not set. Put it in .env alongside APP_URL.");
    process.exit(1);
  }

  console.log(`Job Finder worker → ${APP_URL}`);
  console.log(SUBMIT
    ? "MODE: LIVE — applications will actually be submitted"
    : "MODE: dry run — nothing will be submitted. Add --submit when the screenshots look right.");

  const { profile, queue } = await fetchQueue();
  if (!queue.length) {
    console.log("\nQueue is empty. Nothing to do.");
    return;
  }

  const work = queue.slice(0, LIMIT);
  console.log(`\n${queue.length} queued, processing ${work.length}`);

  const scratch = join(tmpdir(), `job-finder-worker-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });

  let cvPath: string | null = null;
  if (profile.cvBase64) {
    cvPath = join(scratch, profile.cvFileName || "CV.pdf");
    writeFileSync(cvPath, Buffer.from(profile.cvBase64, "base64"));
  } else {
    console.log("! No CV uploaded — forms requiring a CV will be handed back to you.");
  }

  const shotDir = join(process.cwd(), ".worker-data");
  mkdirSync(shotDir, { recursive: true });

  const browser = await chromium.launch({ headless: !HEADED });
  try {
    for (const item of work) {
      await processOne(browser, profile, item, cvPath, shotDir);
      // Behave like a person, not a scraper.
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\nDone. Screenshots in ${shotDir}`);
  if (!SUBMIT) console.log("This was a dry run. Re-run with --submit to send for real.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
