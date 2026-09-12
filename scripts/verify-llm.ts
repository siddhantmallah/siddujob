import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { MODEL, llmAvailable, usageTotals, resetUsage } from "../src/lib/llm";
import { generateCoverLetter } from "../src/pipeline/generate";
import { scoreWithLlm } from "../src/pipeline/score";
import type { Job, Profile } from "../src/db/schema";

/**
 * Exercises the real scoring and cover-letter paths against the live API, and
 * reports what a run actually costs. Spends real money — a few pence.
 *   npm run verify:llm
 */

const CV = `Siddhant — IT Infrastructure Engineer
5 years supporting Windows Server 2016/2019 and Active Directory for a 400-seat
manufacturing business. Day to day: Microsoft 365 and Intune administration,
Azure AD Connect, Hyper-V, VMware vSphere, and a Veeam backup estate.
Automated user onboarding with PowerShell, cutting provisioning from 40 minutes
to under 5. Ran a 200-mailbox Exchange to Exchange Online migration.
Second-line escalation point, ITIL v4 Foundation, CompTIA Network+.
Comfortable with Cisco switching, VLANs and firewall rule management.`;

const profile = {
  id: 1,
  fullName: "Siddhant",
  email: "test@example.com",
  phone: "+44 7700 900000",
  location: "London, UK",
  linkedin: "linkedin.com/in/example",
  github: "",
  website: "",
  headline: "IT Infrastructure Engineer",
  summary: "",
  skills: ["Active Directory", "Azure", "Intune", "PowerShell", "VMware", "Veeam"],
  yearsExperience: 5,
  targetTitles: ["Infrastructure Engineer"],
  targetCountries: ["gb"],
  minSalary: 45000,
  currency: "GBP",
  needsSponsorship: true,
  remoteOk: true,
  onsiteOk: true,
  cvText: CV,
  cvFileName: "CV.pdf",
  cvBase64: null,
  updatedAt: new Date(),
} as Profile;

function makeJob(over: Partial<Job>): Job {
  return {
    id: 1, hash: "t", source: "greenhouse", externalId: "1",
    url: "https://example.com/job", applyUrl: null,
    title: "Infrastructure Engineer", company: "Northgate Systems",
    companyNorm: "northgate", location: "Manchester, UK", country: "gb",
    remote: false, description: "", salaryMin: 48000, salaryMax: 55000,
    currency: "GBP", postedAt: new Date(), contactEmail: null,
    atsType: "greenhouse", atsToken: "northgate", score: null, preScore: null,
    scoreReasons: null, scoreConcerns: null, sponsorStatus: "licensed",
    sponsorMatchedName: "Northgate Systems Ltd", sponsorRoutes: ["Skilled Worker"],
    blueCardOk: null, visaNote: null, status: "scored", skipReason: null,
    createdAt: new Date(),
    ...over,
  } as Job;
}

/** Three adverts of deliberately different fit, to check the scorer discriminates. */
const JOBS = [
  makeJob({
    title: "Infrastructure Engineer (Windows & Azure)",
    company: "Northgate Systems",
    description: `Hybrid Windows and Azure estate, around 500 users.
Must have: Windows Server and Active Directory, Microsoft 365 and Intune,
PowerShell scripting, VMware or Hyper-V, backup and DR ownership.
Nice to have: Azure certifications, Cisco networking, ITIL.
Salary GBP 48,000-55,000. We are a licensed visa sponsor.`,
  }),
  makeJob({
    title: "Senior Machine Learning Engineer",
    company: "Deepwater Labs",
    description: `You will train and deploy large transformer models at scale.
Must have: 5+ years Python, PyTorch, distributed training on multi-GPU clusters,
publications at NeurIPS or ICML, strong grounding in linear algebra.
Salary GBP 95,000-130,000.`,
  }),
  makeJob({
    title: "1st Line Service Desk Analyst",
    company: "Ledbury IT",
    description: `Entry-level helpdesk role answering phones and logging tickets.
Password resets, printer support, basic Office troubleshooting.
No prior experience required, full training given. Salary GBP 22,000.`,
  }),
];

// $ per million tokens. Cache reads are 0.1x base input. Cache WRITES are
// 1.25x for a 5-minute TTL and 2x for a 1-hour one — the app uses 1h, so the
// write multiplier here is 2x and the break-even is three requests, not two.
const PRICE: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5": { in: 5, out: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { in: 2, out: 10, cacheRead: 0.2 },
};
const CACHE_WRITE_MULTIPLIER = 2; // 1-hour TTL

function costOf(model: string) {
  const usage = usageTotals();
  const p = PRICE[model] ?? PRICE["claude-opus-5"];
  const dollars =
    (usage.inputTokens / 1e6) * p.in +
    (usage.cacheWriteTokens / 1e6) * p.in * CACHE_WRITE_MULTIPLIER +
    (usage.cacheReadTokens / 1e6) * p.cacheRead +
    (usage.outputTokens / 1e6) * p.out;
  return { usage, dollars };
}

(async () => {
  if (!llmAvailable()) {
    console.log("ANTHROPIC_API_KEY not set — skipping");
    process.exit(0);
  }
  console.log(`model: ${MODEL}\n`);

  // ── Scoring: three jobs, one CV. Calls 2 and 3 should hit the cache. ──
  resetUsage();
  const t0 = Date.now();
  for (const job of JOBS) {
    try {
      const r = await scoreWithLlm(job, profile);
      const ratio = r.requirements_total
        ? `${r.requirements_met}/${r.requirements_total} must-haves`
        : "none parsed";
      console.log(
        `  ${String(r.fit_score).padStart(3)}  ${job.title.padEnd(42)} ${ratio}${r.worth_applying ? "" : "   not worth applying"}`,
      );
    } catch (err) {
      console.log(`  ERR  ${job.title} — ${(err as Error).message.slice(0, 200)}`);
      process.exit(1);
    }
  }
  const scoring = costOf(MODEL);
  console.log(`\nscoring   ${JOBS.length} jobs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  tokens  in ${scoring.usage.inputTokens}   out ${scoring.usage.outputTokens}`);
  console.log(`  cache   wrote ${scoring.usage.cacheWriteTokens}   read ${scoring.usage.cacheReadTokens}`);
  console.log(
    scoring.usage.cacheReadTokens > 0
      ? "  caching WORKING — the CV was re-read from cache, not re-billed"
      : "  caching NOT hit — prefix is probably under the model minimum",
  );
  console.log(`  cost    $${scoring.dollars.toFixed(4)}   (~$${(scoring.dollars / JOBS.length).toFixed(4)} per job)`);

  // ── Cover letter ──
  resetUsage();
  const t1 = Date.now();
  const letter = await generateCoverLetter(JOBS[0], profile);
  const letterCost = costOf(MODEL);

  console.log(`\ncover letter in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  subject ${letter.subject}`);
  console.log(`  length  ${letter.body.split(/\s+/).length} words`);
  console.log(`  cost    $${letterCost.dollars.toFixed(4)}`);

  const invented = ["AZ-104", "AZ-900", "MCSE", "CCNA", "AWS", "KUBERNETES"]
    .filter((c) => letter.body.toUpperCase().includes(c));
  console.log(
    invented.length
      ? `  WARNING invented: ${invented.join(", ")}`
      : "  grounding ok — nothing invented",
  );

  // ── What a real day costs ──
  const perJob = scoring.dollars / JOBS.length;
  const day = perJob * 40 + letterCost.dollars * 15;
  console.log(`\nprojected  40 jobs scored + 15 letters a day`);
  console.log(`  ~$${day.toFixed(2)}/day   ~$${(day * 30).toFixed(0)}/month on ${MODEL}`);
  process.exit(0);
})();
