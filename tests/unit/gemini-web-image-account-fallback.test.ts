// #10494: Gemini Web image-generation account fallback gap.
//
// #10466's acceptance criteria require that "expired or blocked sessions
// return a clear session/provider error and can fall back normally inside an
// image Combo." The gemini-web image handler passed the executor's raw HTTP
// status straight through to executeImageWithCredentialFallback, whose retry
// loop only advances to the next account on a plain HTTP 401 — but the
// underlying GeminiWebExecutor's browser-automation catch paths surface an
// expired/blocked session as 400 (Playwright selector/click timeout — "the
// session is so expired it lands on a different page", #9407) or 500 (the
// generic automation-failure catch-all), never 401. So expired/blocked
// Gemini Web sessions never triggered account fallback.
//
// Covers:
// - isExpiredOrBlockedGeminiWebSession() classification (unit).
// - A multi-account regression: first account fails with a classified
//   status, the retry loop advances to a second account, which succeeds.
// - An invalid-session test that drives the REAL GeminiWebExecutor (Playwright
//   launch mocked, same technique as tests/unit/gemini-web.test.ts) so the
//   classified status is the executor's actual status code, not a synthetic
//   one, and confirms the handler marks it retryable end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-geminiweb-image-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { isExpiredOrBlockedGeminiWebSession, handleGeminiWebImageGeneration } = await import(
  "../../open-sse/handlers/imageGeneration/providers/geminiWeb.ts"
);
const { executeImageWithCredentialFallback } = await import(
  "../../src/sse/services/imageCredentialRetry.ts"
);
const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.ts");
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Classification (unit) ───────────────────────────────────────────────────

test("isExpiredOrBlockedGeminiWebSession classifies 400/500 as retryable, everything else as not", () => {
  assert.equal(isExpiredOrBlockedGeminiWebSession(400), true);
  assert.equal(isExpiredOrBlockedGeminiWebSession(500), true);
  assert.equal(isExpiredOrBlockedGeminiWebSession(401), false, "handled by the plain 401 path");
  assert.equal(
    isExpiredOrBlockedGeminiWebSession(503),
    false,
    "missing-Playwright-browser is a host/config problem, not a per-account issue"
  );
  assert.equal(isExpiredOrBlockedGeminiWebSession(502), false);
  assert.equal(isExpiredOrBlockedGeminiWebSession(200), false);
});

// ── Multi-account regression: 2 accounts, first classified-fails, second succeeds ──

test("executeImageWithCredentialFallback: expired/blocked (400) on account 1 falls back to account 2", async () => {
  const attempts: string[] = [];
  const accountA = { connectionId: "conn-a", apiKey: "cookie-a" };
  const accountB = { connectionId: "conn-b", apiKey: "cookie-b" };

  const execution = await executeImageWithCredentialFallback({
    provider: "gemini-web",
    requestedModel: "gemini-2.5-pro",
    credentials: accountA,
    // Simulates the real handler path: geminiWeb.ts sets retryable via
    // saveImageErrorResult when the executor status is classified as an
    // expired/blocked session (400/500), not just a plain 401.
    execute: async (creds) => {
      attempts.push(creds.connectionId);
      if (creds.connectionId === "conn-a") {
        return { success: false, status: 400, error: "session expired", retryable: true };
      }
      return { success: true, data: { created: 1, data: [{ url: "https://example/img.png" }] } };
    },
    selectNextCredentials: async () => accountB,
  });

  assert.deepEqual(attempts, ["conn-a", "conn-b"], "must try both accounts in order");
  assert.equal(execution.result.success, true);
  assert.equal(execution.credentials.connectionId, "conn-b");
});

test("executeImageWithCredentialFallback: a non-retryable 400 (e.g. bad prompt) does NOT burn a second account", async () => {
  const attempts: string[] = [];
  const accountA = { connectionId: "conn-a", apiKey: "cookie-a" };

  const execution = await executeImageWithCredentialFallback({
    provider: "gemini-web",
    requestedModel: "gemini-2.5-pro",
    credentials: accountA,
    execute: async (creds) => {
      attempts.push(creds.connectionId);
      return { success: false, status: 400, error: "Prompt is required" }; // retryable unset
    },
    selectNextCredentials: async () => {
      throw new Error("must not be called for a non-retryable failure");
    },
  });

  assert.deepEqual(attempts, ["conn-a"]);
  assert.equal(execution.result.success, false);
  assert.equal(execution.result.status, 400);
});

// ── Invalid-session test against the REAL executor's actual status code ────

test("handler classifies the REAL GeminiWebExecutor's session-expired 400 as retryable", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;

  // Mirrors tests/unit/gemini-web.test.ts's pattern for a fake page whose
  // waitForSelector() times out — the exact path (#9407) that makes the
  // real executor return a 400 tagged "the session is so expired it lands
  // on a different page".
  playwright.chromium.launch = (async () =>
    ({
      newContext: async () => ({
        addCookies: async () => {},
        newPage: async () => ({
          on: () => {},
          goto: async () => {},
          waitForTimeout: async () => {},
          waitForSelector: async () => {
            const err = new Error("Timeout 10000ms exceeded while waiting for selector");
            err.name = "TimeoutError";
            throw err;
          },
        }),
      }),
      close: async () => {},
    }) as unknown as ReturnType<typeof playwright.chromium.launch>) as typeof playwright.chromium.launch;

  try {
    const executor = new GeminiWebExecutor();
    const direct = await executor.execute({
      model: "gemini-2.5-pro",
      body: { messages: [{ role: "user", content: "hi" }], x_gemini_web_image_mode: true },
      stream: false,
      credentials: { apiKey: "expired-session-cookie" },
      signal: AbortSignal.timeout(10000),
      log: null,
    });
    // Confirm the REAL executor really does surface this as 400 (not a
    // synthetic status invented by the test).
    assert.equal(direct.response.status, 400, "sanity: executor's real session-expired status");

    const res = await handleGeminiWebImageGeneration({
      model: "gemini-2.5-pro",
      provider: "gemini-web",
      body: { prompt: "a kitten" },
      credentials: { apiKey: "expired-session-cookie", connectionId: "conn-real" },
      log: null,
      signal: null,
      clientHeaders: {},
      executorFactory: () => new GeminiWebExecutor(),
    });

    assert.equal(res.success, false);
    assert.equal(res.status, 400);
    assert.equal(
      (res as { retryable?: boolean }).retryable,
      true,
      "the handler must mark the real executor's session-expired status as retryable"
    );
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});
