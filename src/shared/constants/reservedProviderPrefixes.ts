// Reserved provider prefixes — single source of truth shared by:
//
//   1. The runtime model resolver guard (src/sse/services/model.ts): user-defined
//      compatible-node prefixes must not be allowed to shadow built-in provider
//      ids/aliases, otherwise a node with prefix="cf" would hijack cloudflare-ai
//      requests (ported from upstream 9router 047fdc89).
//   2. The write-path validation schemas (createProviderNodeSchema /
//      updateProviderNodeSchema in src/shared/validation/schemas/provider.ts):
//      a prefix that the runtime will never honor must be rejected at creation
//      time with a clear message instead of silently routing to the built-in
//      provider (tokenrouter bug: "No active credentials for provider:
//      tokenrouter" despite a fully configured compatible node).
//
// Semantics (mirror the original inline runtime guard exactly):
//   - REGISTRY entry ids + aliases only. Manual alias ids outside REGISTRY
//     (xiaomi/llamacpp/aq) do NOT intercept nodes at runtime and are therefore
//     deliberately NOT reserved — including them would cause false-positive
//     rejections.
//   - Case-sensitive: mixed-case input like "TokenRouter" does not collide with
//     the runtime lookup (`Set.has` is exact-match), so it stays allowed.
import { REGISTRY } from "@omniroute/open-sse/config/providerRegistry.ts";

let _reserved: Set<string> | null = null;

function buildReservedProviderPrefixes(): Set<string> {
  if (_reserved) return _reserved;
  const reserved = new Set<string>();
  for (const entry of Object.values(REGISTRY)) {
    if (entry?.id) reserved.add(entry.id);
    if (entry?.alias) reserved.add(entry.alias);
  }
  _reserved = reserved;
  return reserved;
}

/**
 * All reserved provider prefixes (REGISTRY ids + aliases). Built lazily so the
 * registry is only walked once per process.
 */
export function getReservedProviderPrefixes(): ReadonlySet<string> {
  return buildReservedProviderPrefixes();
}

/**
 * Number of unique reserved prefixes (ids + aliases deduplicated). Exposed for
 * tests/docs so counts are measured, not memorized.
 */
export const RESERVED_PREFIX_COUNT = buildReservedProviderPrefixes().size;

/**
 * Frozen snapshot of the reserved set (test/documentation convenience). Prefer
 * `isReservedProviderPrefix` / `getReservedProviderPrefixes` on hot paths.
 */
export const RESERVED_PROVIDER_PREFIXES: ReadonlySet<string> = getReservedProviderPrefixes();

/**
 * True when `value` is a reserved provider prefix. Non-strings are never
 * reserved (mirrors the runtime guard's typeof check).
 */
export function isReservedProviderPrefix(value: unknown): boolean {
  return typeof value === "string" && buildReservedProviderPrefixes().has(value);
}

/**
 * Zod-friendly rejection message for a reserved prefix. Names the colliding
 * prefix and tells the operator what to pick instead.
 */
export function reservedProviderPrefixMessage(value: string): string {
  return `"${value}" is a reserved provider prefix — choose a different prefix (reserved ids/aliases cannot be used for custom nodes because requests like <prefix>/model would always route to the built-in provider)`;
}
