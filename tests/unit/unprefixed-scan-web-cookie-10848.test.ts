import test from "node:test";
import assert from "node:assert/strict";
import { IMAGE_PROVIDERS, parseImageModel } from "../../open-sse/config/imageRegistry.ts";

test("#10848 bare id that only exists on a cookie-auth web bridge should not silently resolve to it", () => {
  const chatgptWeb = IMAGE_PROVIDERS["chatgpt-web"];
  assert.equal(chatgptWeb.authHeader, "cookie");
  const otherProvidersWithSameId = Object.entries(IMAGE_PROVIDERS).filter(
    ([providerId, config]) =>
      providerId !== "chatgpt-web" && config.models.some((m) => m.id === "gpt-5.5")
  );
  assert.deepEqual(
    otherProvidersWithSameId,
    [],
    "expected only chatgpt-web (cookie) to register gpt-5.5"
  );

  const resolved = parseImageModel("gpt-5.5");

  assert.notDeepEqual(
    resolved,
    { provider: "chatgpt-web", model: "gpt-5.5" },
    "bare 'gpt-5.5' must not silently bind to the cookie-auth chatgpt-web bridge"
  );

  assert.deepEqual(parseImageModel("chatgpt-web/gpt-5.5"), {
    provider: "chatgpt-web",
    model: "gpt-5.5",
  });
  assert.deepEqual(parseImageModel("cgpt-web/gpt-5.5"), {
    provider: "chatgpt-web",
    model: "gpt-5.5",
  });
});
