import { config } from "dotenv";

// The integration project reads the development project's keys from `.env`; the unit project never does.
config({ quiet: true });
