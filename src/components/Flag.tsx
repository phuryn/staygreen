import { locations, type LocationId } from "@/lib/plans";

/** A location's country flag, before its city (`design/README.md § Surfaces pinned outside the
 *  theme`). It is decoration: the city and the country in words carry the meaning, so it has no
 *  alt text. It says where a request came from, so it goes only where locations are listed: never
 *  beside a monitored address, on a public status page, in an alarm or in incident evidence,
 *  where its red would sit beside the red of down. */
export function Flag({ loc }: { loc: LocationId }) {
  return <img className="flag" src={`/flags/${locations[loc].flag}.svg`} alt="" width={16} height={12} />;
}
