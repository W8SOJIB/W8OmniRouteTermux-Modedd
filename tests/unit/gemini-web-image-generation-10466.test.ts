// Tests for gemini-web image generation (#10466).
//
// Fixtures are built from the documented StreamGenerate frame layout for
// generated images (corroborated by gpt4free's Gemini provider and
// HanaokaYuzu/Gemini-API's _parse_candidate):
//
//   wrb.fr line → JSON [ "wrb.fr", null, "<payload>" ]
//   payload     → JSON [ ..., [4] = [ candidate ] ]
//   candidate[1]        = [ "answer text" ]
//   candidate[12][1]    = web-search images (must NOT be collected)
//   candidate[12][7][0] = generated-image entries
//   entry[0][3][3]      = image URL (string OR list of strings)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-gweb-image-"));

const { parseStreamResponse, parseStreamResponseImages } =
  await import("../../open-sse/executors/gemini-web.ts");
const { handleGeminiWebImageGeneration, buildGeminiWebImagePrompt } =
  await import("../../open-sse/handlers/imageGeneration/providers/geminiWeb.ts");
const { parseImageModel, getImageProvider } =
  await import("../../open-sse/config/imageRegistry.ts");

// ─── Fixture builders ───────────────────────────────────────────────────────

/** Build one wrb.fr StreamGenerate line with the given candidate. */
function frameLine(candidate: unknown): string {
  const payload = JSON.stringify([null, [], null, null, [candidate]]);
  return JSON.stringify([["wrb.fr", null, payload]]);
}

/** Candidate carrying answer text and/or generated images. */
function candidate({
  text = "",
  generatedUrls = [],
  webImageUrls = [],
}: {
  text?: string;
  generatedUrls?: Array<string | string[]>;
  webImageUrls?: string[];
} = {}): unknown[] {
  const cand: unknown[] = [];
  cand[1] = [text];
  if (webImageUrls.length > 0 || generatedUrls.length > 0) {
    const ext: unknown[] = [];
    if (webImageUrls.length > 0) {
      // [12][1]: web-search result thumbnails — [[ [url, ...], ... ]]
      ext[1] = webImageUrls.map((u) => [[[u]]]);
    }
    if (generatedUrls.length > 0) {
      // [12][7][0]: generated-image entries; parser reads entry[0][3][3] = url
      ext[7] = [generatedUrls.map((u) => [[null, null, null, [null, null, null, u]]])];
    }
    cand[12] = ext;
  }
  return cand;
}

function streamResponse(lines: string[]): string {
  return [")]}'", ...lines.map((l) => `${l.length}\n${l}`)].join("\n");
}

const IMG_URL = "https://lh3.googleusercontent.com/gg-dl/generated-abc123";
const IMG_URL_2 = "https://lh3.googleusercontent.com/gg-dl/generated-def456";
const WEB_URL = "https://example.com/web-search-thumb.jpg";

// ─── parseStreamResponseImages ──────────────────────────────────────────────

test("extracts generated-image URL from a realistic frame (string form)", () => {
  const raw = streamResponse([
    frameLine(candidate({ text: "Here you go!", generatedUrls: [IMG_URL] })),
  ]);
  assert.deepEqual(parseStreamResponseImages(raw), [`${IMG_URL}=s2048`]);
});

test("handles list-form URL field (takes first http entry)", () => {
  const raw = streamResponse([
    frameLine(candidate({ generatedUrls: [["not-a-url", IMG_URL, IMG_URL_2]] })),
  ]);
  assert.deepEqual(parseStreamResponseImages(raw), [`${IMG_URL}=s2048`]);
});

test("dedupes across cumulative frames, preserving first-seen order", () => {
  // Frames are cumulative snapshots: frame 2 repeats image 1 and adds image 2.
  const raw = streamResponse([
    frameLine(candidate({ text: "partial", generatedUrls: [IMG_URL] })),
    frameLine(candidate({ text: "full answer", generatedUrls: [IMG_URL, IMG_URL_2] })),
  ]);
  assert.deepEqual(parseStreamResponseImages(raw), [`${IMG_URL}=s2048`, `${IMG_URL_2}=s2048`]);
});

test("does NOT collect web-search images at [12][1]", () => {
  const raw = streamResponse([
    frameLine(candidate({ text: "found these", webImageUrls: [WEB_URL] })),
  ]);
  assert.deepEqual(parseStreamResponseImages(raw), []);
});

test("does not double-append size directive when one is present", () => {
  const sized = `${IMG_URL}=w1024-h512`;
  const raw = streamResponse([frameLine(candidate({ generatedUrls: [sized] }))]);
  assert.deepEqual(parseStreamResponseImages(raw), [sized]);
});

test("returns [] for text-only frames (chat responses unaffected)", () => {
  const raw = streamResponse([frameLine(candidate({ text: "just text, no images" }))]);
  assert.deepEqual(parseStreamResponseImages(raw), []);
});

test("skips malformed lines without throwing", () => {
  const raw = [
    ")]}'",
    "garbage not json",
    JSON.stringify([["wrb.fr", null, "{broken json"]]),
    frameLine(candidate({ generatedUrls: [IMG_URL] })),
  ].join("\n");
  assert.deepEqual(parseStreamResponseImages(raw), [`${IMG_URL}=s2048`]);
});

test("text parser still extracts text from image-bearing frames", () => {
  const raw = streamResponse([
    frameLine(candidate({ text: "Here is your image!", generatedUrls: [IMG_URL] })),
  ]);
  assert.equal(parseStreamResponse(raw), "Here is your image!");
});

// ─── buildGeminiWebImagePrompt ──────────────────────────────────────────────

test("prompt leads with an explicit generation directive", () => {
  const prompt = buildGeminiWebImagePrompt({ prompt: "a red panda", size: "1024x1536" });
  assert.match(prompt, /^Generate an image for this prompt: a red panda/);
  assert.match(prompt, /Do not search the web/);
  assert.match(prompt, /1024x1536/);
});

// ─── handleGeminiWebImageGeneration ─────────────────────────────────────────

function fakeExecutor(jsonBody: object, status = 200) {
  return {
    execute: async () => ({
      response: new Response(JSON.stringify(jsonBody), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    }),
  };
}

const baseArgs = {
  model: "nano-banana-web",
  provider: "gemini-web",
  body: { prompt: "a red panda eating bamboo" },
  credentials: { apiKey: "***" },
  log: null,
  signal: null,
  clientHeaders: {},
};

test("success: returns image URLs in OpenAI image response shape", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    executorFactory: () =>
      fakeExecutor({
        choices: [{ message: { role: "assistant", content: "Here you go!" } }],
        x_gemini_web_image_urls: [IMG_URL],
      }),
  });
  assert.equal(res.success, true);
  assert.equal(res.data.data.length, 1);
  assert.equal(res.data.data[0].url, IMG_URL);
  assert.ok(res.data.created > 0);
});

test("success: b64_json downloads the image via injected fetcher", async () => {
  const bytes = Buffer.from("fake-png-bytes");
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    body: { prompt: "a red panda", response_format: "b64_json" },
    executorFactory: () =>
      fakeExecutor({
        choices: [{ message: { role: "assistant", content: "" } }],
        x_gemini_web_image_urls: [IMG_URL],
      }),
    imageFetcher: async (url: string) => {
      assert.equal(url, IMG_URL);
      return { buffer: bytes, contentType: "image/png" };
    },
  });
  assert.equal(res.success, true);
  assert.equal(res.data.data[0].b64_json, bytes.toString("base64"));
  assert.equal(res.data.data[0].url, undefined);
});

test("b64_json download failure surfaces a specific 502", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    body: { prompt: "a red panda", response_format: "b64_json" },
    executorFactory: () =>
      fakeExecutor({
        choices: [{ message: { role: "assistant", content: "" } }],
        x_gemini_web_image_urls: [IMG_URL],
      }),
    imageFetcher: async () => {
      throw new Error("Remote image fetch error 403");
    },
  });
  assert.equal(res.success, false);
  assert.equal(res.status, 502);
  assert.match(res.error, /generated an image but OmniRoute could not download it/);
});

test("no images generated: 502 includes assistant text (refusal visibility)", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    executorFactory: () =>
      fakeExecutor({
        choices: [{ message: { role: "assistant", content: "I can't generate that image." } }],
        x_gemini_web_image_urls: [],
      }),
  });
  assert.equal(res.success, false);
  assert.equal(res.status, 502);
  assert.match(res.error, /without generating an image/);
  assert.match(res.error, /I can't generate that image/);
});

test("missing prompt → 400", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    body: { prompt: "   " },
  });
  assert.equal(res.success, false);
  assert.equal(res.status, 400);
});

test("missing cookie → 401", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    credentials: {},
  });
  assert.equal(res.success, false);
  assert.equal(res.status, 401);
});

test("n above the cap → 400 with the cap named", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    body: { prompt: "a red panda", n: 5 },
  });
  assert.equal(res.success, false);
  assert.equal(res.status, 400);
  assert.match(res.error, /n=1\.\.4/);
});

test("executor error status passes through", async () => {
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    executorFactory: () => fakeExecutor({ error: "Missing Gemini cookies" }, 401),
  });
  assert.equal(res.success, false);
  assert.equal(res.status, 401);
});

test("n=2 runs sequentially and collects both turns' images", async () => {
  let calls = 0;
  const res = await handleGeminiWebImageGeneration({
    ...baseArgs,
    body: { prompt: "a red panda", n: 2 },
    executorFactory: () => ({
      execute: async () => {
        calls++;
        const url = calls === 1 ? IMG_URL : IMG_URL_2;
        return {
          response: new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "" } }],
              x_gemini_web_image_urls: [url],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ),
        };
      },
    }),
  });
  assert.equal(calls, 2);
  assert.equal(res.success, true);
  assert.deepEqual(
    res.data.data.map((d: { url?: string }) => d.url),
    [IMG_URL, IMG_URL_2]
  );
});

// ─── Registry wiring ────────────────────────────────────────────────────────

test("registry: gemini-web/nano-banana resolves to the gemini-web provider", () => {
  const parsed = parseImageModel("gemini-web/nano-banana-web");
  assert.equal(parsed.provider, "gemini-web");
  assert.equal(parsed.model, "nano-banana-web");
  const config = getImageProvider("gemini-web");
  assert.ok(config);
  assert.equal(config.format, "gemini-web");
  assert.equal(config.authHeader, "cookie");
});

test("registry: alias gweb/nano-banana resolves too", () => {
  const parsed = parseImageModel("gweb/nano-banana-web");
  assert.equal(parsed.provider, "gemini-web");
  assert.equal(parsed.model, "nano-banana-web");
});

test("registry regression: bare nano-banana still routes to adobe-firefly", () => {
  // adobe-firefly owns the bare nano-banana ids (operator decision 2026-07-31);
  // the new gemini-web entry must not steal that resolution.
  const parsed = parseImageModel("nano-banana");
  assert.equal(parsed.provider, "adobe-firefly");
});
