import { lookup as systemLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { ipVersion, isLocalName, isPublicIp } from "../lib/ip";
import type { AddressGuard } from "./types";

/* The probe half of the private-range refusal (`AGENTS.md § 2.8`, `spec.md § 4`). The monitor
   was checked when it was saved (`src/lib/targets.ts`), but a name can move after that, so every
   connection resolves the name again and asks the guard about every address before the socket
   opens. The socket then connects to an address the guard passed, never to a second resolution
   of the same name, which is what makes DNS rebinding useless here.

   An IP literal never reaches a lookup function (Node connects to it directly), so `refusal`
   is asked first, by every check, for the host it is about to reach. */

export class PrivateAddressError extends Error {
  code = "EPRIVATE";
}

/** Why `host` may not be reached at all, or null. Covers IP literals and local-only names. */
export function refusal(host: string, allow: AddressGuard = isPublicIp): string | null {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (ipVersion(h)) return allow(h) ? null : `${h} is a private address`;
  if (allow === isPublicIp && isLocalName(h)) return `${h} only means something on a private network`;
  return null;
}

export function guardedLookup(allow: AddressGuard = isPublicIp): LookupFunction {
  return (hostname, options, callback) => {
    systemLookup(hostname, { family: options.family, hints: options.hints, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      if (list.length === 0) return callback(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }), "", 0);
      const blocked = list.find((a) => !allow(a.address));
      if (blocked) return callback(new PrivateAddressError(`${hostname} resolved to a private address (${blocked.address})`), "", 0);
      if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}
