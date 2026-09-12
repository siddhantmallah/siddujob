"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import {
  db, jobs, applications, profile as profileTable, settings as settingsTable,
  getProfile, getSettings, logEvent, type ApplicationStatus,
} from "@/db";
import { checkPassword, createSession, destroySession, requireAuth } from "@/lib/auth";
import { applyToJob } from "@/pipeline/apply";
import { rescoreJob } from "@/pipeline/score";
import { syncSponsorRegister } from "@/pipeline/sponsors";
import { runDiscovery } from "@/pipeline/run";
import { runInboxCheck } from "@/pipeline/inbox";
import { normalizeCompany } from "@/lib/utils";
import { verifyMail } from "@/lib/mail";
import { extractCvText, cvLooksUsable } from "@/lib/cv";

export type ActionState = { ok?: boolean; error?: string; message?: string };

/* ────────────────────────────── auth ────────────────────────────── */

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const password = String(formData.get("password") ?? "");
  if (!checkPassword(password)) {
    // Deliberately slow, so guessing is tedious.
    await new Promise((r) => setTimeout(r, 600));
    return { error: "Wrong password" };
  }
  await createSession();
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

/* ──────────────────────────── profile ──────────────────────────── */

function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function saveProfile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();

  const cv = formData.get("cvFile");
  let cvBase64: string | undefined;
  let cvFileName: string | undefined;
  let extracted: string | undefined;
  let extractionNote = "";

  if (cv instanceof File && cv.size > 0) {
    if (cv.type !== "application/pdf") {
      return { error: "CV must be a PDF — that is what employers expect" };
    }
    if (cv.size > 4 * 1024 * 1024) {
      return { error: "CV is larger than 4 MB; export a smaller PDF" };
    }
    const bytes = Buffer.from(await cv.arrayBuffer());
    cvBase64 = bytes.toString("base64");
    cvFileName = cv.name;

    // Read the text out of the PDF so you never have to paste it separately.
    // Anything you typed yourself wins — this only fills an empty box.
    try {
      const { text } = await extractCvText(bytes);
      const usable = cvLooksUsable(text);
      if (usable.ok) {
        extracted = text;
        extractionNote = ` and read ${text.split(/\s+/).length} words out of the PDF`;
      } else {
        extractionNote = ` — ${usable.reason}`;
      }
    } catch {
      extractionNote = " — could not read text from that PDF, paste it manually below";
    }
  }

  const typedCv = String(formData.get("cvText") ?? "").trim();
  const cvText = typedCv || extracted || "";

  await db.update(profileTable).set({
    fullName: String(formData.get("fullName") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim(),
    location: String(formData.get("location") ?? "").trim(),
    linkedin: String(formData.get("linkedin") ?? "").trim(),
    github: String(formData.get("github") ?? "").trim(),
    website: String(formData.get("website") ?? "").trim(),
    headline: String(formData.get("headline") ?? "").trim(),
    summary: String(formData.get("summary") ?? "").trim(),
    skills: splitList(formData.get("skills")),
    targetTitles: splitList(formData.get("targetTitles")),
    targetCountries: splitList(formData.get("targetCountries")).map((c) => c.toLowerCase()),
    yearsExperience: Number(formData.get("yearsExperience") ?? 0) || 0,
    minSalary: Number(formData.get("minSalary") ?? 0) || 0,
    currency: String(formData.get("currency") ?? "GBP"),
    needsSponsorship: formData.get("needsSponsorship") === "on",
    remoteOk: formData.get("remoteOk") === "on",
    onsiteOk: formData.get("onsiteOk") === "on",
    cvText,
    ...(cvBase64 ? { cvBase64, cvFileName } : {}),
    updatedAt: new Date(),
  }).where(eq(profileTable.id, 1));

  revalidatePath("/profile");
  revalidatePath("/");
  return {
    ok: true,
    message: cvBase64 ? `Profile and CV saved${extractionNote}` : "Profile saved",
  };
}

/* ──────────────────────────── settings ─────────────────────────── */

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAuth();

  const threshold = Number(formData.get("autoApplyThreshold") ?? 78);
  const cap = Number(formData.get("dailyCap") ?? 15);

  if (threshold < 50) {
    return { error: "Threshold below 50 would send applications you would be embarrassed by. Pick 50 or higher." };
  }
  if (cap > 40) {
    return { error: "Gmail throttles bulk sending and recruiters notice volume. Keep the daily cap at 40 or below." };
  }

  await db.update(settingsTable).set({
    autoApply: formData.get("autoApply") === "on",
    autoApplyThreshold: threshold,
    dailyCap: cap,
    keepThreshold: Number(formData.get("keepThreshold") ?? 45),
    requireSponsor: formData.get("requireSponsor") === "on",
    paused: formData.get("paused") === "on",
    blockedCompanies: splitList(formData.get("blockedCompanies")),
    blockedKeywords: splitList(formData.get("blockedKeywords")),
  }).where(eq(settingsTable.id, 1));

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, message: "Settings saved" };
}

export async function togglePause(): Promise<void> {
  await requireAuth();
  const current = await getSettings();
  await db.update(settingsTable)
    .set({ paused: !current.paused })
    .where(eq(settingsTable.id, 1));
  await logEvent("settings", current.paused ? "Automator resumed" : "Automator paused");
  revalidatePath("/");
}

/* ────────────────────────── job actions ────────────────────────── */

export async function applyNow(jobId: number): Promise<ActionState> {
  await requireAuth();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return { error: "Job not found" };

  const profile = await getProfile();
  if (!profile.cvText?.trim()) {
    return { error: "Add your CV text on the Profile page first — nothing can be written without it" };
  }

  const result = await applyToJob(job, profile, { autonomous: false });
  revalidatePath("/jobs");
  revalidatePath("/applications");

  if (!result.ok) return { error: result.error ?? "Could not apply" };
  return {
    ok: true,
    message: result.status === "sent"
      ? "Application emailed"
      : "Cover letter written — queued for the browser worker",
  };
}

export async function skipJob(jobId: number, reason = "Skipped by you"): Promise<void> {
  await requireAuth();
  await db.update(jobs).set({ status: "skipped", skipReason: reason }).where(eq(jobs.id, jobId));
  revalidatePath("/jobs");
}

export async function unskipJob(jobId: number): Promise<void> {
  await requireAuth();
  await db.update(jobs).set({ status: "scored", skipReason: null }).where(eq(jobs.id, jobId));
  revalidatePath("/jobs");
}

export async function blockCompanyForJob(jobId: number): Promise<void> {
  await requireAuth();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return;

  const current = await getSettings();
  const next = [...new Set([...current.blockedCompanies, job.company])];
  await db.update(settingsTable).set({ blockedCompanies: next }).where(eq(settingsTable.id, 1));

  const norm = normalizeCompany(job.company);
  const sameCompany = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.companyNorm, norm));
  if (sameCompany.length) {
    await db.update(jobs)
      .set({ status: "blocked", skipReason: "Company blocked by you" })
      .where(inArray(jobs.id, sameCompany.map((j) => j.id)));
  }

  await logEvent("settings", `Blocked ${job.company}`);
  revalidatePath("/jobs");
}

export async function rescore(jobId: number): Promise<void> {
  await requireAuth();
  await rescoreJob(jobId);
  revalidatePath("/jobs");
}

export async function setApplicationStatus(
  applicationId: number, status: ApplicationStatus,
): Promise<void> {
  await requireAuth();
  await db.update(applications)
    .set({ status, updatedAt: new Date() })
    .where(eq(applications.id, applicationId));
  revalidatePath("/applications");
}

/* ────────────────────────── maintenance ────────────────────────── */

export async function syncSponsorsNow(): Promise<ActionState> {
  await requireAuth();
  const result = await syncSponsorRegister();
  revalidatePath("/settings");
  revalidatePath("/");
  return result.ok
    ? { ok: true, message: `Synced ${result.rowCount.toLocaleString()} licensed sponsors` }
    : { error: result.error ?? "Sync failed" };
}

export async function runDiscoveryNow(): Promise<ActionState> {
  await requireAuth();
  try {
    const summary = await runDiscovery();
    revalidatePath("/");
    revalidatePath("/jobs");
    return {
      ok: true,
      message: `${summary.ingest?.inserted ?? 0} new jobs, ${summary.score?.keptAboveThreshold ?? 0} worth a look`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkInboxNow(): Promise<ActionState> {
  await requireAuth();
  const summary = await runInboxCheck();
  revalidatePath("/");
  revalidatePath("/applications");
  if (summary.error) return { error: summary.error };
  return {
    ok: true,
    message: summary.newReplies
      ? `${summary.newReplies} new replies (${summary.interviews} interviews)`
      : "No new replies",
  };
}

export async function testEmail(): Promise<ActionState> {
  await requireAuth();
  const result = await verifyMail();
  return result.ok
    ? { ok: true, message: "Gmail SMTP connected — sending will work" }
    : { error: result.error ?? "Could not connect to Gmail" };
}
