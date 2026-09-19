import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { OpencodeExecutor } = await import("../../open-sse/executors/opencode.ts");

/**
 * Behavioral guards for the three type-only fixes in the TS 7 executor slice
 * (see #8484). Each fix restored a type the code already depended on at runtime;
 * these tests pin the runtime contracts so a future "simplification" of the
 * annotations cannot silently change behavior.
 *
 * The zed-hosted `SseEnqueueTarget` fix is already covered end-to-end by
 * `zed-hosted-think-close-marker.test.ts`, which drives the same TransformStream
 * that failed to type-check — no duplicate added here.
 */

describe("OpencodeExecutor — tools truncation survives the narrowing fix", () => {
  const executor = new OpencodeExecutor("opencode-go");
  const CREDENTIALS = { apiKey: "k" } as Record<string, unknown>;

  const tools = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: "function",
      function: { name: `tool_${i}`, parameters: {} },
    }));

  function bodyWith(toolCount: number) {
    return {
      model: "oc/kimi-k2.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: tools(toolCount),
    };
  }

  it("truncates an over-long tools array to 128 entries", () => {
    const out = executor.transformRequest("oc/kimi-k2.6", bodyWith(200), true, CREDENTIALS) as {
      tools: unknown[];
    };
    assert.equal(out.tools.length, 128, "upstream rejects more than 128 tools");
    assert.deepEqual(
      (out.tools[127] as { function: { name: string } }).function.name,
      "tool_127",
      "truncation keeps the first 128 in order, not an arbitrary slice"
    );
  });

  it("leaves a within-limit tools array untouched", () => {
    const out = executor.transformRequest("oc/kimi-k2.6", bodyWith(10), true, CREDENTIALS) as {
      tools: unknown[];
    };
    assert.equal(out.tools.length, 10);
  });

  it("is a no-op when the body carries no tools", () => {
    const body = {
      model: "oc/kimi-k2.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const out = executor.transformRequest("oc/kimi-k2.6", body, true, CREDENTIALS) as Record<
      string,
      unknown
    >;
    assert.equal("tools" in out, false);
    assert.ok(Array.isArray(out.messages), "messages preserved");
  });

  it("leaves an array-shaped body alone (pins the !Array.isArray guard)", () => {
    // The pre-fix condition reached `.tools` on any object, arrays included, and
    // relied on `Array.isArray(undefined)` short-circuiting. The explicit
    // !Array.isArray() guard must keep that outcome identical.
    const arrayBody = [{ role: "user", content: "hi" }] as unknown as Record<string, unknown>;
    const out = executor.transformRequest("oc/kimi-k2.6", arrayBody, true, CREDENTIALS);
    assert.ok(Array.isArray(out), "array body must pass through as an array");
    assert.equal((out as unknown[]).length, 1);
  });
});

