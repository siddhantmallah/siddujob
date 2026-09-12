import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

/**
 * Renders the cover letter to a real PDF. pdf-lib is pure JS, so this works on
 * Vercel serverless with no headless browser.
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 64;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 15.5;

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** pdf-lib's standard fonts are WinAnsi — strip anything they cannot encode. */
function sanitize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/•/g, "-")
    .replace(/[^\x20-\x7E\n\r\t\xA0-\xFF]/g, "");
}

export async function coverLetterPdf(opts: {
  body: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
  jobTitle: string;
  company: string;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  doc.setTitle(`Cover Letter — ${opts.fullName} — ${opts.jobTitle}`);
  doc.setAuthor(opts.fullName);
  doc.setSubject(`Application for ${opts.jobTitle} at ${opts.company}`);
  doc.setCreator("Job Finder");

  let page = doc.addPage([PAGE.width, PAGE.height]);
  const maxWidth = PAGE.width - MARGIN * 2;
  let y = PAGE.height - MARGIN;

  const ink = rgb(0.09, 0.09, 0.11);
  const muted = rgb(0.42, 0.44, 0.48);

  // Letterhead
  page.drawText(sanitize(opts.fullName), {
    x: MARGIN, y: y - 16, size: 19, font: bold, color: ink,
  });
  y -= 38;

  const contact = [opts.location, opts.phone, opts.email, ...opts.links]
    .filter(Boolean)
    .join("  ·  ");
  for (const line of wrap(sanitize(contact), regular, 9, maxWidth)) {
    page.drawText(line, { x: MARGIN, y, size: 9, font: regular, color: muted });
    y -= 12;
  }

  y -= 10;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE.width - MARGIN, y },
    thickness: 0.75,
    color: rgb(0.85, 0.86, 0.88),
  });
  y -= 26;

  const date = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
  page.drawText(sanitize(date), { x: MARGIN, y, size: 9.5, font: regular, color: muted });
  y -= 26;

  page.drawText(sanitize(`Re: ${opts.jobTitle} — ${opts.company}`), {
    x: MARGIN, y, size: 11.5, font: bold, color: ink,
  });
  y -= 26;

  // Body, flowing onto extra pages if needed
  for (const line of wrap(sanitize(opts.body), regular, BODY_SIZE, maxWidth)) {
    if (y < MARGIN + LINE_HEIGHT) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
    }
    if (line) {
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: regular, color: ink });
    }
    y -= LINE_HEIGHT;
  }

  return Buffer.from(await doc.save());
}
