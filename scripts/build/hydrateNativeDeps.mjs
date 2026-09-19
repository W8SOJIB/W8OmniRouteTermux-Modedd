#!/usr/bin/env node
/**
 * Platform hydration for the shared Next standalone web build (issue #10321,
 * Stage 8).
 *
 * The standalone bundle is built ONCE on ubuntu and restored on every desktop
 * matrix leg. Everything except install-machine-forked optional packages is
 * platform-independent:
 *
 *  - Bundled-for-all (verify only): koffi ships every triplet under
 *    `build/koffi/<os>_<arch>`, better-sqlite3 v13 ships Node-API prebuilds for
 *    8 platforms, wreq-js ships `rust/wreq-js.<plat>-<arch>[-libc].node`, and
 *    onnxruntime-node ships `bin/napi-v6/<os>/<arch>`.
 *  - Install-machine-forked (hydrate): `@img/sharp-*`, `@img/sharp-libvips-*`,
 *    `@ngrok/ngrok-*` and macOS-only `fsevents` resolve to whichever platform
 *    ran `npm ci`. The ubuntu-built tree carries the linux forks; each leg
 *    replaces them with the forks from its OWN `npm ci`d node_modules.
 */

import fs from "node:fs";
import path from "node:path";

/** Scope prefixes whose members are install-machine-forked. */
export const HYDRATED_SCOPES = ["@img/sharp-", "@img/sharp-libvips-", "@ngrok/ngrok-"];

/** Standalone packages that are not forked but must never be platform-forked. */
export const HYDRATED_ROOT_PACKAGES = ["fsevents"];

/**
 * onnxruntime-node does not publish a darwin-x64 binary for napi-v6 (only
 * linux/win32 x64 + darwin arm64), so existence cannot be asserted there.
 */
export const BUNDLED_EXEMPTIONS = new Set(["onnxruntime-node:darwin-x64"]);

function platformTriple(platform, arch) {
  // koffi uses underscore triplets; better-sqlite3/wreq-js/onnx use dashes.
  return { koffi: `${platform}_${arch}`, dash: `${platform}-${arch}` };
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: false, force: true });
}

function directMemberNames(nodeModulesDir, scope) {
  const scopeDir = path.join(nodeModulesDir, ...scope.split("/").slice(0, -1));
  const prefix = scope.split("/").pop();
  try {
    return fs
      .readdirSync(scopeDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => `${scope.slice(0, scope.lastIndexOf("/"))}/${name}`);
  } catch {
    return [];
  }
}

/**
 * Replace install-machine-forked packages inside the restored standalone tree
 * with the forks resolved by THIS machine's node_modules.
 *
 * @param {{standaloneNodeModules: string, sourceNodeModules: string}} opts
 * @returns {{replaced: string[], removed: string[], copied: string[]}}
 */
export function hydratePlatformNatives({ standaloneNodeModules, sourceNodeModules }) {
  const replaced = [];
  const removed = [];
  const copied = [];

  const forkedNames = new Set();
  for (const scope of HYDRATED_SCOPES) {
    for (const name of directMemberNames(sourceNodeModules, scope)) forkedNames.add(name);
    for (const name of directMemberNames(standaloneNodeModules, scope)) forkedNames.add(name);
  }
  for (const pkg of HYDRATED_ROOT_PACKAGES) {
    if (fs.existsSync(path.join(sourceNodeModules, pkg))) forkedNames.add(pkg);
    if (fs.existsSync(path.join(standaloneNodeModules, pkg))) forkedNames.add(pkg);
  }

  for (const name of forkedNames) {
    const standalonePath = path.join(standaloneNodeModules, ...name.split("/"));
    const sourcePath = path.join(sourceNodeModules, ...name.split("/"));
    const hadIt = fs.existsSync(standalonePath);
    const hasIt = fs.existsSync(sourcePath);
    if (hadIt) rmrf(standalonePath);
    if (!hasIt) {
      if (hadIt) removed.push(name);
      continue; // e.g. fsevents on non-darwin legs: simply absent everywhere.
    }
    copyDir(sourcePath, standalonePath);
    copied.push(name);
    if (hadIt) replaced.push(name);
  }
  return { replaced, removed, copied };
}

/**
 * Assert that every bundled native dependency can service `platform`/`arch`.
 *
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function verifyBundledNatives({ nodeModulesDir, platform, arch }) {
  const errors = [];
  const triple = platformTriple(platform, arch);

  const koffiDir = path.join(nodeModulesDir, "koffi", "build", "koffi", triple.koffi);
  if (!fs.existsSync(koffiDir)) errors.push(`koffi: missing bundled triplet ${triple.koffi}`);

  const sqlitePrebuild = path.join(
    nodeModulesDir,
    "better-sqlite3",
    "prebuilds",
    `${triple.dash}.node`
  );
  if (!fs.existsSync(sqlitePrebuild))
    errors.push(`better-sqlite3: missing prebuild ${triple.dash}.node`);

  const wreqDir = path.join(nodeModulesDir, "wreq-js", "rust");
  const wreqNames = fs.existsSync(wreqDir)
    ? fs
        .readdirSync(wreqDir)
        .filter((n) => n.startsWith(`wreq-js.${triple.dash}`) && n.endsWith(".node"))
    : [];
  if (wreqNames.length === 0) errors.push(`wreq-js: missing rust binary for ${triple.dash}`);

  const exempt = BUNDLED_EXEMPTIONS.has(`onnxruntime-node:${triple.dash}`);
  if (!exempt) {
    const onnxDir = path.join(nodeModulesDir, "onnxruntime-node", "bin", "napi-v6", platform, arch);
    if (!fs.existsSync(onnxDir))
      errors.push(`onnxruntime-node: missing ${platform}/${arch} binary`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
