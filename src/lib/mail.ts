import nodemailer, { type Transporter } from "nodemailer";

/**
 * Applications are sent from YOUR Gmail, not a service domain. Two reasons:
 * recruiters see a real person rather than a no-reply relay, and every reply
 * lands in your normal inbox where the reply-watcher can read it.
 *
 * Needs a Google App Password (2FA must be on):
 * https://myaccount.google.com/apppasswords
 */

let transporter: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD);
}

function getTransporter(): Transporter {
  if (!mailConfigured()) {
    throw new Error("GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set to send applications");
  }
  transporter ??= nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_ADDRESS,
      // App passwords are shown with spaces; Google ignores them but SMTP does not.
      pass: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
    },
  });
  return transporter;
}

export type Attachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
  replyTo?: string;
}): Promise<{ messageId: string }> {
  const from = process.env.GMAIL_FROM_NAME
    ? `"${process.env.GMAIL_FROM_NAME}" <${process.env.GMAIL_ADDRESS}>`
    : process.env.GMAIL_ADDRESS!;

  const info = await getTransporter().sendMail({
    from,
    to: opts.to,
    replyTo: opts.replyTo ?? process.env.GMAIL_ADDRESS,
    subject: opts.subject,
    text: opts.text,
    html: opts.html ?? textToHtml(opts.text),
    attachments: opts.attachments,
  });

  return { messageId: info.messageId };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textToHtml(text: string): string {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px 0">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">${body}</div>`;
}

/** Verifies SMTP credentials without sending anything. */
export async function verifyMail(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
