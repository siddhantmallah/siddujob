import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { getProfile, getSettings, logEvent } from "../src/db";
import { sponsorRegisterReady, lookupSponsors } from "../src/pipeline/sponsors";

// Exercises the real app code path against the live database.
(async () => {
  const profile = await getProfile();
  const settings = await getSettings();
  const register = await sponsorRegisterReady();
  const hits = await lookupSponsors(["monzo bank", "deloitte", "nonexistent firm xyz"]);
  await logEvent("setup", "Database verified from the app code path");

  console.log("profile row      id=" + profile.id + "  sponsorship=" + profile.needsSponsorship);
  console.log("settings row     autoApply=" + settings.autoApply + "  threshold=" + settings.autoApplyThreshold + "  cap=" + settings.dailyCap);
  console.log("sponsor register ready=" + register.ready + "  rows=" + register.rowCount.toLocaleString("en-GB"));
  console.log("lookup monzo     " + (hits.get("monzo bank")?.name ?? "MISS"));
  console.log("lookup deloitte  " + (hits.get("deloitte")?.name ?? "MISS"));
  console.log("lookup fake      " + (hits.get("nonexistent firm xyz")?.name ?? "(correctly no match)"));
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
