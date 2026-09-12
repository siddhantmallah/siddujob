/**
 * Checks the pure logic and the live external feeds without needing a database.
 *   npx tsx scripts/smoke-test.ts
 */
import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { normalizeCompany, jobHash, extractContactEmail, isRemote } from "../src/lib/utils";
import { assessUk, assessEu, looksLikeItRole } from "../src/lib/visa";
import { parseSponsorCsv } from "../src/pipeline/sponsors";
import { guessCountry } from "../src/sources/types";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`); }
}

function assert(name: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

console.log("\ncompany normalisation");
check("strips Ltd", normalizeCompany("Monzo Bank Ltd."), "monzo bank");
check("strips nested suffixes", normalizeCompany("Acme Technology Solutions Limited"), "acme");
check("handles ampersand", normalizeCompany("Marks & Spencer PLC"), "marks and spencer");
check("strips leading The", normalizeCompany("The Hut Group"), "hut");
check("case insensitive", normalizeCompany("MONZO BANK"), normalizeCompany("Monzo Bank Ltd"));
check("strips accents", normalizeCompany("Société Générale SA"), "societe generale");

console.log("\ndedupe hashing");
assert("same job from two boards collapses",
  jobHash({ company: "Monzo Bank Ltd", title: "DevOps Engineer (m/f/d)", location: "London, UK" }) ===
  jobHash({ company: "MONZO BANK", title: "DevOps Engineer", location: "London" }),
);
assert("different roles stay distinct",
  jobHash({ company: "Monzo", title: "DevOps Engineer", location: "London" }) !==
  jobHash({ company: "Monzo", title: "Network Engineer", location: "London" }),
);

console.log("\ncontact email extraction");
check("prefers a careers inbox",
  extractContactEmail("Questions? mail bob@acme.com or careers@acme.com"), "careers@acme.com");
check("drops no-reply", extractContactEmail("Sent by no-reply@indeed.com"), null);
check("nothing when absent", extractContactEmail("Apply on our website."), null);

console.log("\nremote detection");
check("fully remote", isRemote("DevOps Engineer", "Remote", "work from home"), true);
check("hybrid is not remote", isRemote("DevOps Engineer", "London", "hybrid, 3 days in office"), false);

console.log("\ncountry guessing");
check("London", guessCountry("London, Greater London"), "gb");
check("Berlin", guessCountry("Berlin, Germany"), "de");
check("Amsterdam", guessCountry("Amsterdam"), "nl");
check("unknown stays empty", guessCountry("Atlantis"), "");

console.log("\nUK visa gate");
{
  const noLicence = assessUk({
    hasSponsorLicence: false, sponsorNameMatched: null, salaryMin: 45000, salaryMax: 55000,
    currency: "GBP", descriptionLower: "great role", isNewEntrant: false,
  });
  assert("no licence blocks", noLicence.possible === false, noLicence.note);

  const lowPay = assessUk({
    hasSponsorLicence: true, sponsorNameMatched: "Acme Ltd", salaryMin: 26000, salaryMax: 28000,
    currency: "GBP", descriptionLower: "great role", isNewEntrant: false,
  });
  assert("below the absolute floor blocks", lowPay.possible === false, lowPay.note);

  const good = assessUk({
    hasSponsorLicence: true, sponsorNameMatched: "Acme Ltd", salaryMin: 45000, salaryMax: 55000,
    currency: "GBP", descriptionLower: "we can sponsor skilled worker visas", isNewEntrant: false,
  });
  assert("licensed + good salary passes", good.possible && good.penalty === 0, good.note);

  const explicitNo = assessUk({
    hasSponsorLicence: true, sponsorNameMatched: "Acme Ltd", salaryMin: 60000, salaryMax: 70000,
    currency: "GBP", descriptionLower: "we are unable to offer sponsorship for this role",
    isNewEntrant: false,
  });
  assert("ad saying no sponsorship wins over the register", explicitNo.possible === false, explicitNo.note);

  const newEntrant = assessUk({
    hasSponsorLicence: true, sponsorNameMatched: "Acme Ltd", salaryMin: 33000, salaryMax: 33000,
    currency: "GBP", descriptionLower: "junior role", isNewEntrant: true,
  });
  assert("new entrant clears the lower floor", newEntrant.possible, newEntrant.note);
}

console.log("\nEU visa gate");
{
  assert("IT role detected", looksLikeItRole("Infrastructure Engineer"));
  const deLow = assessEu({
    countryCode: "de", salaryMin: 32000, salaryMax: 34000, currency: "EUR",
    descriptionLower: "", isItRole: true,
  });
  assert("Germany below shortage floor blocks", deLow.possible === false, deLow.note);

  const deOk = assessEu({
    countryCode: "de", salaryMin: 55000, salaryMax: 65000, currency: "EUR",
    descriptionLower: "", isItRole: true,
  });
  assert("Germany above floor passes", deOk.possible && deOk.penalty === 0, deOk.note);

  const ieShortage = assessEu({
    countryCode: "ie", salaryMin: 42000, salaryMax: 45000, currency: "EUR",
    descriptionLower: "", isItRole: true,
  });
  assert("Ireland critical-skills floor applies to IT", ieShortage.possible, ieShortage.note);

  const noSalary = assessEu({
    countryCode: "nl", salaryMin: null, salaryMax: null, currency: null,
    descriptionLower: "", isItRole: true,
  });
  assert("unknown salary is uncertain, not blocked", noSalary.possible && noSalary.confidence < 0.5);
}

console.log("\nsponsor CSV parsing");
{
  const csv = [
    '"Organisation Name","Town/City","County","Type & Rating","Route"',
    '"Monzo Bank Ltd","London","","Worker (A rating)","Skilled Worker"',
    '"Monzo Bank Ltd","London","","Worker (A rating)","Global Business Mobility"',
    '"Acme Technology Solutions Limited","Manchester","Greater Manchester","Worker (A rating)","Skilled Worker"',
  ].join("\n");
  const rows = parseSponsorCsv(csv);
  check("collapses routes per employer", rows.length, 2);
  check("keeps both routes", rows[0].routes.length, 2);
  check("normalises for matching", rows[1].nameNorm, "acme");
}

async function liveChecks() {
  console.log("\nlive feeds (network)");

  try {
    const res = await fetch("https://www.arbeitnow.com/api/job-board-api?page=1");
    const data = (await res.json()) as { data?: unknown[] };
    assert("arbeitnow responds with jobs", Array.isArray(data.data) && data.data.length > 0);
  } catch (err) {
    failed++; console.log(`  FAIL arbeitnow — ${(err as Error).message}`);
  }

  try {
    const res = await fetch("https://remotive.com/api/remote-jobs?search=devops&limit=3");
    const data = (await res.json()) as { jobs?: unknown[] };
    assert("remotive responds with jobs", Array.isArray(data.jobs) && data.jobs.length > 0);
  } catch (err) {
    failed++; console.log(`  FAIL remotive — ${(err as Error).message}`);
  }

  try {
    const page = await fetch(
      "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers",
      { headers: { "user-agent": "job-finder/1.0 (personal job search tool)" } },
    );
    const html = await page.text();
    const matches = [...html.matchAll(
      /https:\/\/assets\.publishing\.service\.gov\.uk\/[^"'\s<>\\]+?\.csv/gi,
    )].map((m) => m[0]);
    assert("gov.uk sponsor register CSV link found", matches.length > 0,
      matches.length ? "" : "the page layout may have changed");

    if (matches.length) {
      const url = matches.find((u) => /worker/i.test(u)) ?? matches[0];
      console.log(`       ${url}`);
      const csvRes = await fetch(url, { headers: { "user-agent": "job-finder/1.0" } });
      const csv = await csvRes.text();
      const rows = parseSponsorCsv(csv);
      assert(`register parses (${rows.length.toLocaleString()} employers)`, rows.length > 1000);
      if (rows.length) {
        console.log(`       sample: ${rows[0].name} — ${rows[0].town} — ${rows[0].routes.join(", ")}`);
      }
    }
  } catch (err) {
    failed++; console.log(`  FAIL gov.uk register — ${(err as Error).message}`);
  }
}

liveChecks().then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});
