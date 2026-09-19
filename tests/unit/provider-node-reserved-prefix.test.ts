// Reserved provider prefixes — compatible-node prefix guard (TDD, tokenrouter bug).
//
// Bug: an operator-created openai-compatible node with prefix "tokenrouter" was
// accepted at creation time, but the runtime model resolver
// (src/sse/services/model.ts) treats built-in registry ids/aliases as reserved
// and skips the node lookup — so `tokenrouter/qwen/...` routed to the BUILT-IN
// tokenrouter provider ("No active credentials for provider: tokenrouter")
// instead of the operator's node. The same node addressed by its internal id
// worked fine. Fix: reject reserved prefixes at the write path (node
// create/update schemas) so the misconfiguration can no longer be created.
//
// The reserved set is shared between the runtime guard and the validation
// schemas via src/shared/constants/reservedProviderPrefixes.ts (single source of
// truth). Set semantics mirror the old inline guard exactly:
//   - REGISTRY entry ids + aliases only;
//   - case-sensitive (mixed-case "TokenRouter" does NOT collide at runtime);
//   - manual alias ids that live outside REGISTRY (xiaomi/llamacpp/aq) are NOT
//     included — verified they do not intercept nodes at runtime.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reserved-prefix-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providerNodesRoute = await import("../../src/app/api/provider-nodes/route.ts");
const providerNodesIdRoute = await import("../../src/app/api/provider-nodes/[id]/route.ts");
const { createProviderNodeSchema, updateProviderNodeSchema } =
  await import("../../src/shared/validation/schemas.ts");
const { RESERVED_PROVIDER_PREFIXES, isReservedProviderPrefix, RESERVED_PREFIX_COUNT } =
  await import("../../src/shared/constants/reservedProviderPrefixes.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

// Minimal response-body shapes (no `any` — new eslint violations must be fixed,
// not suppressed). `unknown` fields are narrowed through helpers before use.
type ValidationDetail = { field: string; message: string };
type ValidationBody = { error?: { details?: ValidationDetail[] } };
type NodeBody = { node?: { id?: string; prefix?: string } };

function asValidationBody(value: unknown): ValidationBody {
  return value && typeof value === "object" ? (value as ValidationBody) : {};
}

function asNodeBody(value: unknown): NodeBody {
  return value && typeof value === "object" ? (value as NodeBody) : {};
}

function findPrefixDetail(body: unknown): ValidationDetail | undefined {
  const details = asValidationBody(body).error?.details ?? [];
  return details.find((d) => d.field === "prefix");
}

function makeCreateRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/provider-nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeUpdateRequest(id: string, body: Record<string, unknown>) {
  return new Request(`http://localhost/api/provider-nodes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ──── Shared module ────

test("shared set contains REGISTRY ids and aliases (tokenrouter + trk)", () => {
  assert.equal(RESERVED_PROVIDER_PREFIXES.has("tokenrouter"), true);
  assert.equal(RESERVED_PROVIDER_PREFIXES.has("trk"), true);
});

test("shared set is case-sensitive like the runtime guard", () => {
  assert.equal(isReservedProviderPrefix("TokenRouter"), false);
  assert.equal(isReservedProviderPrefix("TOKENROUTER"), false);
  assert.equal(isReservedProviderPrefix("tokenrouter"), true);
});

test("shared set excludes manual aliases that never intercept nodes at runtime", () => {
  // Verified against src/sse/services/model.ts behavior: xiaomi/llamacpp/aq are
  // not REGISTRY members and do NOT shadow compatible nodes, so rejecting them
  // would be a false positive.
  assert.equal(RESERVED_PROVIDER_PREFIXES.has("qwen"), false);
  assert.equal(RESERVED_PROVIDER_PREFIXES.has("xiaomi"), false);
  assert.equal(RESERVED_PROVIDER_PREFIXES.has("llamacpp"), false);
  assert.equal(RESERVED_PROVIDER_PREFIXES.has("aq"), false);
});

test("shared set size matches full REGISTRY scan (395 unique prefixes)", () => {
  // Count measured against release/v3.8.50 tip after this merge-batch boarded
  // #11333 (volcengine-coding-plan + volcengine-agent-plan, +4 ids/aliases) on
  // top of the 391 pinned post-upstream-65e81158a (was 329 at c68cda7df) —
  // the assertion pins that the set is a full REGISTRY walk, not a
  // hand-maintained list.
  assert.equal(RESERVED_PREFIX_COUNT, 395);
});

test("isReservedProviderPrefix rejects non-string input", () => {
  assert.equal(isReservedProviderPrefix(undefined), false);
  assert.equal(isReservedProviderPrefix(null), false);
  assert.equal(isReservedProviderPrefix(42), false);
});

// ──── Schema-level guard ────

test("createProviderNodeSchema rejects reserved prefix 'tokenrouter'", () => {
  const result = createProviderNodeSchema.safeParse({
    name: "TokenRouter Node",
    prefix: "tokenrouter",
    apiType: "chat",
    baseUrl: "https://api.tokenrouter.com/v1",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    const prefixIssue = result.error.issues.find((i) => i.path[0] === "prefix");
    assert.ok(prefixIssue, "expected a 'prefix' issue");
    assert.match(prefixIssue.message, /reserved/i);
    assert.match(prefixIssue.message, /tokenrouter/);
  }
});

test("createProviderNodeSchema rejects reserved alias 'trk'", () => {
  const result = createProviderNodeSchema.safeParse({
    name: "TRK Node",
    prefix: "trk",
    apiType: "chat",
  });
  assert.equal(result.success, false);
});

test("createProviderNodeSchema accepts mixed-case 'TokenRouter' (no runtime collision)", () => {
  const result = createProviderNodeSchema.safeParse({
    name: "Case Test",
    prefix: "TokenRouter",
    apiType: "chat",
  });
  assert.equal(result.success, true);
});

test("createProviderNodeSchema accepts non-reserved prefixes", () => {
  for (const prefix of ["my-gateway", "llamacpp", "aq", "xiaomi"]) {
    const result = createProviderNodeSchema.safeParse({
      name: "Free Prefix",
      prefix,
      apiType: "chat",
    });
    assert.equal(result.success, true, `prefix "${prefix}" should be accepted`);
  }
});

test("updateProviderNodeSchema rejects reserved prefix", () => {
  const result = updateProviderNodeSchema.safeParse({
    name: "Renamed",
    prefix: "openai",
  });
  assert.equal(result.success, false);
});

test("updateProviderNodeSchema accepts non-reserved prefix", () => {
  const result = updateProviderNodeSchema.safeParse({
    name: "Renamed",
    prefix: "still-fine",
    baseUrl: "https://renamed.example.com/v1",
  });
  assert.equal(result.success, true);
});

// ──── Route-level guard (POST /api/provider-nodes) ────

test("provider nodes route returns 400 with prefix issue for reserved prefix", async () => {
  const response = await providerNodesRoute.POST(
    makeCreateRequest({
      name: "TokenRouter Node",
      prefix: "tokenrouter",
      apiType: "chat",
      baseUrl: "https://api.tokenrouter.com/v1",
    })
  );
  assert.equal(response.status, 400);
  const detail = findPrefixDetail(await response.json());
  assert.ok(detail, "expected a prefix validation detail");
  assert.match(detail.message, /reserved/i);
});

test("provider nodes route still creates non-reserved nodes", async () => {
  const response = await providerNodesRoute.POST(
    makeCreateRequest({
      name: "Good Node",
      prefix: "good-node",
      apiType: "chat",
      baseUrl: "https://good.example.com/v1",
    })
  );
  assert.equal(response.status, 201);
  const body = asNodeBody(await response.json());
  assert.equal(body.node?.prefix, "good-node");
});

// ──── Route-level guard (PUT /api/provider-nodes/[id]) ────

test("provider nodes update route rejects renaming prefix to a reserved one", async () => {
  const createResponse = await providerNodesRoute.POST(
    makeCreateRequest({
      name: "Original Node",
      prefix: "original-prefix",
      apiType: "chat",
      baseUrl: "https://original.example.com/v1",
    })
  );
  const created = asNodeBody(await createResponse.json());
  const nodeId = created.node?.id ?? "";

  const updateResponse = await providerNodesIdRoute.PUT(
    makeUpdateRequest(nodeId, {
      name: "Hijacked",
      prefix: "anthropic",
      baseUrl: "https://hijack.example.com/v1",
    }),
    { params: Promise.resolve({ id: nodeId }) }
  );
  assert.equal(updateResponse.status, 400);
  const detail = findPrefixDetail(await updateResponse.json());
  assert.ok(detail, "expected a prefix validation detail");
  assert.match(detail.message, /reserved/i);

  // The node keeps its original prefix.
  const after = await providerNodesIdRoute.PUT(
    makeUpdateRequest(nodeId, {
      name: "Still Original",
      prefix: "original-prefix",
      apiType: "chat",
      baseUrl: "https://original.example.com/v1",
    }),
    { params: Promise.resolve({ id: nodeId }) }
  );
  assert.equal(after.status, 200);
  const afterBody = asNodeBody(await after.json());
  assert.equal(afterBody.node?.prefix, "original-prefix");
});
