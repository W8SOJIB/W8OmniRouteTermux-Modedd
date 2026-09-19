import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-session-leases-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "session-leases-route-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const route = await import("../../src/app/api/v1/session-leases/route.ts");

const OWNER_A = "vlo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER_B = "vlo_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
let attemptedExternalCalls = 0;
const originalFetch = globalThis.fetch;

function request(key: string, body: unknown, owner?: string, generation?: number): Request {
  const headers = new Headers({
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  });
  if (owner) headers.set("X-OmniRoute-Lease-Owner", owner);
  if (generation !== undefined) {
    headers.set("X-OmniRoute-Lease-Generation", String(generation));
  }
  return new Request("http://omniroute.local/api/v1/session-leases", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function seedConnection(priority: number): Promise<{ id: string }> {
  return (await providersDb.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    name: `lease-route-${priority}`,
    apiKey: `sk-route-${priority}`,
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData: {},
  })) as { id: string };
}

async function seedKey(
  connectionIds: string[],
  scopes: string[] = ["lease:exclusive"]
): Promise<{ id: string; key: string }> {
  return apiKeysDb.createApiKey("lease-route-key", "test", scopes, {
    allowedConnections: connectionIds,
  });
}

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  attemptedExternalCalls = 0;
}

test.before(() => {
  globalThis.fetch = async () => {
    attemptedExternalCalls += 1;
    throw new Error("unexpected external provider/model/quota dispatch");
  };
});
test.beforeEach(resetStorage);
test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("requires authentication, managed scope, and canonical explicit owner", async () => {
  const unauthenticated = await route.POST(
    new Request("http://omniroute.local/api/v1/session-leases", {
      method: "POST",
      body: JSON.stringify({ action: "acquire", model: "glm/glm-4.6" }),
    })
  );
  assert.equal(unauthenticated.status, 401);

  const connection = await seedConnection(1);
  const unmanaged = await seedKey([connection.id], []);
  const noScope = await route.POST(
    request(unmanaged.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)
  );
  assert.equal(noScope.status, 403);

  const managed = await seedKey([connection.id]);
  const missing = await route.POST(
    request(managed.key, { action: "acquire", model: "glm/glm-4.6" })
  );
  assert.equal(missing.status, 400);
  assert.equal(((await json(missing)).error as { code: string }).code, "LEASE_CONTEXT_REQUIRED");

  const malformed = await route.POST(
    request(managed.key, { action: "acquire", model: "glm/glm-4.6" }, "vlo_short")
  );
  assert.equal(malformed.status, 400);
  assert.equal(((await json(malformed)).error as { code: string }).code, "LEASE_CONTEXT_INVALID");
  assert.equal(attemptedExternalCalls, 0);
});

test("requires JSON mutation input after authenticating and exposes generic CORS headers", async () => {
  const connection = await seedConnection(1);
  const managed = await seedKey([connection.id]);
  const unsupported = await route.POST(
    new Request("http://omniroute.local/api/v1/session-leases", {
      method: "POST",
      headers: { Authorization: `Bearer ${managed.key}` },
      body: JSON.stringify({ action: "acquire", model: "glm/glm-4.6" }),
    })
  );
  assert.equal(unsupported.status, 415);
  assert.equal(
    ((await json(unsupported)).error as { code: string }).code,
    "LEASE_CONTENT_TYPE_REQUIRED"
  );

  const preflight = await route.OPTIONS();
  assert.equal(preflight.status, 204);
  const allowedHeaders = preflight.headers.get("Access-Control-Allow-Headers") ?? "";
  assert.match(allowedHeaders, /X-OmniRoute-Lease-Owner/i);
  assert.match(allowedHeaders, /X-OmniRoute-Lease-Generation/i);
  assert.equal(attemptedExternalCalls, 0);
});

test("acquires, reuses, renews, releases, and fences a stale lifecycle", async () => {
  const connection = await seedConnection(1);
  const managed = await seedKey([connection.id]);

  const acquired = await route.POST(
    request(managed.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)
  );
  assert.equal(acquired.status, 200);
  const acquiredBody = await json(acquired);
  assert.equal(acquiredBody.state, "ACTIVE");
  assert.equal(acquiredBody.generation, 1);
  assert.equal("connectionId" in acquiredBody, false);
  assert.equal("credentials" in acquiredBody, false);
  assert.equal(JSON.stringify(acquiredBody).includes(OWNER_A), false);

  const reused = await route.POST(
    request(managed.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)
  );
  assert.equal(reused.status, 200);
  assert.equal((await json(reused)).generation, 1);

  const renewed = await route.POST(
    request(managed.key, { action: "renew", generation: 1 }, OWNER_A)
  );
  assert.equal(renewed.status, 200);

  const staleRenew = await route.POST(
    request(managed.key, { action: "renew", generation: 2 }, OWNER_A)
  );
  assert.equal(staleRenew.status, 409);
  assert.equal(((await json(staleRenew)).error as { code: string }).code, "LEASE_FENCE_STALE");

  const released = await route.POST(
    request(managed.key, { action: "release", generation: 1, reason: "CLIENT_CANCELLED" }, OWNER_A)
  );
  assert.equal(released.status, 200);
  assert.equal((await json(released)).state, "RELEASED");

  const idempotent = await route.POST(
    request(managed.key, { action: "release", generation: 1 }, OWNER_A)
  );
  assert.equal(idempotent.status, 200);
  assert.equal((await json(idempotent)).state, "RELEASED");
  assert.equal(attemptedExternalCalls, 0);
});

test("renew and release require the API key that owns the active authorization", async () => {
  const connection = await seedConnection(1);
  const ownerKey = await seedKey([connection.id]);
  const foreignKey = await seedKey([connection.id]);
  const acquired = await route.POST(
    request(ownerKey.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)
  );
  assert.equal(acquired.status, 200);

  const foreignRenew = await route.POST(
    request(foreignKey.key, { action: "renew", generation: 1 }, OWNER_A)
  );
  assert.equal(foreignRenew.status, 409);
  assert.equal(((await json(foreignRenew)).error as { code: string }).code, "LEASE_FENCE_STALE");

  const foreignRelease = await route.POST(
    request(foreignKey.key, { action: "release", generation: 1 }, OWNER_A)
  );
  assert.equal(foreignRelease.status, 409);
  assert.equal(((await json(foreignRelease)).error as { code: string }).code, "LEASE_FENCE_STALE");

  const ownerRenew = await route.POST(
    request(ownerKey.key, { action: "renew", generation: 1 }, OWNER_A)
  );
  assert.equal(ownerRenew.status, 200);
  assert.equal(attemptedExternalCalls, 0);
});

test("same-owner acquire through a second managed key is rejected without rebinding", async () => {
  const first = await seedConnection(1);
  const second = await seedConnection(2);
  const firstKey = await seedKey([first.id]);
  const secondKey = await seedKey([second.id]);
  const acquired = await route.POST(
    request(firstKey.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)
  );
  assert.equal(acquired.status, 200);
  assert.equal((await json(acquired)).generation, 1);

  const transitioned = await route.POST(
    request(secondKey.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)
  );
  assert.equal(transitioned.status, 409);

  const active = (
    await import("../../src/lib/db/exclusiveConnectionLeases.ts")
  ).getActiveExclusiveConnectionLease(OWNER_A);
  assert.equal(active?.connectionId, first.id);
  assert.equal(active?.apiKeyId, firstKey.id);
  assert.equal(attemptedExternalCalls, 0);
});

test("returns bounded WAITING_FOR_CAPACITY without credential or owner disclosure", async () => {
  const connection = await seedConnection(1);
  const managed = await seedKey([connection.id]);
  assert.equal(
    (await route.POST(request(managed.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_A)))
      .status,
    200
  );

  const waiting = await route.POST(
    request(managed.key, { action: "acquire", model: "glm/glm-4.6" }, OWNER_B)
  );
  assert.equal(waiting.status, 429);
  const retryAfterHeader = Number(waiting.headers.get("Retry-After"));
  assert.equal(Number.isInteger(retryAfterHeader), true);
  assert.equal(retryAfterHeader >= 1 && retryAfterHeader <= 120, true);
  const body = await json(waiting);
  assert.equal(body.state, "WAITING_FOR_CAPACITY");
  assert.equal(body.reason, "NO_FREE_ELIGIBLE_CONNECTION");
  assert.equal(body.freeCount, 0);
  assert.equal(typeof body.retryAfter, "number");
  assert.equal(body.retryAfter, retryAfterHeader);
  assert.equal((body.error as { code: string }).code, "LEASE_CAPACITY_UNAVAILABLE");
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(OWNER_A), false);
  assert.equal(serialized.includes(OWNER_B), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("at /"), false);
  assert.equal(attemptedExternalCalls, 0);
});
