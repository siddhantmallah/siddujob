import { extractText, getDocumentProxy } from "unpdf";

/**
 * Pulls the text out of a CV PDF.
 *
 * This exists so you upload one file and the app has both what it attaches to
 * applications (the PDF, byte for byte) and what the matcher and letter writer
 * read (the text). Asking a person to paste their CV twice is how profiles end
 * up half-filled and letters end up generic.
 *
 * unpdf is a serverless build of pdf.js — no native binaries, works on Vercel.
 */
export async function extractCvText(
  pdf: Buffer | Uint8Array,
): Promise<{ text: string; pages: number }> {
  const bytes = pdf instanceof Buffer ? new Uint8Array(pdf) : pdf;
  const doc = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(doc, { mergePages: true });

  return { text: tidy(Array.isArray(text) ? text.join("\n") : text), pages: totalPages };
}

/**
 * PDF text extraction produces ragged output: hard-wrapped lines, bullet glyphs
 * that vary by font, and runs of whitespace where a two-column layout was.
 * Tidying it matters — the model reads this as evidence, and a mangled line is
 * a claim it cannot safely use.
 */
function tidy(raw: string): string {
  return raw
    // Normalise the bullet glyphs PDFs use interchangeably.
    .replace(/[•▪●◦⁃·]/g, "- ")
    .replace(/ /g, " ")
    // Ligatures that pdf.js leaves as single code points.
    .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl")
    // Curly punctuation to plain, so downstream PDF rendering can encode it.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    // Collapse the wide gaps left by multi-column layouts.
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, all) => line || all[i - 1])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Quick sanity signal for the upload UI. */
export function cvLooksUsable(text: string): { ok: boolean; reason?: string } {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 120) {
    return {
      ok: false,
      reason: `Only ${words} words came out — this may be a scanned image rather than a text PDF. Paste the text manually below.`,
    };
  }
  if (!/\b(experience|employment|work history|career|skills|education)\b/i.test(text)) {
    return {
      ok: false,
      reason: "No recognisable CV sections found. Check the extracted text below before saving.",
    };
  }
  return { ok: true };
}
