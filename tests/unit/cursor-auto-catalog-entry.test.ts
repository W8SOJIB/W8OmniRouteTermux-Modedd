import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ensureCursorAutoCatalogEntry } from "@/lib/providerModels/cursorAutoCatalog";

describe("ensureCursorAutoCatalogEntry", () => {
  it("injects auto when only wire id default is present", () => {
    const models = ensureCursorAutoCatalogEntry([
      { id: "default", name: "Auto", owned_by: "cursor" },
      { id: "composer-2.5", name: "Composer 2.5", owned_by: "cursor" },
    ]);
    assert.ok(models.some((m) => m.id === "auto"));
    assert.ok(models.some((m) => m.id === "default"));
  });

  it("injects auto-cost / auto-balance / auto-intelligence", () => {
    const models = ensureCursorAutoCatalogEntry([{ id: "auto", name: "Auto", owned_by: "cursor" }]);
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("auto-cost"));
    assert.ok(ids.includes("auto-balance"));
    assert.ok(ids.includes("auto-intelligence"));
  });

  it("does not duplicate existing auto entries", () => {
    const models = ensureCursorAutoCatalogEntry([
      { id: "auto", name: "Auto", owned_by: "cursor" },
      { id: "auto-cost", name: "Auto (cost)", owned_by: "cursor" },
    ]);
    assert.equal(models.filter((m) => m.id === "auto").length, 1);
    assert.equal(models.filter((m) => m.id === "auto-cost").length, 1);
  });
});
