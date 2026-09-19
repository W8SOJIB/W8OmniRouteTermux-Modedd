/**
 * Ensure Cursor catalog listings always expose OmniRoute's public auto-router
 * ids (`auto` + Cost/Balance/Intelligence variants). Live AvailableModels /
 * cursor-agent often return wire id `default` only.
 */

export type CursorAutoCatalogEntry = {
  id: string;
  name: string;
  owned_by?: string;
  [key: string]: unknown;
};

export const CURSOR_AUTO_ROUTER_VARIANT_IDS = [
  "auto-cost",
  "auto-balance",
  "auto-intelligence",
] as const;

const CURSOR_AUTO_ROUTER_VARIANT_NAMES: Record<
  (typeof CURSOR_AUTO_ROUTER_VARIANT_IDS)[number],
  string
> = {
  "auto-cost": "Auto (cost)",
  "auto-balance": "Auto (balance)",
  "auto-intelligence": "Auto (intelligence)",
};

/** Cursor auto-router: catalog id `auto`, wire id `default`. Always keep `auto` visible. */
export function ensureCursorAutoCatalogEntry<T extends CursorAutoCatalogEntry>(models: T[]): T[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const out = [...models];

  if (!byId.has("auto")) {
    const defaultEntry = byId.get("default");
    const autoEntry = {
      id: "auto",
      name:
        typeof defaultEntry?.name === "string" && defaultEntry.name.trim()
          ? defaultEntry.name
          : "Auto (current, default)",
      owned_by: "cursor",
    } as T;
    out.unshift(autoEntry);
    byId.set("auto", autoEntry);
  }

  for (const id of CURSOR_AUTO_ROUTER_VARIANT_IDS) {
    if (byId.has(id)) continue;
    const entry = {
      id,
      name: CURSOR_AUTO_ROUTER_VARIANT_NAMES[id],
      owned_by: "cursor",
    } as T;
    out.push(entry);
    byId.set(id, entry);
  }

  return out;
}
