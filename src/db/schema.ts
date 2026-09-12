import {
  pgTable, serial, text, integer, boolean, timestamp, jsonb, index, uniqueIndex, real,
} from "drizzle-orm/pg-core";

/** Singleton row (id = 1) describing you. Drives matching + cover letters. */
export const profile = pgTable("profile", {
  id: integer("id").primaryKey().default(1),
  fullName: text("full_name").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  location: text("location").notNull().default(""),
  linkedin: text("linkedin").notNull().default(""),
  github: text("github").notNull().default(""),
  website: text("website").notNull().default(""),
  headline: text("headline").notNull().default(""),
  summary: text("summary").notNull().default(""),
  /** string[] — canonical skills, used for cheap pre-scoring */
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  yearsExperience: integer("years_experience").notNull().default(0),
  /** string[] — job titles to search for */
  targetTitles: jsonb("target_titles").$type<string[]>().notNull().default([]),
  /** ISO-2 country codes: ["gb","de","nl",...] */
  targetCountries: jsonb("target_countries").$type<string[]>().notNull().default([]),
  minSalary: integer("min_salary").notNull().default(0),
  currency: text("currency").notNull().default("GBP"),
  needsSponsorship: boolean("needs_sponsorship").notNull().default(true),
  remoteOk: boolean("remote_ok").notNull().default(true),
  onsiteOk: boolean("onsite_ok").notNull().default(true),
  /** Raw text of your CV — the single source of truth for generation. */
  cvText: text("cv_text").notNull().default(""),
  cvFileName: text("cv_file_name").notNull().default("CV.pdf"),
  /** base64 of your real CV PDF, attached verbatim to every application */
  cvBase64: text("cv_base64"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Singleton row (id = 1) — the control panel for the automator. */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  /** Master switch. When false nothing is ever sent. */
  autoApply: boolean("auto_apply").notNull().default(false),
  /** Jobs scoring >= this get applied to automatically. 0-100. */
  autoApplyThreshold: integer("auto_apply_threshold").notNull().default(78),
  /** Hard ceiling on applications sent per calendar day. */
  dailyCap: integer("daily_cap").notNull().default(15),
  /** Minimum score to even keep a job in the list. */
  keepThreshold: integer("keep_threshold").notNull().default(45),
  /** Never auto-apply to a job at a company with no sponsor licence. */
  requireSponsor: boolean("require_sponsor").notNull().default(true),
  paused: boolean("paused").notNull().default(false),
  /** string[] — companies never to apply to */
  blockedCompanies: jsonb("blocked_companies").$type<string[]>().notNull().default([]),
  /** string[] — hard-block a job if its title/description contains these */
  blockedKeywords: jsonb("blocked_keywords").$type<string[]>().notNull().default([]),
  /**
   * Discovery is sliced across runs so a single serverless invocation always
   * finishes inside its time limit. This is the rotating position in the
   * search-term list.
   */
  ingestCursor: integer("ingest_cursor").notNull().default(0),
  /** Name of the task currently running, so the UI can show progress. */
  runningTask: text("running_task"),
  runningSince: timestamp("running_since", { withTimezone: true }),
  lastRunSummary: text("last_run_summary"),
  lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
  lastApplyAt: timestamp("last_apply_at", { withTimezone: true }),
  lastInboxAt: timestamp("last_inbox_at", { withTimezone: true }),
});

/** "likely" = matched the register by name prefix, not exactly. Worth applying,
 *  but confirm on the advert before counting on it. */
export type SponsorStatus = "licensed" | "likely" | "unknown" | "not_required";
export type JobStatus = "new" | "scored" | "queued" | "applied" | "skipped" | "blocked" | "failed";

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  /** sha256(source + company + title + location) — the dedupe key */
  hash: text("hash").notNull(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull().default(""),
  url: text("url").notNull(),
  applyUrl: text("apply_url"),
  title: text("title").notNull(),
  company: text("company").notNull(),
  /** lowercased, suffixes stripped — used to join against the sponsor register */
  companyNorm: text("company_norm").notNull().default(""),
  location: text("location").notNull().default(""),
  country: text("country").notNull().default(""),
  remote: boolean("remote").notNull().default(false),
  description: text("description").notNull().default(""),
  salaryMin: integer("salary_min"),
  salaryMax: integer("salary_max"),
  currency: text("currency"),
  postedAt: timestamp("posted_at", { withTimezone: true }),

  /** Application routing */
  contactEmail: text("contact_email"),
  atsType: text("ats_type"),
  atsToken: text("ats_token"),

  /** Scoring */
  score: integer("score"),
  preScore: real("pre_score"),
  scoreReasons: jsonb("score_reasons").$type<string[]>(),
  scoreConcerns: jsonb("score_concerns").$type<string[]>(),

  /** Visa */
  sponsorStatus: text("sponsor_status").$type<SponsorStatus>().notNull().default("unknown"),
  sponsorMatchedName: text("sponsor_matched_name"),
  sponsorRoutes: jsonb("sponsor_routes").$type<string[]>(),
  blueCardOk: boolean("blue_card_ok"),
  visaNote: text("visa_note"),

  status: text("status").$type<JobStatus>().notNull().default("new"),
  skipReason: text("skip_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("jobs_hash_idx").on(t.hash),
  index("jobs_status_idx").on(t.status),
  index("jobs_score_idx").on(t.score),
  index("jobs_company_norm_idx").on(t.companyNorm),
  index("jobs_created_idx").on(t.createdAt),
]);

export type ApplicationStatus =
  | "queued" | "sent" | "failed" | "acknowledged"
  | "replied" | "interview" | "rejected" | "offer" | "withdrawn";
export type ApplyChannel = "email" | "ats" | "manual" | "worker";

export const applications = pgTable("applications", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  status: text("status").$type<ApplicationStatus>().notNull().default("queued"),
  channel: text("channel").$type<ApplyChannel>().notNull().default("manual"),
  /** true when the automator sent it with no human in the loop */
  autonomous: boolean("autonomous").notNull().default(false),
  subject: text("subject"),
  coverLetter: text("cover_letter"),
  toEmail: text("to_email"),
  messageId: text("message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  replyCount: integer("reply_count").notNull().default(0),
  lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
  /** Set when you want a nudge if nobody answers */
  followUpAt: timestamp("follow_up_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("app_job_idx").on(t.jobId),
  index("app_status_idx").on(t.status),
  index("app_sent_idx").on(t.sentAt),
]);

export type ReplyKind =
  | "interview" | "rejection" | "recruiter_question" | "auto_ack" | "offer" | "other";

export const replies = pgTable("replies", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").references(() => applications.id, { onDelete: "set null" }),
  /** Gmail UID we already processed — stops double-notifying */
  uid: text("uid").notNull(),
  fromAddress: text("from_address").notNull().default(""),
  fromName: text("from_name").notNull().default(""),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  kind: text("kind").$type<ReplyKind>().notNull().default("other"),
  confidence: real("confidence"),
  summary: text("summary"),
  suggestedReply: text("suggested_reply"),
  notified: boolean("notified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("replies_uid_idx").on(t.uid),
  index("replies_app_idx").on(t.applicationId),
]);

/** UK Home Office Register of Licensed Sponsors, refreshed from gov.uk. */
export const sponsors = pgTable("sponsors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  nameNorm: text("name_norm").notNull(),
  town: text("town").notNull().default(""),
  county: text("county").notNull().default(""),
  rating: text("rating").notNull().default(""),
  routes: jsonb("routes").$type<string[]>().notNull().default([]),
}, (t) => [
  index("sponsors_norm_idx").on(t.nameNorm),
]);

/**
 * Results of probing a company slug against the public ATS job-board APIs.
 *
 * Every probe is recorded, hit or miss, so the same slug is never requested
 * twice. That keeps repeat runs free and keeps the request volume against those
 * public endpoints modest and incremental.
 */
export const atsBoards = pgTable("ats_boards", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull(),
  platform: text("platform").$type<"greenhouse" | "lever" | "ashby">().notNull(),
  /** The sponsor-register name that produced this slug. */
  sponsorName: text("sponsor_name").notNull().default(""),
  sponsorNorm: text("sponsor_norm").notNull().default(""),
  found: boolean("found").notNull().default(false),
  /** Openings visible at probe time. A live board with 0 today may have some tomorrow. */
  openings: integer("openings").notNull().default(0),
  /** Whether this board is currently included in ingest. */
  enabled: boolean("enabled").notNull().default(true),
  probedAt: timestamp("probed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ats_slug_platform_idx").on(t.slug, t.platform),
  index("ats_found_idx").on(t.found),
]);

export const sponsorMeta = pgTable("sponsor_meta", {
  id: integer("id").primaryKey().default(1),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  rowCount: integer("row_count").notNull().default(0),
  sourceUrl: text("source_url"),
});

/** Append-only activity log shown on the dashboard. */
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  level: text("level").$type<"info" | "warn" | "error">().notNull().default("info"),
  message: text("message").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("events_created_idx").on(t.createdAt)]);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type Profile = typeof profile.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Reply = typeof replies.$inferSelect;
