/** Carry a clone destination through sign-in/sign-up without accepting an external redirect. */
export function cloneReturnPath(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && /^\/app\/clone\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value) ? value : undefined;
}
