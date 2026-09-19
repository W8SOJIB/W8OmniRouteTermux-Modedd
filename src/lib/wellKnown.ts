import type { NextRequest } from "next/server";

/**
 * Derive the base URL for A2A agent card endpoints.
 * Prefers OMNIROUTE_BASE_URL env var for admin override; falls back to the
 * request's dynamic origin so the gateway works behind any hostname without
 * hardcoded localhost:20128 (S2 security fix).
 */
export function getBaseUrl(request: NextRequest): string {
  return process.env.OMNIROUTE_BASE_URL || request.nextUrl.origin;
}