import test from "node:test";
import assert from "node:assert/strict";

import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.data.ts";
import reviewedLiveIds from "../../open-sse/config/nvidiaHostedModels.snapshot.json" with { type: "json" };
import { nvidiaProvider } from "../../open-sse/config/providers/registry/nvidia/index.ts";

const registryIds = new Set(nvidiaProvider.models.map((model) => model.id));

const documentedFreeIds = new Set(
  FREE_MODEL_BUDGETS.filter((model) => model.provider === "nvidia").map((model) => model.modelId)
);

const reviewedIds = new Set(reviewedLiveIds);

test("NVIDIA registry excludes retired DeepSeek V4 models", () => {
  assert.ok(
    !registryIds.has("deepseek-ai/deepseek-v4-pro"),
    "retired deepseek-ai/deepseek-v4-pro must not be advertised"
  );

  assert.ok(
    !registryIds.has("deepseek-ai/deepseek-v4-flash"),
    "retired deepseek-ai/deepseek-v4-flash must not be advertised"
  );
});

test("NVIDIA static lifecycle metadata excludes known EOL models", () => {
  for (const modelId of ["z-ai/glm-5.1", "deepseek-ai/deepseek-v4-pro"]) {
    assert.ok(
      !reviewedIds.has(modelId),
      `${modelId} must not remain in the reviewed NVIDIA hosted-model snapshot`
    );

    assert.ok(
      !documentedFreeIds.has(modelId),
      `${modelId} must not remain in the NVIDIA free-model catalog`
    );
  }
});

test("NVIDIA cleanup preserves the healthy GLM replacement", () => {
  assert.ok(registryIds.has("z-ai/glm-5.2"), "z-ai/glm-5.2 must remain in the NVIDIA registry");

  assert.ok(
    reviewedIds.has("z-ai/glm-5.2"),
    "z-ai/glm-5.2 must remain in the reviewed NVIDIA hosted-model snapshot"
  );

  assert.ok(
    documentedFreeIds.has("z-ai/glm-5.2"),
    "z-ai/glm-5.2 must remain in the NVIDIA free-model catalog"
  );
});
