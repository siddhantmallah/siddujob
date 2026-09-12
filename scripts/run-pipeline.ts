import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
import { runEverything } from "../src/pipeline/run";

// Runs the whole pipeline locally: discover, score, apply, check inbox.
// Useful for testing before the GitHub Actions schedule takes over.
runEverything()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
