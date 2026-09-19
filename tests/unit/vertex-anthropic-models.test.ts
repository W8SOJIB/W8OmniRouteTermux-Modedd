/**
 * Vertex AI Anthropic partner-model discovery (#11279).
 *
 * Covers the two pure units the PR adds (the discovery route itself is a
 * best-effort network path exercised manually per the PR's test plan):
 *   - parseVertexAnthropicModels: Model Garden publisher response → discovery
 *     models, handling global AND project-scoped resource names;
 *   - getModelTargetFormat: a claude-* id on vertex/vertex-partner resolves to
 *     the "claude" translator even when the model is NOT in the static
 *     registry (the future-model heuristic).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseVertexAnthropicModels } from "../../src/lib/providerModels/vertexAnthropicModelsParser.ts";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.ts";

test("parseVertexAnthropicModels: global publisher resource names", () => {
  const out = parseVertexAnthropicModels({
    models: [
      {
        name: "publishers/anthropic/models/claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        description: "Latest Sonnet",
      },
      { name: "publishers/anthropic/models/claude-opus-4-6", displayName: "Claude Opus 4.6" },
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    supportedEndpoints: ["chat"],
    targetFormat: "claude",
    description: "Latest Sonnet",
    owned_by: "anthropic",
  });
  // displayName fallback: missing → id; description omitted when absent
  assert.equal(out[1].name, "Claude Opus 4.6");
  assert.equal("description" in out[1], false);
});

test("parseVertexAnthropicModels: project-scoped resource names strip the prefix", () => {
  const out = parseVertexAnthropicModels({
    models: [
      {
        name: "projects/my-gcp-project/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5",
      },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "claude-haiku-4-5");
  assert.equal(out[0].name, "claude-haiku-4-5");
});

test("parseVertexAnthropicModels: malformed input yields an empty list", () => {
  assert.deepEqual(parseVertexAnthropicModels(null), []);
  assert.deepEqual(parseVertexAnthropicModels({}), []);
  assert.deepEqual(parseVertexAnthropicModels({ models: "not-an-array" }), []);
  assert.deepEqual(parseVertexAnthropicModels({ models: [{ name: "" }, {}] }), []);
});

test("getModelTargetFormat: claude-* on vertex resolves to the claude translator (heuristic)", () => {
  // A future Claude model with no static registry entry must still route
  // through the Anthropic Messages translator on both vertex ids.
  assert.equal(getModelTargetFormat("vertex", "claude-future-9-9"), "claude");
  assert.equal(getModelTargetFormat("vertex-partner", "claude-future-9-9"), "claude");
  // Non-Claude ids are untouched by the heuristic.
  assert.notEqual(getModelTargetFormat("vertex", "gemini-3.1-pro"), "claude");
});
