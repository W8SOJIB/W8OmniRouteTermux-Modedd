import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// R0.3 — unit tests for the ExecutorRegistry seam itself (registration
// semantics + wiring of the built-ins). Behavior parity of the full map is
// covered separately by tests/unit/executor-map-golden.test.ts.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-executor-registry-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { registerExecutor, getRegisteredExecutor, hasRegisteredExecutor, listExecutorAliases } =
  await import("../../open-sse/executors/registry.ts");
const { getExecutor, hasSpecializedExecutor, BaseExecutor, DefaultExecutor } = await import(
  "../../open-sse/executors/index.ts"
);

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("built-ins are registered at module load and resolve through the registry", () => {
  const aliases = listExecutorAliases();
  assert.ok(aliases.length >= 100, `expected the built-in table, got ${aliases.length} aliases`);
  for (const alias of ["antigravity", "kiro", "glm", "9router", "conol-web"]) {
    assert.ok(hasRegisteredExecutor(alias), `missing built-in: ${alias}`);
    assert.equal(getExecutor(alias), getRegisteredExecutor(alias));
    assert.ok(getExecutor(alias) instanceof BaseExecutor);
  }
});

test("registerExecutor throws on duplicate alias", () => {
  assert.throws(() => registerExecutor("kiro", getRegisteredExecutor("kiro")!), {
    message: /already registered: "kiro"/,
  });
});

test("registering a new alias makes it resolvable via getExecutor and hasSpecializedExecutor", () => {
  const alias = "registry-test-provider";
  assert.equal(hasSpecializedExecutor(alias), false);
  const instance = new DefaultExecutor(alias);
  registerExecutor(alias, instance);
  assert.equal(hasSpecializedExecutor(alias), true);
  assert.equal(getExecutor(alias), instance);
});

test("registry lookup is exact — Object.prototype names are not executors", () => {
  // The old object-literal lookup (`executors[provider]`) leaked prototype
  // members: getExecutor("constructor") returned Object's constructor. The Map
  // registry must treat these as unknown providers (DefaultExecutor fallback).
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(hasSpecializedExecutor(name), false, name);
    assert.ok(getExecutor(name) instanceof DefaultExecutor, name);
  }
});
