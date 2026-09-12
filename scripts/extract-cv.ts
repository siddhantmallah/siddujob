import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { readFileSync } from "node:fs";
import { extractCvText } from "../src/lib/cv";

const path = process.argv[2];
if (!path) { console.error("usage: tsx scripts/extract-cv.ts <file.pdf>"); process.exit(1); }

extractCvText(readFileSync(path)).then((r) => {
  console.log("pages: " + r.pages + "  chars: " + r.text.length);
  console.log("---");
  console.log(r.text);
}).catch((e) => { console.error(e.message); process.exit(1); });
