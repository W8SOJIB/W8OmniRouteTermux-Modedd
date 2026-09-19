import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers/web-cookie.ts";
import { hailuo_webProvider } from "../../open-sse/config/providers/registry/minimax/web/index.ts";

describe("hailuo-web domain updates (#11000)", () => {
  it("hailuo-web website targets chat.minimax.io to avoid 301 redirect errors", () => {
    const entry = WEB_COOKIE_PROVIDERS["hailuo-web"];
    assert.ok(entry);
    assert.equal(entry.website, "https://chat.minimax.io");
  });

  it("hailuo-web registry entry baseUrl targets chat.minimax.io", () => {
    assert.equal(hailuo_webProvider.baseUrl, "https://chat.minimax.io");
  });
});
