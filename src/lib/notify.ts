import { sendMail, mailConfigured } from "./mail";

/**
 * Notifications go to Telegram first — it is instant, free, reaches your phone
 * without an app of mine, and cannot land in a spam folder. Email is the
 * fallback so a missed interview invite is impossible.
 */

function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegram(html: string): Promise<boolean> {
  if (!telegramConfigured()) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export type NotifyPriority = "urgent" | "normal" | "low";

/**
 * @param priority "urgent" also sends an email copy — reserved for the things
 *                 you asked to be told about immediately: replies and interviews.
 */
export async function notify(opts: {
  title: string;
  body: string;
  url?: string;
  priority?: NotifyPriority;
}): Promise<void> {
  const priority = opts.priority ?? "normal";
  const icon = priority === "urgent" ? "🔔" : priority === "low" ? "·" : "•";

  const parts = [`${icon} <b>${escapeHtml(opts.title)}</b>`, escapeHtml(opts.body)];
  if (opts.url) parts.push(`<a href="${escapeHtml(opts.url)}">Open</a>`);

  const delivered = await sendTelegram(parts.join("\n\n"));

  if (priority === "urgent" && mailConfigured()) {
    try {
      await sendMail({
        to: process.env.GMAIL_ADDRESS!,
        subject: `[Job Finder] ${opts.title}`,
        text: [opts.body, opts.url ?? ""].filter(Boolean).join("\n\n"),
      });
    } catch {
      // Telegram already tried; do not fail the pipeline over a notification.
    }
  } else if (!delivered && mailConfigured() && priority === "normal") {
    // Telegram not configured at all — fall back so nothing is silently lost.
    if (!telegramConfigured()) {
      try {
        await sendMail({
          to: process.env.GMAIL_ADDRESS!,
          subject: `[Job Finder] ${opts.title}`,
          text: [opts.body, opts.url ?? ""].filter(Boolean).join("\n\n"),
        });
      } catch {
        /* ignore */
      }
    }
  }
}

/** One-line summary after each pipeline run. Kept short on purpose. */
export async function notifyRunSummary(summary: {
  found: number;
  kept: number;
  applied: number;
  replies: number;
}): Promise<void> {
  if (summary.found === 0 && summary.applied === 0 && summary.replies === 0) return;
  await notify({
    title: "Pipeline run",
    body: [
      `${summary.found} new jobs found, ${summary.kept} worth keeping`,
      `${summary.applied} applications sent`,
      summary.replies ? `${summary.replies} new replies` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    priority: summary.replies > 0 ? "urgent" : "low",
  });
}
