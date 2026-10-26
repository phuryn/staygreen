import { z } from "zod";
export const cliEnv = z.object({ STAYGREEN_API_TOKEN: z.preprocess(v => v === "" ? undefined : v,
  z.string().regex(/^sg_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/).optional()) });
