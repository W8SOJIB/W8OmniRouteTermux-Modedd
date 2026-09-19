/**
 * DeepSeek V4 exposes a native `max` reasoning tier that the canonical vocabulary erases.
 *
 * Per https://api-docs.deepseek.com/api/create-chat-completion the accepted
 * `reasoning_effort` values are `low`, `high` and `max`, the default is `high`, and
 * **`medium` / `xhigh` are both mapped to `high`** upstream. (The live API's 400 on an
 * invalid value enumerates the full accepted set:
 * `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.)
 *
 * OmniRoute's canonical vocabulary is `none|low|medium|high|xhigh`, and `max` is an alias
 * that collapses onto `xhigh` (EFFORT_TIER_ALIASES). Since DeepSeek then maps `xhigh` back
 * down to `high`, a client sending `{"effort":"max"}` silently received **high** — the top
 * tier was unreachable through the canonical field.
 *
 * The fix mirrors the existing `extendCodexGpt56EffortValues` precedent: expose the
 * provider-native tier for these models only, without widening the global request
 * vocabulary for every other provider.
 *
 * Guards: A = `max` survives for native DeepSeek models; B = every other provider still
 * collapses `max`→`xhigh`; C = routed DeepSeek namespaces (openrouter/tllm) are NOT treated
 * as native; D = an explicit client `reasoning_effort` still wins; E = the catalog offers
 * `max` as an effort tier for native DeepSeek models.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeReasoningRequest,
  normalizeEffort,
  isDeepSeekNativeMaxModel,
  extendDeepSeekEffortValues,
  CANONICAL_EFFORT_VALUES,
} = await import("../../src/shared/reasoning/effortStandardization.ts");

test("A: canonical effort `max` survives for native DeepSeek V4 models", () => {
  for (const model of [
    "ds/deepseek-v4-pro",
    "ds/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
  ]) {
    const out = normalizeReasoningRequest({ model, effort: "max" }) as Record<string, unknown>;
    assert.equal(
      out.reasoning_effort,
      "max",
      `${model} must reach DeepSeek's native max tier, not the down-mapped xhigh`
    );
    assert.deepEqual((out.reasoning as Record<string, unknown>).effort, "max");
  }
});

test("A2: the provider can also be supplied explicitly (model id without prefix)", () => {
  const out = normalizeReasoningRequest(
    { model: "deepseek-v4-pro", effort: "max" },
    "deepseek"
  ) as Record<string, unknown>;
  assert.equal(out.reasoning_effort, "max");
});

test("B: `max` still collapses to `xhigh` for every other provider", () => {
  for (const model of ["openai/gpt-5", "anthropic/claude-opus-4-8", "z-ai/glm-5.2"]) {
    const out = normalizeReasoningRequest({ model, effort: "max" }) as Record<string, unknown>;
    assert.equal(out.reasoning_effort, "xhigh", `${model} must keep the canonical collapse`);
  }
  // The global vocabulary itself is unchanged.
  assert.deepEqual([...CANONICAL_EFFORT_VALUES], ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(normalizeEffort("max"), "xhigh");
});

test("C: routed DeepSeek namespaces are not treated as the native provider", () => {
  // These terminate at a different upstream whose effort vocabulary we do not control.
  for (const model of [
    "openrouter/deepseek/deepseek-v4-flash-0731",
    "tllm/deepseek_v4",
    "oc/deepseek-v4-flash-free",
  ]) {
    assert.equal(isDeepSeekNativeMaxModel(null, model), false, `${model} is not native`);
    const out = normalizeReasoningRequest({ model, effort: "max" }) as Record<string, unknown>;
    assert.equal(out.reasoning_effort, "xhigh");
  }
});

test("D: an explicit client reasoning_effort still wins over canonical effort", () => {
  const out = normalizeReasoningRequest({
    model: "ds/deepseek-v4-flash",
    effort: "max",
    reasoning_effort: "low",
  }) as Record<string, unknown>;
  assert.equal(out.reasoning_effort, "low", "explicit client intent must be preserved");
});

test("E: catalog effort tiers advertise `max` for native DeepSeek models only", () => {
  const base = [...CANONICAL_EFFORT_VALUES];

  const deepseekTiers = extendDeepSeekEffortValues("deepseek", "deepseek-v4-pro", base);
  assert.ok(deepseekTiers.includes("max"), "native DeepSeek must advertise the max tier");

  const otherTiers = extendDeepSeekEffortValues("openai", "gpt-5", base);
  assert.ok(!otherTiers.includes("max"), "other providers must be untouched");

  // Idempotent: never duplicate an already-present tier.
  const twice = extendDeepSeekEffortValues("ds", "deepseek-v4-flash", deepseekTiers);
  assert.equal(twice.filter((t) => t === "max").length, 1);
});
