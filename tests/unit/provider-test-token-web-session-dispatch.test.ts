import test from "node:test";
import assert from "node:assert/strict";

const { shouldUseApiKeyConnectionTest } =
  await import("../../src/app/api/providers/[id]/test/webSessionTestDispatch.ts");

test("normal API-key connections keep the API-key test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("apikey", "openai"), true);
});

test("token-kind cookie-auth web sessions use the API-key test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "deepseek-web"), true);

  assert.equal(shouldUseApiKeyConnectionTest("cookie", "zai-web"), true);
});

test("cookie-kind web sessions do not use the API-key test path", () => {
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "chatgpt-web"), false);

  assert.equal(shouldUseApiKeyConnectionTest("cookie", "claude-web"), false);
});

test("token-kind web sessions WITHOUT a token-aware validator stay off the API-key test path", () => {
  // hailuo-web and promptql are `kind: "token"` in WEB_SESSION_CREDENTIAL_REQUIREMENTS,
  // but neither has an entry in validation.ts's SPECIALTY_VALIDATORS map (nor a
  // token-aware branch like zai-web's in validateWebCookieProvider). Routing them through
  // the API-key test path would dispatch to the generic cookie probe, which sends the
  // stored token as a `Cookie` header and treats most non-401/403 responses as valid —
  // an invalid hailuo-web/promptql token could be reported as a healthy connection.
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "hailuo-web"), false);
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "promptql"), false);

  // Same reasoning applies to the other two token-kind providers with no validator.
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "microsoft-designer-web"), false);
  assert.equal(shouldUseApiKeyConnectionTest("cookie", "t3-chat-web"), false);
});

test("every token-kind web session with a real token-aware validator uses the API-key test path", () => {
  for (const providerId of ["deepseek-web", "kimi-web", "tinycms-web", "copilot-m365-web", "copilot-web", "zai-web"]) {
    assert.equal(shouldUseApiKeyConnectionTest("cookie", providerId), true, providerId);
  }
});

test("other auth types are not broadened", () => {
  assert.equal(shouldUseApiKeyConnectionTest("oauth", "deepseek-web"), false);

  assert.equal(shouldUseApiKeyConnectionTest(null, "deepseek-web"), false);
});
