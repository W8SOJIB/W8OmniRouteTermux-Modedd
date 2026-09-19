import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-kie-11225-"));

const { KIE_IMAGE_MODELS } =
  await import("../../open-sse/config/providers/registry/kie/imageModels.ts");
const { handleImageGeneration, KIE_MARKET_UPSTREAM_MODEL_IDS, resolveKieMarketUpstreamModelId } =
  await import("../../open-sse/handlers/imageGeneration.ts");

/**
 * Issue #11225 — KIE Market public model IDs are namespaced for the OmniRoute
 * catalog (`kie/google-imagen/nano-banana-2`), but the KIE Market createTask
 * API expects the bare upstream model ID `nano-banana-2`. Sending the
 * namespaced id makes upstream reject the task.
 *
 * The mapping must be an explicit seam: other KIE Market ids such as
 * `seedream/4.5-text-to-image` ARE the real upstream ids and must pass through
 * unchanged, so a generic "strip everything before the slash" is wrong.
 *
 * These tests drive the real public `handleImageGeneration` entrypoint and
 * capture the payload at the final executor boundary (`fetch` to
 * `/api/v1/jobs/createTask`). No credentials, no network, no production data.
 */

interface CapturedCreate {
  url: string;
  body: Record<string, unknown>;
}

interface CapturedMarketGeneration {
  create: CapturedCreate;
  pollUrl: string;
  result: Awaited<ReturnType<typeof handleImageGeneration>>;
}

async function runKieMarketGeneration(publicModel: string): Promise<CapturedMarketGeneration> {
  const originalFetch = globalThis.fetch;
  let captured: CapturedCreate | undefined;
  let pollUrl = "";

  globalThis.fetch = (async (url: unknown, options: { body?: unknown } = {}) => {
    const stringUrl = String(url);

    if (stringUrl === "https://api.kie.ai/api/v1/jobs/createTask") {
      captured = {
        url: stringUrl,
        body: JSON.parse(String(options.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ code: 200, data: { taskId: "kie-market-task-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (stringUrl.startsWith("https://api.kie.ai/api/v1/jobs/recordInfo")) {
      pollUrl = stringUrl;
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            state: "success",
            resultJson: JSON.stringify({
              resultUrls: ["https://example.com/kie-market-image.png"],
            }),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  }) as typeof globalThis.fetch;

  try {
    const result = await handleImageGeneration({
      body: {
        model: publicModel,
        prompt: "a calm harbour at sunrise",
        size: "1024x1024",
        n: 1,
      },
      credentials: { apiKey: "test-kie-key" },
      log: null,
    });

    assert.equal(result.success, true, "KIE Market generation should succeed against the stub");
    assert.ok(captured, "expected a createTask request to be captured");
    assert.ok(pollUrl, "expected recordInfo polling to be captured");
    return { create: captured, pollUrl, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function resolveLiveKieMarketCatalog() {
  return KIE_IMAGE_MODELS.filter(({ isMarket }) => isMarket).map(({ id }) => ({
    publicModelId: id,
    upstreamModelId: resolveKieMarketUpstreamModelId(id),
  }));
}

test("KIE Market resolver changes exactly the 4 google-imagen ids in the live market catalog", () => {
  const roundTrips = resolveLiveKieMarketCatalog();
  const changed = roundTrips.filter(({ publicModelId, upstreamModelId }) => {
    return upstreamModelId !== publicModelId;
  });

  assert.deepEqual(changed, [
    {
      publicModelId: "google-imagen/nano-banana-2",
      upstreamModelId: "nano-banana-2",
    },
    {
      publicModelId: "google-imagen/nano-banana",
      upstreamModelId: "google/nano-banana",
    },
    {
      publicModelId: "google-imagen/nano-banana-pro",
      upstreamModelId: "nano-banana-pro",
    },
    {
      publicModelId: "google-imagen/nano-banana-edit",
      upstreamModelId: "google/nano-banana-edit",
    },
  ]);
});

const REWRITTEN_GOOGLE_IMAGEN_MARKET_IDS = new Set([
  "google-imagen/nano-banana",
  "google-imagen/nano-banana-2",
  "google-imagen/nano-banana-pro",
  "google-imagen/nano-banana-edit",
]);

test("KIE Market resolver preserves every other live market catalog id byte-identically", () => {
  for (const { publicModelId, upstreamModelId } of resolveLiveKieMarketCatalog()) {
    if (!REWRITTEN_GOOGLE_IMAGEN_MARKET_IDS.has(publicModelId)) {
      assert.equal(
        upstreamModelId,
        publicModelId,
        `${publicModelId} must round-trip byte-identically`
      );
    }
  }
});

test("KIE Market resolver keeps exactly the explicit google-imagen upstream id mappings (#11296)", () => {
  assert.equal(KIE_MARKET_UPSTREAM_MODEL_IDS.size, 4);
});

test("KIE Market resolver passes an unknown namespaced id through byte-identically", () => {
  const unknownModelId = "kie/foo/bar";
  let resolvedModelId = "";

  assert.doesNotThrow(() => {
    resolvedModelId = resolveKieMarketUpstreamModelId(unknownModelId);
  });
  assert.equal(resolvedModelId, unknownModelId);
});

test("KIE Market createTask sends the bare upstream model id for Nano Banana 2 (#11225)", async () => {
  const captured = await runKieMarketGeneration("kie/google-imagen/nano-banana-2");

  assert.equal(
    captured.create.body.model,
    "nano-banana-2",
    "KIE Market createTask must send the upstream model id, not the namespaced catalog id"
  );

  const input = captured.create.body.input as Record<string, unknown>;
  assert.equal(input.prompt, "a calm harbour at sunrise");
  assert.equal(input.aspect_ratio, "1:1");
  assert.equal(new URL(captured.pollUrl).searchParams.get("taskId"), "kie-market-task-1");
  assert.ok("data" in captured.result, "successful KIE generation must return image data");
  assert.equal(captured.result.data.data[0].url, "https://example.com/kie-market-image.png");
});

test("KIE Market createTask sends the KIE upstream id for Nano Banana (#11296)", async () => {
  const captured = await runKieMarketGeneration("kie/google-imagen/nano-banana");

  assert.equal(
    captured.create.body.model,
    "google/nano-banana",
    "KIE Market createTask must send the KIE-documented google/nano-banana upstream id"
  );
});

test("KIE Market createTask sends the bare upstream model id for Nano Banana Pro (#11296)", async () => {
  const captured = await runKieMarketGeneration("kie/google-imagen/nano-banana-pro");

  assert.equal(
    captured.create.body.model,
    "nano-banana-pro",
    "KIE Market createTask must send the KIE-documented nano-banana-pro upstream id"
  );
});

test("KIE Market createTask sends the KIE upstream id for Nano Banana Edit (#11296)", async () => {
  const captured = await runKieMarketGeneration("kie/google-imagen/nano-banana-edit");

  assert.equal(
    captured.create.body.model,
    "google/nano-banana-edit",
    "KIE Market createTask must send the KIE-documented google/nano-banana-edit upstream id"
  );
});

test("KIE Market createTask leaves genuinely namespaced upstream ids untouched (#11225 control)", async () => {
  const captured = await runKieMarketGeneration("kie/seedream/4.5-text-to-image");

  assert.equal(
    captured.create.body.model,
    "seedream/4.5-text-to-image",
    "seedream/4.5-text-to-image IS the upstream id and must not be stripped"
  );

  const input = captured.create.body.input as Record<string, unknown>;
  assert.equal(input.prompt, "a calm harbour at sunrise");
  assert.equal(input.aspect_ratio, "1:1");
});

test("KIE direct image routing keeps the gpt4o-image endpoint and payload shape", async () => {
  const originalFetch = globalThis.fetch;
  let createUrl = "";
  let createBody: Record<string, unknown> | undefined;

  globalThis.fetch = (async (url: unknown, options: { body?: unknown } = {}) => {
    const stringUrl = String(url);
    if (stringUrl === "https://api.kie.ai/api/v1/gpt4o-image/generate") {
      createUrl = stringUrl;
      createBody = JSON.parse(String(options.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ code: 200, data: { taskId: "kie-direct-task-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (stringUrl.startsWith("https://api.kie.ai/api/v1/gpt4o-image/record-info")) {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            status: "SUCCESS",
            response: { resultUrls: ["https://example.com/kie-direct-image.png"] },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  }) as typeof globalThis.fetch;

  try {
    const result = await handleImageGeneration({
      body: {
        model: "kie/gpt4o-image",
        prompt: "a direct-path control",
        size: "1024x1024",
        n: 2,
      },
      credentials: { apiKey: "test-kie-key" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(createUrl, "https://api.kie.ai/api/v1/gpt4o-image/generate");
    assert.deepEqual(createBody, {
      prompt: "a direct-path control",
      size: "1:1",
      nVariants: 2,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
