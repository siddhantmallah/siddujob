import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, profile as profileTable, settings as settingsTable, getProfile, getSettings } from "../src/db";
import { extractCvText, cvLooksUsable } from "../src/lib/cv";
import { UK_SALARY } from "../src/lib/visa";

/**
 * Seeds the profile from a CV PDF.
 *   npm run seed:profile -- "path/to/CV.pdf"
 *
 * Identity is read out of the CV itself rather than hardcoded, so no personal
 * details live in the repository and this works for any CV. Everything is
 * editable afterwards on the Profile page.
 */

const CV_PATH = process.argv[2];
if (!CV_PATH) {
  console.error('usage: npm run seed:profile -- "path/to/CV.pdf"');
  process.exit(1);
}

/** Contact details, pulled from the top of the CV where they always live. */
function parseIdentity(text: string) {
  const head = text.slice(0, 900);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const email = head.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  const phone = head.match(/(\+\d{1,3}[\s-]?)?\(?\d[\d\s().-]{7,}\d/)?.[0]?.trim() ?? "";
  const linkedin = head.match(/(?:linkedin\.com\/in\/)[A-Za-z0-9-]+/i)?.[0] ?? "";
  const github = head.match(/(?:github\.com\/)[A-Za-z0-9-]+/i)?.[0] ?? "";

  // The name is nearly always the first non-empty line, often in capitals.
  const rawName = lines[0] ?? "";
  const fullName = /^[A-Z\s.'-]{4,60}$/.test(rawName)
    ? rawName.replace(/\s+/g, " ").trim().replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())
    : rawName.slice(0, 60);

  // A line near the top mentioning a place, minus the contact details.
  const locationLine = lines.slice(1, 5).find((l) => /,|\bUK\b|\bIndia\b|based|relocat/i.test(l)) ?? "";
  const location = locationLine
    .split(/[-–|]/)
    .map((p) => p.trim())
    .find((p) => p && !p.includes("@") && !/\d{6,}/.test(p) && !/linkedin|github/i.test(p)) ?? "";

  const headline = lines[1] && !lines[1].includes("@") ? lines[1].slice(0, 160) : "";

  return { fullName, email, phone, linkedin, github, location, headline };
}

/**
 * Target titles become the literal search strings sent to every job board, so
 * they matter more than any other field. Override with --titles="A,B,C".
 */
const DEFAULT_TITLES = [
  "Information Security Analyst",
  "Cyber Security Analyst",
  "SOC Analyst",
  "Security Engineer",
  "IT Security Manager",
  "Infrastructure Engineer",
  "Systems Administrator",
  "IT Manager",
  "Security Operations Engineer",
  "Windows Systems Engineer",
];

const DEFAULT_SKILLS = [
  "Active Directory", "Group Policy", "Windows Server", "Linux",
  "FortiGate", "SonicWall", "Sophos", "Symantec", "firewall",
  "endpoint security", "incident response", "root cause analysis",
  "ISO 27001", "vulnerability management", "patch management",
  "IDS", "IPS", "DLP", "SIEM", "Nessus", "Nmap", "Burp Suite",
  "Microsoft 365", "conditional access", "MFA", "identity and access management",
  "ServiceNow", "Freshservice", "ITIL", "VMware", "Azure", "AWS",
  "DNS", "DHCP", "backup", "disaster recovery", "CEH", "VAPT",
];

const DEFAULT_COUNTRIES = ["gb", "ie", "nl", "de", "pl", "pt", "cz", "at", "fi", "es"];

function flag(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

function listFlag(name: string, fallback: string[]): string[] {
  const raw = flag(name);
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

(async () => {
  const pdf = readFileSync(CV_PATH);
  const { text, pages } = await extractCvText(pdf);
  const usable = cvLooksUsable(text);

  console.log(`CV: ${pages} pages, ${text.split(/\s+/).length} words extracted`);
  if (!usable.ok) {
    console.error(`refusing to seed — ${usable.reason}`);
    process.exit(1);
  }

  const id = parseIdentity(text);
  await getProfile();
  await getSettings();

  await db.update(profileTable).set({
    fullName: flag("name") ?? id.fullName,
    email: flag("email") ?? id.email,
    phone: flag("phone") ?? id.phone,
    location: flag("location") ?? id.location,
    linkedin: id.linkedin,
    github: id.github,
    headline: flag("headline") ?? id.headline,
    skills: listFlag("skills", DEFAULT_SKILLS),
    yearsExperience: Number(flag("years") ?? 10),
    targetTitles: listFlag("titles", DEFAULT_TITLES),
    targetCountries: listFlag("countries", DEFAULT_COUNTRIES),
    // The Skilled Worker floor, not a personal preference. Below this figure no
    // UK employer can sponsor the role at all, so anything cheaper is noise.
    minSalary: Number(flag("minSalary") ?? UK_SALARY.general),
    currency: "GBP",
    needsSponsorship: flag("sponsorship") !== "false",
    remoteOk: true,
    onsiteOk: true,
    cvText: text,
    cvFileName: CV_PATH.split(/[\\/]/).pop() ?? "CV.pdf",
    cvBase64: pdf.toString("base64"),
    updatedAt: new Date(),
  }).where(eq(profileTable.id, 1));

  await db.update(settingsTable).set({
    requireSponsor: true,
    autoApplyThreshold: 78,
    keepThreshold: 45,
    dailyCap: 12,
    blockedKeywords: [
      "security clearance", "sc cleared", "dv cleared",
      "must be a british citizen", "sole british national",
      "unpaid", "commission only",
    ],
  }).where(eq(settingsTable.id, 1));

  const saved = await getProfile();
  console.log("\nprofile seeded (edit anything on the Profile page)");
  console.log(`  name          ${saved.fullName || "(not detected — pass --name=)"}`);
  console.log(`  email         ${saved.email || "(not detected — pass --email=)"}`);
  console.log(`  location      ${saved.location || "(not detected — pass --location=)"}`);
  console.log(`  experience    ${saved.yearsExperience} years`);
  console.log(`  titles        ${saved.targetTitles.length} search terms`);
  console.log(`  countries     ${saved.targetCountries.join(", ")}`);
  console.log(`  min salary    £${saved.minSalary.toLocaleString("en-GB")} (Skilled Worker floor)`);
  console.log(`  CV            ${saved.cvText.length.toLocaleString("en-GB")} chars + PDF attached`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
