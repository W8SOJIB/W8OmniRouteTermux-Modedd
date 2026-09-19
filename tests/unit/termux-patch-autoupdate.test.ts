import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isTermux, applyTermuxPatches } from "../../src/lib/system/termuxPatch.ts";

test("isTermux detection signals", () => {
  assert.equal(isTermux({}), false);
  assert.equal(isTermux({ TERMUX_VERSION: "0.119" }), true);
  assert.equal(isTermux({ PREFIX: "/data/data/com.termux/files/usr" }), true);
  assert.equal(isTermux({ PREFIX: "/usr/local" }), false);
});

test("applyTermuxPatches modifies chunks, serve.mjs, and ensures cache", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "omniroute-termux-patch-test-"));

  try {
    // 1. Create mocked folder structure
    const chunksDir = join(tempDir, "dist", ".build", "next", "server", "chunks");
    const ssrDir = join(chunksDir, "ssr");
    const binDir = join(tempDir, "bin", "cli", "commands");
    mkdirSync(chunksDir, { recursive: true });
    mkdirSync(ssrDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    // Mock playwright chunk
    const playwrightChunk = join(chunksDir, "999_playwright_test.js");
    writeFileSync(
      playwrightChunk,
      'async function test(){let c=await x.y("playwright-core"); return c;}'
    );

    // Mock sqljs chunk
    const sqljsChunk = join(chunksDir, "src_lib_sqljsAdapter_test.js");
    writeFileSync(
      sqljsChunk,
      'const sqljsAdapter = { prepare(q) { const s = db.prepare(q); s.bind(args); s.free(); }, close() { if (clearInterval(t),t&&clearTimeout(x),x)try{a()}catch(e){}try{b.close()}catch(e){}c=!1} };'
    );

    // Mock instrumentation chunk
    const instrChunk = join(chunksDir, "instrumentation_node_test.js");
    writeFileSync(
      instrChunk,
      'async function registerNodejs() { const x = 1; await ensureDbInitialized(); }'
    );

    // Mock serve.mjs
    const serveMjs = join(binDir, "serve.mjs");
    writeFileSync(
      serveMjs,
      'if (existsSync(sqliteBinary) && !isNativeBinaryCompatible(sqliteBinary)) { process.exit(1); }'
    );

    // Run patcher
    const stats = applyTermuxPatches(tempDir);

    assert.equal(stats.playwright, 1);
    assert.equal(stats.bind, 1);
    assert.equal(stats.instrumentation, 1);
    assert.equal(stats.serve, 1);

    // Verify file contents
    const patchedPlaywright = readFileSync(playwrightChunk, "utf8");
    assert.ok(patchedPlaywright.includes("process.platform==='android'"));

    const patchedSqljs = readFileSync(sqljsChunk, "utf8");
    assert.ok(patchedSqljs.includes("__w8bindParams"));
    assert.ok(patchedSqljs.includes("close(){}"));

    const patchedInstr = readFileSync(instrChunk, "utf8");
    assert.ok(patchedInstr.includes("ensureDbInitialized"));
    assert.ok(patchedInstr.includes("[w8-init]"));

    const patchedServe = readFileSync(serveMjs, "utf8");
    assert.ok(patchedServe.includes('platform() !== "android"'));

    // Execute the patched helper and verify named parameters object binding
    const helperMatch = patchedSqljs.match(/function __w8bindParams\([\s\S]*?\n\}/);
    assert.ok(helperMatch, "BIND_HELPER must be present in patched file");
    const fn = new Function(`${helperMatch[0]}; return __w8bindParams;`)();

    // 1. Direct object (e.g. from toBindValue)
    const directObj = { "@id": "node-1", "@type": "openai-compatible", name: "Test" };
    const directRes = fn(directObj);
    assert.equal(typeof directRes, "object");
    assert.equal(directRes["@type"], "openai-compatible");
    assert.equal(directRes["type"], "openai-compatible");
    assert.equal(directRes[":type"], "openai-compatible");
    assert.equal(directRes["$type"], "openai-compatible");

    // 2. Wrapped in single-element array
    const arrObj = [{ id: "node-2", type: "anthropic-compatible" }];
    const arrRes = fn(arrObj);
    assert.equal(typeof arrRes, "object");
    assert.equal(arrRes["@type"], "anthropic-compatible");
    assert.equal(arrRes["type"], "anthropic-compatible");

    // 3. Positional array with boolean and date
    const posArr = ["test", true, undefined];
    const posRes = fn(posArr);
    assert.deepEqual(posRes, ["test", 1, null]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

