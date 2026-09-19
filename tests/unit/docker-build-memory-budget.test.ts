import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Docker publish workflow builds on GitHub-hosted runners (ubuntu-24.04 and
// ubuntu-24.04-arm): 4 vCPU, 16 GB RAM. Every Next page-data worker AND the
// parent `next build` process are separate OS processes, so the budget has to
// cover all of them, not just the workers. Both images (node and Bun) run the
// same build-next-isolated.mjs pipeline on the same runners; the Bun image runs
// Turbopack by default on Bun 1.4+ (#11471) and the webpack fallback
// (OMNIROUTE_USE_TURBOPACK=0) keeps memory in V8, so the guards must hold for
// both bundlers on both images (#11709).
//
// With 7 workers × 6144 MB the runner ran out and buildkit failed the step with
// `ResourceExhausted: ... cannot allocate memory`, right after "Collecting page
// data using 7 workers" — every Docker publish since 2026-08-22 23:14 UTC.
// Lowering to 2 workers (#10060 / PR #11419) was not enough: it modeled the
// per-process peak as an INFERENCE (`WORKER_PEAK_MB = 2560`, derived only from
// "7 workers didn't fit") and assumed the parent process tracked the V8 heap
// ceiling (`OMNIROUTE_BUILD_MEMORY_MB`) rather than its own RSS. The owner's
// live VPS reproduction (issue #7518, dmesg OOM-killer report, 2026-08-24)
// measured the real number directly: `next-build (v16) ... anon-rss:4522744kB`
// (~4.5 GB) per process, independent of the NODE_OPTIONS heap flag — Turbopack
// itself is native/Rust and compiles outside the V8 heap. With 2 workers that
// keeps the publish pipeline failing at "Collecting page data using 2 workers"
// (run 32907937950, 2026-08-25).
//
// This pins the budget on the MEASURED figure, applied uniformly to every
// process (parent + workers) and to both images, so raising the worker count
// has to be a deliberate change that re-does the arithmetic, not a one-line
// bump that silently reds the publish pipeline again.

const RUNNER_MEMORY_MB = 16 * 1024;
// Leave room for buildkit, the snapshotter and page cache.
const HEADROOM_FRACTION = 0.75;
// Measured (not inferred) peak RSS for a single Next/Turbopack build process —
// parent or page-data worker alike — from the dmesg OOM-killer report above.
// If a future build OOMs again, re-measure via dmesg before raising this
// number — do not weaken the budget with another guess.
const MEASURED_PROCESS_RSS_MB = 4500;

const DOCKERFILES = [
  { label: "Dockerfile", raw: readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8") },
  { label: "Dockerfile.bun", raw: readFileSync(fileURLToPath(new URL("../../Dockerfile.bun", import.meta.url)), "utf8") },
];

function readArgDefault(name: string, label: string): number {
  const raw = DOCKERFILES.find((entry) => entry.label === label)!.raw;
  const match = raw.match(new RegExp(`^ARG ${name}=(\\d+)$`, "m"));
  assert.ok(match, `${label} no longer declares ARG ${name}`);
  return Number(match![1]);
}

for (const { label } of DOCKERFILES) {
  test(`the ${label} build's worker pool is derived from OMNIROUTE_BUILD_WORKERS`, () => {
    // assert.ok(boolean), not assert.match — a failing assert.match dumps the
    // whole Dockerfile into the report.
    const raw = DOCKERFILES.find((entry) => entry.label === label)!.raw;
    assert.ok(
      /^ENV CIRCLE_NODE_TOTAL=\$\{OMNIROUTE_BUILD_WORKERS\}$/m.test(raw),
      `${label}: CIRCLE_NODE_TOTAL must stay wired to the build arg so a big builder can raise it`
    );
    assert.ok(
      /^ENV NODE_OPTIONS="--max-old-space-size=\$\{OMNIROUTE_BUILD_MEMORY_MB\}"$/m.test(raw),
      `${label}: the build heap ceiling must stay wired to OMNIROUTE_BUILD_MEMORY_MB`
    );
  });

  test(`worker count × measured per-process RSS fits a 16 GB GitHub runner (${label})`, () => {
    const workerPool = readArgDefault("OMNIROUTE_BUILD_WORKERS", label);

    // Next derives `workers = CIRCLE_NODE_TOTAL - 1`.
    const workers = workerPool - 1;
    assert.ok(workers >= 1, `${label}: CIRCLE_NODE_TOTAL=${workerPool} leaves no build workers`);

    // Every process — the parent `next build` process AND each page-data
    // worker — is budgeted at the measured per-process RSS floor (see the file
    // banner comment). The V8 heap ceiling (OMNIROUTE_BUILD_MEMORY_MB) bounds
    // JS allocations but not Turbopack's native/Rust memory, so it cannot stand
    // in for the parent process's real RSS.
    const processes = workers + 1;
    const worstCaseMb = processes * MEASURED_PROCESS_RSS_MB;
    const budgetMb = RUNNER_MEMORY_MB * HEADROOM_FRACTION;
    assert.ok(
      worstCaseMb <= budgetMb,
      `${label}: ${processes} processes (1 parent + ${workers} workers) × ${MEASURED_PROCESS_RSS_MB} MB ` +
        `measured RSS = ${worstCaseMb} MB exceeds the ${budgetMb} MB budget on a ` +
        `${RUNNER_MEMORY_MB} MB runner — the Docker publish step dies with "ResourceExhausted: ` +
        `cannot allocate memory" during page-data collection`
    );
  });

  test(`both images default to OMNIROUTE_BUILD_WORKERS=2 (1 page-data worker) (${label})`, () => {
    // At OMNIROUTE_BUILD_WORKERS=2 → CIRCLE_NODE_TOTAL=2 → Next derives 1
    // page-data worker, so 2 processes (parent + worker) × ~4.5 GB ≈ 9 GB fit
    // the 12.288 GB (75%) budget on a 16 GB runner with headroom. At =3 → 2
    // workers → 3 processes × 4.5 GB ≈ 13.5 GB, which exceeds it (measured
    // per-process RSS, #7518). Raising this default must re-do the budget
    // arithmetic and stay green on the test above (#11663).
    assert.equal(
      readArgDefault("OMNIROUTE_BUILD_WORKERS", label),
      2,
      `${label}: OMNIROUTE_BUILD_WORKERS must stay 2 (1 page-data worker)`
    );
  });

  test(`the worker pool does not oversubscribe the runner's 4 vCPU (${label})`, () => {
    const workers = readArgDefault("OMNIROUTE_BUILD_WORKERS", label) - 1;
    assert.ok(workers <= 4, `${workers} workers oversubscribe a 4 vCPU runner`);
  });
}