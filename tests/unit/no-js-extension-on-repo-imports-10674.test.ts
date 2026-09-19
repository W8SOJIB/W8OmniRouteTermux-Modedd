import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #10674: `open-sse/services/combo.ts` imported `"../../src/lib/localDb.js"` — a
 * `.js` suffix on a file that only exists as `.ts`. Turbopack used to resolve it
 * anyway; after the dependency-tree change in #10647 it stopped, and the
 * instrumentation hook died at boot with MODULE_NOT_FOUND, taking down `npm run dev`
 * and the production build (60 consecutive red `Build App` runs).
 *
 * A `.js` specifier is legitimate for npm packages that publish ESM that way
 * (e.g. `@modelcontextprotocol/sdk/client/index.js`) — this guard only rejects
 * RELATIVE specifiers, which always point at first-party TypeScript here.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function relativeJsImports(): string[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-n", "-E", 'from "\\.{1,2}/[^"]*\\.js"', "--", "open-sse/**/*.ts", "src/**/*.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
  } catch (err) {
    // git grep exits 1 with no output when nothing matches — that is the clean state.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out.split("\n").filter((line) => line.trim().length > 0);
}

test("no first-party TypeScript module is imported through a .js specifier", () => {
  const offenders = relativeJsImports();
  assert.deepEqual(
    offenders,
    [],
    `Relative imports must use the real .ts extension — a .js suffix resolves only by ` +
      `bundler accident and breaks boot when the toolchain changes (#10674):\n${offenders.join("\n")}`
  );
});
