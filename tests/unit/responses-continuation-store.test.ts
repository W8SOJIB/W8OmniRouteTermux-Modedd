import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// OmniRoute-native `previous_response_id` virtualization: resolvePreviousResponseState
// resolves a response id back to the full input/output a prior call produced by
// reading the already-persisted call-log artifact, so a later request can be
// reconstructed to full history server-side without duplicating conversation
// content into a second store.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-responses-continuation-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const store = await import("../../src/lib/db/responsesContinuationStore.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function insertCallLog(row: {
  id: string;
  responseId: string | null;
  apiKeyId: string | null;
  detailState: string;
  artifactRelPath: string | null;
}) {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO call_logs
      (id, timestamp, method, path, status, model, provider, account, duration,
       tokens_in, tokens_out, api_key_id, detail_state, artifact_relpath, response_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    new Date().toISOString(),
    "POST",
    "/v1/responses",
    200,
    "gpt-5.4-pro",
    "openai",
    "acc1",
    100,
    10,
    20,
    row.apiKeyId,
    row.detailState,
    row.artifactRelPath,
    row.responseId
  );
}

function writeArtifact(relPath: string, pipeline: Record<string, unknown>) {
  const absPath = path.join(TEST_DATA_DIR, "call_logs", relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(
    absPath,
    JSON.stringify({
      schemaVersion: 5,
      summary: {},
      requestBody: null,
      responseBody: null,
      error: null,
      pipeline,
    })
  );
}

test("resolvePreviousResponseState reconstructs input/output from the call-log artifact", () => {
  insertCallLog({
    id: "log-1",
    responseId: "resp_abc",
    apiKeyId: "key-1",
    detailState: "ready",
    artifactRelPath: "2026-01-01/log-1.json",
  });
  writeArtifact("2026-01-01/log-1.json", {
    providerRequest: { body: { input: [{ type: "message", role: "user", content: "hi" }] } },
    clientResponse: {
      id: "resp_abc",
      output: [{ type: "message", role: "assistant", content: "hello" }],
    },
  });

  const result = store.resolvePreviousResponseState("resp_abc", "key-1");
  assert.deepEqual(result, {
    input: [{ type: "message", role: "user", content: "hi" }],
    output: [{ type: "message", role: "assistant", content: "hello" }],
  });
});

test("resolvePreviousResponseState returns null for an unknown response id", () => {
  const result = store.resolvePreviousResponseState("resp_does_not_exist", "key-1");
  assert.equal(result, null);
});

test("resolvePreviousResponseState never crosses tenants (scoped by api_key_id)", () => {
  insertCallLog({
    id: "log-2",
    responseId: "resp_tenant_a",
    apiKeyId: "key-a",
    detailState: "ready",
    artifactRelPath: "2026-01-01/log-2.json",
  });
  writeArtifact("2026-01-01/log-2.json", {
    providerRequest: { body: { input: [{ role: "user", content: "secret" }] } },
    clientResponse: { id: "resp_tenant_a", output: [{ role: "assistant", content: "reply" }] },
  });

  assert.equal(store.resolvePreviousResponseState("resp_tenant_a", "key-b"), null);
  assert.equal(store.resolvePreviousResponseState("resp_tenant_a", null), null);
  assert.notEqual(store.resolvePreviousResponseState("resp_tenant_a", "key-a"), null);
});

test("resolvePreviousResponseState returns null when the artifact is missing on disk", () => {
  insertCallLog({
    id: "log-3",
    responseId: "resp_missing_file",
    apiKeyId: "key-1",
    detailState: "ready",
    artifactRelPath: "2026-01-01/does-not-exist.json",
  });

  assert.equal(store.resolvePreviousResponseState("resp_missing_file", "key-1"), null);
});

test("resolvePreviousResponseState fails closed when the pipeline payload was size-limit-omitted", () => {
  insertCallLog({
    id: "log-4",
    responseId: "resp_omitted",
    apiKeyId: "key-1",
    detailState: "ready",
    artifactRelPath: "2026-01-01/log-4.json",
  });
  // A size-limit-omitted payload is replaced with a placeholder string, not
  // an object -- resolvePreviousResponseState must never try to reconstruct
  // from it and silently drop history.
  writeArtifact("2026-01-01/log-4.json", {
    providerRequest: { body: "[omitted: call log artifact size limit exceeded]" },
    clientResponse: { id: "resp_omitted", output: [] },
  });

  assert.equal(store.resolvePreviousResponseState("resp_omitted", "key-1"), null);
});

test("resolvePreviousResponseState returns null when detail logging was never captured for this row", () => {
  insertCallLog({
    id: "log-5",
    responseId: "resp_no_detail",
    apiKeyId: "key-1",
    detailState: "none",
    artifactRelPath: null,
  });

  assert.equal(store.resolvePreviousResponseState("resp_no_detail", "key-1"), null);
});
