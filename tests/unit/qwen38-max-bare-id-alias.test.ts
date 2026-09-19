import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";
import { resolveModelAlias } from "../../open-sse/services/modelDeprecation.ts";
import { resolveLifecycle } from "../../open-sse/handlers/chatCore/modelLifecyclePolicy.ts";

/**
 * Bare `qwen3.8-max` was an unroutable id: the model ships everywhere as
 * `qwen3.8-max-preview` (bailian-coding-plan, qoder, qwen-cloud-token-plan, qwen-web),
 * and nothing in the repo declared the short form. A client sending it therefore
 *
 *   1. missed MODEL_SPECS, so `getModelContextLimit()` fell through to the
 *      `default: 128000` in open-sse/services/contextManager.ts, and the chatCore
 *      preflight rejected any prompt above 128k with `context_length_exceeded`
 *      ("Input exceeds context window ... limit 128000") even though the real
 *      window is 1M; and
 *   2. would have been dispatched verbatim to the upstream, which only knows the
 *      `-preview` id.
 *
 * Both symptoms have one cause — the missing id — so the fix belongs in the
 * deprecation/rename alias map (`BUILT_IN_ALIASES`), which `resolveLifecycle()`
 * applies at open-sse/handlers/chatCore.ts:755, well before both the context
 * preflight and the upstream dispatch. A MODEL_SPECS `aliases` entry would have
 * fixed only (1): spec aliases resolve capabilities, never the dispatched id.
 */

const BARE = "qwen3.8-max";
const CANONICAL = "qwen3.8-max-preview";

test("bare qwen3.8-max resolves to the canonical -preview id", () => {
  assert.equal(resolveModelAlias(BARE), CANONICAL);
});

test("the canonical id is a no-op through the alias map (no double rewrite)", () => {
  assert.equal(resolveModelAlias(CANONICAL), CANONICAL);
});

test("the alias target carries the real 1M window, not the 128k fallback", () => {
  const spec = MODEL_SPECS[CANONICAL];
  assert.ok(spec, `MODEL_SPECS is missing ${CANONICAL}`);
  assert.equal(spec.contextWindow, 1_000_000);
  // The bare id must NOT gain its own spec entry — a second source of truth for the
  // same model is what lets the two ids drift apart again.
  assert.equal(MODEL_SPECS[BARE], undefined);
});

test("chatCore lifecycle resolution rewrites the model before dispatch", () => {
  for (const provider of ["qwen-cloud-token-plan", "qoder", "bailian-coding-plan", "qwen-web"]) {
    const [resolvedModel, effectiveModel, lifecycleError] = resolveLifecycle(provider, BARE);
    assert.equal(resolvedModel, CANONICAL, `resolvedModel for ${provider}`);
    assert.equal(effectiveModel, CANONICAL, `effectiveModel for ${provider}`);
    assert.equal(lifecycleError, null, `unexpected lifecycle rejection for ${provider}`);
  }
});
