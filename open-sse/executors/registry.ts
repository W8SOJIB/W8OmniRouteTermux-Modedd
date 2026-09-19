import type { BaseExecutor } from "./base.ts";

// R0.3 — ExecutorRegistry: runtime registry for provider executors, mirroring
// open-sse/translator/registry.ts. Built-ins register at module load from
// executors/index.ts; getExecutor() resolves through this map instead of a
// hard-coded object literal. This is the seam the v4 plan (M1.6
// host.registerProvider) extends — today the surface is internal-only.
//
// The alias → executor mapping is characterized by
// tests/unit/executor-map-golden.test.ts (tests/snapshots/executors/): any
// change to keys, classes or instance sharing shows up as a golden diff.

const registry = new Map<string, BaseExecutor>();

/**
 * Register an executor under an alias. Aliases are unique: registering the
 * same alias twice throws, preserving the guarantee the old object literal
 * gave at compile time (duplicate keys were impossible).
 */
export function registerExecutor(alias: string, executor: BaseExecutor): void {
  if (registry.has(alias)) {
    throw new Error(`executor alias already registered: "${alias}"`);
  }
  registry.set(alias, executor);
}

export function getRegisteredExecutor(alias: string): BaseExecutor | undefined {
  return registry.get(alias);
}

export function hasRegisteredExecutor(alias: string): boolean {
  return registry.has(alias);
}

/** All registered aliases, in registration order. */
export function listExecutorAliases(): string[] {
  return [...registry.keys()];
}
