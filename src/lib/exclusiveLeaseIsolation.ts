import { getExclusiveLeaseConnectionIds } from "./db/apiKeys";
import { isExclusiveConnectionActivelyLeased } from "./db/exclusiveConnectionLeases";

/** Narrow fail-closed boundary for auxiliary/unmanaged connection activity. */
export async function isConnectionUnavailableToAuxiliaryActivity(connectionId: string) {
  if (!connectionId || isExclusiveConnectionActivelyLeased(connectionId)) return true;
  return (await getExclusiveLeaseConnectionIds()).has(connectionId);
}
