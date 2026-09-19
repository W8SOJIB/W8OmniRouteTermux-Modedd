import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #11234 — opencode-go quota preflight ignored the dashboard quota snapshots.
 *
 * Root cause (two gaps):
 *
 *  A) `fetchOpencodeQuota` (open-sse/services/opencodeQuotaFetcher.ts) only
 *     consulted the live upstream endpoint, which has no public quota API
 *     (404 — see module JSDoc). It never read the quota snapshots the
 *     dashboard scrape (`getOpenCodeGoUsage`, keyed session/weekly/mcp_monthly)
 *     persists through `src/domain/quotaCache.ts`. Every preflight therefore
 *     evaluated `null` and proceeded (fail-open), even with a sister
 *     connection sitting at 0% weekly remaining in plain sight on the
 *     dashboard.
 *
 *  B) The sibling-selection latency gate in
 *     `src/sse/services/auth.ts::getProviderCredentialsWithQuotaPreflight`
 *     never consulted `resilience.quotaPreflight.enabled`
 *     (QUOTA_PREFLIGHT_CUTOFF_ENABLED). That flag only armed the auto-strategy
 *     candidate builder and the per-target cutoff for pinned connections, so
 *     a priority combo over sibling opencode-go connections (connectionId
 *     null at combo level) skipped preflight entirely.
 *
 * Fix:
 *  A) The fetcher now synthesizes its triple-window quota from the cached
 *     dashboard snapshots (read-only, accessors only, no re-scrape on the hot
 *     path) when the live endpoint yields nothing — mapping
 *     session→window_5h, weekly→window_weekly, mcp_monthly→window_monthly and
 *     mirroring `getQuotaWindowStatus` semantics (expired resetAt = window has
 *     rolled over = must not count as exhausted).
 *  B) `resilience.quotaPreflight.enabled === true` now arms the
 *     sibling-selection latency gate as well.
 *
 * These tests are the regression guards: fetcher-level for (A), selector-level
 * for (B).
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-11234-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Part (B): the operator flag must be ON before the resilience settings module
// is first imported (its defaults are computed at module load).
process.env.QUOTA_PREFLIGHT_CUTOFF_ENABLED = "true";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "quota-11234-secret";

const originalFetch = globalThis.fetch;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { fetchOpencodeQuota, invalidateOpencodeQuotaCache } = await import(
  "../../open-sse/services/opencodeQuotaFetcher.ts"
);
const { evaluateQuotaCutoff, registerQuotaFetcher } = await import(
  "../../open-sse/services/quotaPreflight.ts"
);
const { buildAutoQuotaThresholds } = await import(
  "../../open-sse/services/combo/quotaExhaustionCutoff.ts"
);
const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");

const PROVIDER = "opencode-go";
// Dashboard scrape window keys (opencodeOllamaUsage.ts::OPENCODE_GO_QUOTA_ORDER)
const DASH_SESSION = "session";
const DASH_WEEKLY = "weekly";
// Fetcher/preflight window keys (opencodeQuotaFetcher.ts registry)
const WINDOW_5H = "window_5h";
const WINDOW_WEEKLY = "window_weekly";

function seedSnapshot(
  connectionId: string,
  windowKey: string,
  remainingPercentage: number,
  nextResetAt: string | null
) {
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: PROVIDER,
    connection_id: connectionId,
    window_key: windowKey,
    remaining_percentage: remainingPercentage,
    is_exhausted: remainingPercentage <= 0 ? 1 : 0,
    next_reset_at: nextResetAt,
    window_duration_ms: null,
    raw_data: null,
  });
}

function dashboardConfiguredConnection(apiKey: string): Record<string, unknown> {
  // Mirrors the operator-configured dashboard scrape
  // (opencodeOllamaUsage.ts::resolveOpenCodeGoDashboardConfig).
  return {
    apiKey,
    providerSpecificData: {
      openCodeGoWorkspaceId: "ws-11234",
      openCodeGoAuthCookie: "auth-cookie-11234",
    },
  };
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

test.after(() => {
  globalThis.fetch = originalFetch;
  coreDb.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  quotaCache.__clearForTests();
});

// ─── (A) fetcher bridge: dashboard snapshots → QuotaInfo ────────────────────

test("#11234 dashboard snapshots feed the quota cutoff when the live endpoint has no quota API", async () => {
  const connectionId = `oc-11234-block-${Date.now()}`;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 404 });
  };

  // Dashboard shows: weekly fully drained (0% remaining, reset in 3 days),
  // session healthy (80% remaining).
  seedSnapshot(connectionId, DASH_WEEKLY, 0, hoursFromNow(72));
  seedSnapshot(connectionId, DASH_SESSION, 80, hoursFromNow(2));

  const quota = await fetchOpencodeQuota(connectionId, dashboardConfiguredConnection("sk-test"));

  assert.ok(quota, "fetcher must synthesize quota from dashboard snapshots when the live endpoint 404s");
  assert.equal(fetchCalls, 1, "snapshot bridge must be read-only — no re-scrape on the hot path");

  // Key mapping: weekly → window_weekly (0% remaining = 100% used),
  // session → window_5h (80% remaining = 20% used).
  assert.equal(quota.windows?.[WINDOW_WEEKLY]?.percentUsed, 1);
  assert.ok(
    Math.abs((quota.windows?.[WINDOW_5H]?.percentUsed ?? 0) - 0.2) < 1e-9,
    `window_5h percentUsed should be ~0.2, got ${quota.windows?.[WINDOW_5H]?.percentUsed}`
  );

  const decision = evaluateQuotaCutoff(
    quota,
    buildAutoQuotaThresholds(PROVIDER, undefined, null)
  );
  assert.equal(decision.proceed, false, "weekly at 0% remaining must block the connection");
  assert.equal(decision.reason, "quota_exhausted");

  invalidateOpencodeQuotaCache(connectionId);
});

test("#11234 a snapshot whose reset already passed must not count as exhausted", async () => {
  const connectionId = `oc-11234-expired-${Date.now()}`;
  globalThis.fetch = async () => new Response(null, { status: 404 });

  // Weekly hit 0% but its reset is 1h in the PAST — the window rolled into a
  // fresh period, so the stale 0% must not block (mirrors
  // getQuotaWindowStatus: expired resetAt → reachedThreshold = false).
  seedSnapshot(connectionId, DASH_WEEKLY, 0, hoursFromNow(-1));
  seedSnapshot(connectionId, DASH_SESSION, 80, hoursFromNow(2));

  const quota = await fetchOpencodeQuota(connectionId, dashboardConfiguredConnection("sk-test"));

  assert.ok(quota, "the healthy session snapshot should still synthesize");
  assert.equal(
    quota.windows?.[WINDOW_WEEKLY],
    undefined,
    "an expired weekly window must be dropped from the synthesized quota"
  );

  const decision = evaluateQuotaCutoff(
    quota,
    buildAutoQuotaThresholds(PROVIDER, undefined, null)
  );
  assert.equal(decision.proceed, true, "an expired weekly window must not block the connection");

  invalidateOpencodeQuotaCache(connectionId);
});

test("#11234 per-window threshold overrides apply to the mapped window_weekly key", async () => {
  const connectionId = `oc-11234-threshold-${Date.now()}`;
  globalThis.fetch = async () => new Response(null, { status: 404 });

  // Weekly at 40% remaining — above the factory 2% cutoff (would proceed),
  // but below an operator override of 50% min-remaining for window_weekly.
  seedSnapshot(connectionId, DASH_WEEKLY, 40, hoursFromNow(72));
  seedSnapshot(connectionId, DASH_SESSION, 90, hoursFromNow(2));

  const quota = await fetchOpencodeQuota(connectionId, dashboardConfiguredConnection("sk-test"));
  assert.ok(quota);

  const factoryDecision = evaluateQuotaCutoff(
    quota,
    buildAutoQuotaThresholds(PROVIDER, undefined, null)
  );
  assert.equal(
    factoryDecision.proceed,
    true,
    "factory 2% cutoff must not block a window at 40% remaining"
  );

  const settings = resolveResilienceSettings({
    resilienceSettings: {
      quotaPreflight: {
        enabled: true,
        providerWindowDefaults: { [PROVIDER]: { [WINDOW_WEEKLY]: 50 } },
      },
    },
  });
  const overrideDecision = evaluateQuotaCutoff(
    quota,
    buildAutoQuotaThresholds(PROVIDER, undefined, settings)
  );
  assert.equal(
    overrideDecision.proceed,
    false,
    "a 50% window_weekly override must block at 40% remaining — the override resolves against the mapped key"
  );

  invalidateOpencodeQuotaCache(connectionId);
});

test("#11234 fail-open preserved: configured dashboard with no snapshots still returns null", async () => {
  const connectionId = `oc-11234-failopen-${Date.now()}`;
  globalThis.fetch = async () => new Response(null, { status: 404 });

  const quota = await fetchOpencodeQuota(connectionId, dashboardConfiguredConnection("sk-test"));
  assert.equal(quota, null, "no snapshots → fail-open (null), exactly as before");

  invalidateOpencodeQuotaCache(connectionId);
});

// ─── (B) flag scope: sibling-selection latency gate ─────────────────────────

test("#11234 quotaPreflight.enabled arms sibling selection: the exhausted sister is skipped for the healthy one", async () => {
  const tag = Date.now();

  const exhausted = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: `oc-11234-exhausted-${tag}`,
    apiKey: "sk-oc-11234-exhausted",
    priority: 1,
    isActive: true,
    testStatus: "active",
  });
  const healthy = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: `oc-11234-healthy-${tag}`,
    apiKey: "sk-oc-11234-healthy",
    priority: 2,
    isActive: true,
    testStatus: "active",
  });

  // Stub the upstream quota signal: the priority-1 sister is fully drained,
  // the priority-2 sister is healthy. No per-connection overrides, no
  // per-(provider, window) defaults, no legacy quotaPreflightEnabled flag,
  // factory 2% global threshold — so TODAY the latency gate skips preflight
  // entirely and the selector returns the exhausted sister. With
  // resilience.quotaPreflight.enabled arming the gate, preflight must run and
  // skip her.
  registerQuotaFetcher(PROVIDER, async (connectionId: string) => {
    if (connectionId === exhausted.id) {
      return {
        used: 100,
        total: 100,
        percentUsed: 1.0,
        resetAt: hoursFromNow(1),
      };
    }
    return { used: 0, total: 100, percentUsed: 0, resetAt: null };
  });

  try {
    const selection = await auth.getProviderCredentialsWithQuotaPreflight(
      PROVIDER,
      null,
      null,
      null
    );
    const result = selection as { connectionId?: string } | null;

    assert.equal(
      result?.connectionId,
      healthy.id,
      "with quotaPreflight.enabled the selector must skip the exhausted priority-1 sister and pick the healthy one"
    );
  } finally {
    await providersDb.deleteProviderConnection(exhausted.id);
    await providersDb.deleteProviderConnection(healthy.id);
  }
});
