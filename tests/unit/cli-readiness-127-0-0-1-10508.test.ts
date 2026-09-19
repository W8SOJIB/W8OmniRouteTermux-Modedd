import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Regression guard for #10508: pollHealthOnce() used "localhost" (forcing DNS
// resolution) while the sibling isPortListening() already hard-codes 127.0.0.1
// for exactly this reason. A slow "localhost" DNS lookup (Windows VPN
// split-DNS/search-suffix probing, corporate resolvers, DNS-filtering
// security software) can exceed the 2s per-poll timeout and make
// waitForServer() report "hanging" forever even though the server is healthy.

const filePath = resolve(join(process.cwd(), "bin/cli/utils/pid.mjs"));
const source = readFileSync(filePath, "utf-8");

test("issue #10508: pollHealthOnce must target 127.0.0.1, not localhost", () => {
  const match = source.match(/fetch\(`http:\/\/([^:$]+):\$\{port\}\/api\/monitoring\/health`/);
  assert.ok(match, "pollHealthOnce fetch call not found");
  assert.equal(match[1], "127.0.0.1", "readiness poll must use the literal 127.0.0.1, not localhost");
});
