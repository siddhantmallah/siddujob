import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db, applications, jobs, replies, logEvent,
  type ReplyKind, type ApplicationStatus,
} from "@/db";
import { structured, llmAvailable } from "@/lib/llm";
import { notify } from "@/lib/notify";
import { truncate } from "@/lib/utils";

/**
 * Watches your Gmail for anything that looks like a response to an application,
 * works out which application it belongs to, reads it, and tells you.
 *
 * This is the part you actually asked for: you never have to refresh an inbox
 * hoping for good news — the good news finds you.
 */

const LOOKBACK_DAYS = 7;
const MAX_MESSAGES_PER_RUN = 60;

export type InboxSummary = {
  scanned: number;
  matched: number;
  newReplies: number;
  interviews: number;
  rejections: number;
  error?: string;
};

type Candidate = {
  applicationId: number;
  jobId: number;
  company: string;
  companyNorm: string;
  title: string;
  toEmail: string | null;
  subject: string | null;
  messageId: string | null;
};

/** Bare domain of an address, minus common mail subdomains. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return address.slice(at + 1).toLowerCase().replace(/^(mail|email|smtp|mx|reply|notifications)\./, "");
}

function registrableDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  // Handles co.uk / com.au style suffixes well enough for matching.
  const tail = parts.slice(-3).join(".");
  if (/\.(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(tail)) return tail;
  return parts.slice(-2).join(".");
}

/**
 * Which application is this email about?
 *
 * Ordered by how much we trust each signal: a threaded reply is certain, a
 * matching sender domain is strong, the company name in the subject is decent.
 */
function matchApplication(
  msg: { from: string; subject: string; body: string; inReplyTo: string; references: string },
  candidates: Candidate[],
): { candidate: Candidate; confidence: number } | null {
  const refs = `${msg.inReplyTo} ${msg.references}`;
  if (refs.trim()) {
    const threaded = candidates.find((c) => c.messageId && refs.includes(c.messageId));
    if (threaded) return { candidate: threaded, confidence: 1 };
  }

  const senderDomain = registrableDomain(domainOf(msg.from));
  if (senderDomain && !/^(gmail|googlemail|outlook|hotmail|yahoo|icloud|proton)\./.test(senderDomain + ".")) {
    const byDomain = candidates.filter(
      (c) => c.toEmail && registrableDomain(domainOf(c.toEmail)) === senderDomain,
    );
    if (byDomain.length === 1) return { candidate: byDomain[0], confidence: 0.9 };
    if (byDomain.length > 1) {
      // Same employer, several roles — disambiguate on the job title.
      const subjectLower = msg.subject.toLowerCase();
      const byTitle = byDomain.find((c) => subjectLower.includes(c.title.toLowerCase().slice(0, 24)));
      if (byTitle) return { candidate: byTitle, confidence: 0.9 };
      return { candidate: byDomain[0], confidence: 0.6 };
    }
  }

  const haystack = `${msg.subject} ${msg.body.slice(0, 900)}`.toLowerCase();
  const subjectMatch = candidates.find((c) => {
    const norm = c.companyNorm;
    return norm.length >= 4 && haystack.includes(norm);
  });
  if (subjectMatch) return { candidate: subjectMatch, confidence: 0.55 };

  const ourSubject = candidates.find(
    (c) => c.subject && msg.subject.toLowerCase().includes(c.subject.toLowerCase().slice(0, 30)),
  );
  if (ourSubject) return { candidate: ourSubject, confidence: 0.7 };

  return null;
}

/* ───────────────────────────── classification ──────────────────────── */

type Classification = {
  kind: ReplyKind;
  confidence: number;
  summary: string;
  action_required: boolean;
  suggested_reply: string;
};

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["interview", "offer", "rejection", "recruiter_question", "auto_ack", "other"],
      description: "auto_ack = automated 'we received your application'. recruiter_question = a human wants information before deciding.",
    },
    // strict mode rejects minimum/maximum; the range is stated instead.
    confidence: { type: "number", description: "0 to 1." },
    summary: { type: "string", description: "One sentence, plain English, what this email actually says." },
    action_required: { type: "boolean", description: "True if the candidate must do something (reply, book a slot, send documents)." },
    suggested_reply: {
      type: "string",
      description: "If action is required, a short polite draft reply as the candidate. Empty string otherwise. Never invent availability, salary figures, or facts.",
    },
  },
  required: ["kind", "confidence", "summary", "action_required", "suggested_reply"],
  additionalProperties: false,
} as const;

async function classify(msg: { from: string; subject: string; body: string }, jobTitle: string, company: string): Promise<Classification> {
  if (!llmAvailable()) {
    return heuristicClassify(msg);
  }
  try {
    return await structured<Classification>({
      system: [{
        text: "You triage replies to job applications. Be accurate about rejections — a rejection dressed up in warm language is still a rejection. An invitation to any call, screen, or chat counts as an interview.",
        cache: true,
      }],
      prompt: `The candidate applied for "${jobTitle}" at ${company}.

From: ${msg.from}
Subject: ${msg.subject}

${truncate(msg.body, 4000)}`,
      toolName: "classify_reply",
      toolDescription: "Record what this reply is.",
      schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 8000,
      effort: "low",
    });
  } catch {
    return heuristicClassify(msg);
  }
}

/** Used when the model is unavailable — deliberately conservative. */
function heuristicClassify(msg: { subject: string; body: string }): Classification {
  const text = `${msg.subject} ${msg.body}`.toLowerCase();
  if (/\b(unfortunately|not (be )?(pro|taking|moving) forward|unsuccessful|other candidates|decided not to|regret to inform)\b/.test(text)) {
    return { kind: "rejection", confidence: 0.7, summary: "Looks like a rejection.", action_required: false, suggested_reply: "" };
  }
  if (/\b(interview|schedule a (call|chat)|book a (slot|time)|availability|meet with|next stage|phone screen)\b/.test(text)) {
    return { kind: "interview", confidence: 0.7, summary: "Looks like an interview invitation.", action_required: true, suggested_reply: "" };
  }
  if (/\b(we have received|thank you for (your )?appl|application received|acknowledge receipt)\b/.test(text)) {
    return { kind: "auto_ack", confidence: 0.75, summary: "Automated acknowledgement.", action_required: false, suggested_reply: "" };
  }
  return { kind: "other", confidence: 0.3, summary: "Unclassified reply.", action_required: false, suggested_reply: "" };
}

const STATUS_FOR_KIND: Record<ReplyKind, ApplicationStatus | null> = {
  interview: "interview",
  offer: "offer",
  rejection: "rejected",
  recruiter_question: "replied",
  auto_ack: "acknowledged",
  other: "replied",
};

/* ───────────────────────────── main loop ──────────────────────────── */

export async function runInboxCheck(): Promise<InboxSummary> {
  const summary: InboxSummary = {
    scanned: 0, matched: 0, newReplies: 0, interviews: 0, rejections: 0,
  };

  if (!process.env.GMAIL_ADDRESS || !process.env.GMAIL_APP_PASSWORD) {
    return { ...summary, error: "Gmail credentials are not configured" };
  }

  const rows = await db
    .select({
      applicationId: applications.id,
      jobId: jobs.id,
      company: jobs.company,
      companyNorm: jobs.companyNorm,
      title: jobs.title,
      toEmail: applications.toEmail,
      subject: applications.subject,
      messageId: applications.messageId,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(inArray(applications.status, ["sent", "acknowledged", "replied", "interview"]));

  const candidates: Candidate[] = rows;
  if (!candidates.length) return summary;

  const knownUids = new Set(
    (await db.select({ uid: replies.uid }).from(replies)).map((r) => r.uid),
  );

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""),
    },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
      const collected: Array<{
        uid: string; from: string; fromName: string; subject: string;
        body: string; date: Date; inReplyTo: string; references: string;
      }> = [];

      for await (const message of client.fetch({ since }, { uid: true, source: true, envelope: true })) {
        if (collected.length >= MAX_MESSAGES_PER_RUN) break;
        const uid = `${message.uid}`;
        if (knownUids.has(uid)) continue;

        if (!message.source) continue;
        // mailparser overloads on a callback arg; pin the promise form.
        const parsed = (await (simpleParser(message.source) as Promise<ParsedMail>));
        const fromAddr = parsed.from?.value?.[0]?.address ?? "";
        if (!fromAddr) continue;
        // Ignore your own sent copies.
        if (fromAddr.toLowerCase() === process.env.GMAIL_ADDRESS!.toLowerCase()) continue;

        collected.push({
          uid,
          from: fromAddr,
          fromName: parsed.from?.value?.[0]?.name ?? "",
          subject: parsed.subject ?? "",
          body: (parsed.text ?? parsed.html ?? "").toString(),
          date: parsed.date ?? new Date(),
          inReplyTo: parsed.inReplyTo ?? "",
          references: Array.isArray(parsed.references)
            ? parsed.references.join(" ")
            : (parsed.references ?? ""),
        });
      }

      summary.scanned = collected.length;

      for (const msg of collected) {
        const match = matchApplication(msg, candidates);
        if (!match) continue;
        summary.matched++;

        const { candidate } = match;
        const result = await classify(msg, candidate.title, candidate.company);
        result.confidence = Math.min(1, Math.max(0, Number(result.confidence) || 0));

        await db.insert(replies).values({
          applicationId: candidate.applicationId,
          uid: msg.uid,
          fromAddress: msg.from,
          fromName: msg.fromName,
          subject: truncate(msg.subject, 500),
          body: truncate(msg.body, 8000),
          receivedAt: msg.date,
          kind: result.kind,
          confidence: result.confidence,
          summary: result.summary,
          suggestedReply: result.suggested_reply || null,
        }).onConflictDoNothing({ target: replies.uid });

        summary.newReplies++;
        if (result.kind === "interview" || result.kind === "offer") summary.interviews++;
        if (result.kind === "rejection") summary.rejections++;

        const nextStatus = STATUS_FOR_KIND[result.kind];
        if (nextStatus) {
          await db.update(applications).set({
            status: nextStatus,
            replyCount: sql`${applications.replyCount} + 1`,
            lastReplyAt: msg.date,
            updatedAt: new Date(),
          }).where(eq(applications.id, candidate.applicationId));
        }

        // Only interrupt you for things that matter.
        if (result.kind === "interview" || result.kind === "offer") {
          await notify({
            title: result.kind === "offer"
              ? `OFFER — ${candidate.company}`
              : `Interview — ${candidate.company}`,
            body: [
              `${candidate.title}`,
              result.summary,
              result.suggested_reply ? `\nSuggested reply:\n${result.suggested_reply}` : "",
            ].filter(Boolean).join("\n"),
            priority: "urgent",
          });
        } else if (result.kind === "recruiter_question") {
          await notify({
            title: `Question from ${candidate.company}`,
            body: `${candidate.title}\n${result.summary}`,
            priority: "urgent",
          });
        } else if (result.kind === "rejection") {
          await notify({
            title: `Rejected — ${candidate.company}`,
            body: candidate.title,
            priority: "low",
          });
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent("inbox", `Inbox check failed: ${truncate(message, 300)}`, { level: "error" });
    return { ...summary, error: message };
  } finally {
    try {
      await client.logout();
    } catch {
      /* connection already gone */
    }
  }

  await db.execute(sql`update settings set last_inbox_at = now() where id = 1`);

  if (summary.newReplies) {
    await logEvent("inbox", `${summary.newReplies} new replies (${summary.interviews} interviews)`, {
      meta: summary as unknown as Record<string, unknown>,
    });
  }

  return summary;
}

/** Marks every reply as seen — used by the "mark all read" button. */
export async function markRepliesNotified(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await db.update(replies).set({ notified: true }).where(inArray(replies.id, ids));
}
