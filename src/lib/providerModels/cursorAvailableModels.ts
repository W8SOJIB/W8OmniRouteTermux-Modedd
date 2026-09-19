/**
 * Fetch Cursor Available Models via HTTP (no cursor-agent binary required).
 * Uses Connect-RPC JSON against api2.cursor.sh AiService/AvailableModels.
 */

import { CURSOR_CONFIG } from "@/lib/oauth/constants/oauth";
import { CursorService } from "@/lib/oauth/services/cursor";
import {
  humanizeCursorModelId,
  type CursorAgentModelEntry,
} from "@/lib/providerModels/cursorAgent";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export type FetchCursorAvailableModelsOptions = {
  accessToken: string;
  machineId?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickModelId(entry: Record<string, unknown>): string | null {
  for (const key of ["name", "modelId", "model_id", "id", "slug"]) {
    const v = entry[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickModelName(entry: Record<string, unknown>, id: string): string {
  for (const key of ["displayName", "display_name", "title", "label"]) {
    const v = entry[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return humanizeCursorModelId(id);
}

/**
 * Normalize AvailableModels JSON (Connect JSON or protobuf-json) into catalog rows.
 * Exported for unit tests.
 *
 * Always ensures catalog id `auto` is present (Cursor often returns wire id `default`
 * only). OmniRoute clients request `cu/auto`; resolveRequestedModel maps it to `default`.
 */
export function normalizeCursorAvailableModelsPayload(payload: unknown): CursorAgentModelEntry[] {
  const root = asRecord(payload) ?? {};
  const candidates: unknown[] = [];

  for (const key of ["models", "availableModels", "available_models", "model"]) {
    const v = root[key];
    if (Array.isArray(v)) candidates.push(...v);
  }

  // Some Connect JSON responses nest under `models.models` or similar
  const nestedModels = asRecord(root.models);
  if (nestedModels) {
    for (const key of ["models", "items", "list"]) {
      const v = nestedModels[key];
      if (Array.isArray(v)) candidates.push(...v);
    }
  }

  if (Array.isArray(payload)) candidates.push(...payload);

  const seen = new Set<string>();
  const out: CursorAgentModelEntry[] = [];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      const id = item.trim();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: humanizeCursorModelId(id), owned_by: "cursor" });
      continue;
    }
    const rec = asRecord(item);
    if (!rec) continue;
    const id = pickModelId(rec);
    if (!id || seen.has(id)) continue;
    // Prefer usable / non-disabled when flags exist
    if (rec.disabled === true || rec.isDisabled === true) continue;
    if (rec.usable === false || rec.isUsable === false) continue;
    seen.add(id);
    out.push({ id, name: pickModelName(rec, id), owned_by: "cursor" });
  }

  return ensureCursorAutoCatalogEntry(out);
}

/** OpenCodex-style Cursor Router optimization modes (catalog ids). */
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
export function ensureCursorAutoCatalogEntry(
  models: CursorAgentModelEntry[]
): CursorAgentModelEntry[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const out = [...models];

  if (!byId.has("auto")) {
    const defaultEntry = byId.get("default");
    const autoEntry: CursorAgentModelEntry = {
      id: "auto",
      name: defaultEntry?.name || "Auto (current, default)",
      owned_by: "cursor",
    };
    // Prefer `auto` as the public id; keep `default` for wire-compat listings.
    out.unshift(autoEntry);
    byId.set("auto", autoEntry);
  }

  // Always expose Cost/Balance/Intelligence router modes (OpenCodex CURSOR_ROUTER_MODEL_IDS).
  for (const id of CURSOR_AUTO_ROUTER_VARIANT_IDS) {
    if (byId.has(id)) continue;
    const entry: CursorAgentModelEntry = {
      id,
      name: CURSOR_AUTO_ROUTER_VARIANT_NAMES[id],
      owned_by: "cursor",
    };
    out.push(entry);
    byId.set(id, entry);
  }

  return out;
}

export async function fetchCursorAvailableModels(
  options: FetchCursorAvailableModelsOptions
): Promise<CursorAgentModelEntry[]> {
  const { accessToken, signal } = options;
  if (!accessToken) throw new Error("Cursor access token is required for AvailableModels");

  const machineId = options.machineId || (await getConsistentMachineId());
  const cursorService = new CursorService();
  const headers = {
    ...cursorService.buildHeaders(accessToken, machineId),
    // Prefer Connect JSON so we can parse without a protobuf schema
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const url = `${CURSOR_CONFIG.apiEndpoint}${CURSOR_CONFIG.modelsEndpoint}`;
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: "{}",
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Cursor AvailableModels failed: ${response.status}${text ? ` ${text.slice(0, 200)}` : ""}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("proto") || contentType.includes("protobuf")) {
    throw new Error(
      "Cursor AvailableModels returned protobuf; JSON catalog unavailable for this client version"
    );
  }

  const payload = await response.json();
  const models = normalizeCursorAvailableModelsPayload(payload);
  if (models.length === 0) {
    throw new Error("Cursor AvailableModels returned no models");
  }
  return models;
}
