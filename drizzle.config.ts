import type { Config } from "drizzle-kit";
import dotenv from "dotenv";

// override: a machine-wide DATABASE_URL must not outrank this project's .env.
dotenv.config({ override: true, quiet: true });

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.JOBFINDER_DATABASE_URL || process.env.DATABASE_URL!,
  },
} satisfies Config;
