import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-auxiliary-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "exclusive-lease-auxiliary-test-secret";

let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  externalCalls += 1;
  throw new Error("unexpected external provider/model call");
};

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const translator = await import("../../src/app/api/translator/send/route.ts");
const translatorPreview = await import("../../src/app/api/translator/translate/route.ts");
const modelTests = await import("../../src/lib/api/modelTestRunner.ts");
const vnc = await import("../../src/lib/vncSession/service.ts");

const OWNER = "vlo_UUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUUU";

async function seedConnection(name: string): Promise<{ id: string }> {
  return (await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus: "active",
    priority: 1,
    providerSpecificData: {},
  })) as { id: string };
}

async function markLeaseOnly(connectionId: string): Promise<void> {
  await apiKeys.createApiKey("managed auxiliary", "test", ["lease:exclusive"], {
    allowedConnections: [connectionId],
  });
}

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  externalCalls = 0;
}

test.beforeEach(resetStorage);
test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("translator send excludes a FREE lease-only connection before provider fetch", async () => {
  const connection = await seedConnection("translator-lease-only");
  await markLeaseOnly(connection.id);

  const response = await translator.POST(
    new Request("http://omniroute.local/api/translator/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        body: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "test" }] },
      }),
    })
  );

  assert.equal(response.status, 400);
  assert.equal(externalCalls, 0);
});

test("translator send excludes an ACTIVE leased connection before provider fetch", async () => {
  const connection = await seedConnection("translator-active-lease");
  const acquired = leases.acquireExclusiveConnectionLease({
    leaseOwnerId: OWNER,
    apiKeyId: "managed-key",
    provider: "openai",
    connectionId: connection.id,
  });
  assert.equal(acquired.kind, "ACQUIRED");

  const response = await translator.POST(
    new Request("http://omniroute.local/api/translator/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        body: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "test" }] },
      }),
    })
  );

  assert.equal(response.status, 400);
  assert.equal(externalCalls, 0);
});

test("translator request preview never materializes a lease-only credential", async () => {
  const connection = await seedConnection("translator-preview-lease-only");
  await markLeaseOnly(connection.id);

  const response = await translatorPreview.POST(
    new Request("http://omniroute.local/api/translator/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        step: 4,
        provider: "openai",
        body: { model: "gpt-4.1-mini", messages: [{ role: "user", content: "test" }] },
      }),
    })
  );
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.equal(body.includes("sk-translator-preview-lease-only"), false);
  assert.equal(externalCalls, 0);
});

test("browser-login start rejects lease-only connections before Docker or provider access", async () => {
  const connection = await seedConnection("vnc-lease-only");
  await markLeaseOnly(connection.id);

  await assert.rejects(
    vnc.startSession(connection.id),
    /unavailable for managed lease connections/
  );
  assert.equal(externalCalls, 0);
});

test("forced model tests reject lease-only connections before any model dispatch", async () => {
  const connection = await seedConnection("model-test-lease-only");
  await markLeaseOnly(connection.id);

  const result = await modelTests.runSingleModelTest({
    providerId: "openai",
    modelId: "gpt-4.1-mini",
    connectionId: connection.id,
  });

  assert.equal(result.httpStatus, 409);
  assert.match(result.error || "", /unavailable for managed lease connections/);
  assert.equal(externalCalls, 0);
});

test("forced model tests reject ACTIVE leased connections before any model dispatch", async () => {
  const connection = await seedConnection("model-test-active-lease");
  const acquired = leases.acquireExclusiveConnectionLease({
    leaseOwnerId: OWNER,
    apiKeyId: "managed-key",
    provider: "openai",
    connectionId: connection.id,
  });
  assert.equal(acquired.kind, "ACQUIRED");

  const result = await modelTests.runSingleModelTest({
    providerId: "openai",
    modelId: "gpt-4.1-mini",
    connectionId: connection.id,
  });

  assert.equal(result.httpStatus, 409);
  assert.equal(externalCalls, 0);
});

test("browser-login harvest rejects ACTIVE leased connections before credential mutation", async () => {
  const connection = await seedConnection("vnc-active-lease");
  const acquired = leases.acquireExclusiveConnectionLease({
    leaseOwnerId: OWNER,
    apiKeyId: "managed-key",
    provider: "openai",
    connectionId: connection.id,
  });
  assert.equal(acquired.kind, "ACQUIRED");

  await assert.rejects(
    vnc.harvestSession(connection.id, "missing-session"),
    /unavailable for managed lease connections/
  );
  assert.equal(externalCalls, 0);
});
