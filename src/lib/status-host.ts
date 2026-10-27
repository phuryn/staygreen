import { publicEnvSchema } from "./env-schema";

/** A direct NEXT_PUBLIC access lets Next inline the same value into client components.
 * The schema owns the default and validates it at build time too. */
export const statusHost = () => publicEnvSchema.shape.NEXT_PUBLIC_STATUS_HOST.parse(process.env.NEXT_PUBLIC_STATUS_HOST);
