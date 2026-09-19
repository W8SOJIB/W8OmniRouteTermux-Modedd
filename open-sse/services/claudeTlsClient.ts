/**
 * Browser-TLS-impersonating HTTP client for claude.ai.
 *
 * Thin re-export over the shared `tlsClientBase.ts` factory
 * (`createTlsClientModule`). All provider-agnostic logic (sidecar lifecycle,
 * streaming tail-file, proxy resolution, error classes, SSE detection) lives
 * in the base module; this file supplies only Claude-specific config and
 * preserves the original public export surface.
 */

import {
  createTlsClientModule,
  type TlsFetchOptions,
  type TlsFetchResult,
} from "./tlsClientBase.ts";

export const CLAUDE_TLS_BROWSER_MAJOR_VERSION = "146";

const DEFAULT_TIMEOUT_MS =
  Number.parseInt(process.env.OMNIROUTE_CLAUDE_TLS_TIMEOUT_MS || "", 10) || 60_000;
const HARD_TIMEOUT_GRACE_MS =
  Number.parseInt(process.env.OMNIROUTE_CLAUDE_TLS_GRACE_MS || "", 10) || 10_000;

export const tlsClientModule = createTlsClientModule({
  providerName: "Claude",
  tlsProfile: `chrome_${CLAUDE_TLS_BROWSER_MAJOR_VERSION}`,
  domain: "https://claude.ai",
  tempDirPrefix: "cgpt-stream-",
  tailFileVariant: "A",
  responseValidation: "sse",
  exportCloudflareCheck: false,
  exposeStreamingForTesting: true,
  // Claude waits indefinitely for the first SSE byte (original 2-arg waitForContent).
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  hardTimeoutGraceMs: HARD_TIMEOUT_GRACE_MS,
  firstByteTimeoutMs: Number.POSITIVE_INFINITY,
});

export const tlsFetchClaude = (
  url: string,
  options: TlsFetchOptions = {}
): Promise<TlsFetchResult> => tlsClientModule.tlsFetch(url, options);
export const tlsFetchStreaming = tlsClientModule.__tlsFetchStreamingForTesting;

export const __setTlsFetchOverrideForTesting = tlsClientModule.__setTlsFetchOverrideForTesting;

export { TlsClientHangError, TlsClientUnavailableError } from "./tlsClientBase.ts";
export type { TlsFetchOptions, TlsFetchResult } from "./tlsClientBase.ts";
export { looksLikeSse } from "./tlsClientBase.ts";
