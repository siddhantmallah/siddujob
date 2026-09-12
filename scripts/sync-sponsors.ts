import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { syncSponsorRegister } from "../src/pipeline/sponsors";

// Populates the UK licensed-sponsor table. Run once after setting DATABASE_URL;
// after that the pipeline refreshes it weekly on its own.
syncSponsorRegister().then((result) => {
  if (result.ok) {
    console.log(`Synced ${result.rowCount.toLocaleString()} licensed sponsors`);
    console.log(`Source: ${result.sourceUrl}`);
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
});
