// #10379: Native Codex turn pin must allow fill-first failover across
// compatible connections for the same provider + model.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  applyNativeCodexTurnPin,
  pinNativeCodexTurn,
  getNativeCodexTurnPin,
  clearNativeCodexTurnPinsForTests,
} = await import("../../open-sse/services/combo/nativeCodexTurnPin.ts");

const BODY = {
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "t1", turn_id: "turn1" }),
  },
};

function makeTarget(connectionId: string, model = "gpt-5.6-sol", provider = "codex") {
  return {
    kind: "model" as const,
    stepId: `step-${connectionId}`,
    executionKey: `ek-${connectionId}`,
    modelStr: model,
    provider,
    providerId: null,
    connectionId,
    weight: 1,
    label: null,
  };
}

test("pinned connection is preferred but siblings are included as fallback", () => {
  clearNativeCodexTurnPinsForTests();
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-1"),
    connectionId: "conn-1",
  });

  const pin = getNativeCodexTurnPin(BODY, "test-combo")!;
  const targets = [makeTarget("conn-1"), makeTarget("conn-2"), makeTarget("conn-3")];
  const result = applyNativeCodexTurnPin(targets, pin);

  assert.equal(result.length, 3, "all compatible connections should be returned");
  assert.equal(result[0].connectionId, "conn-1", "pinned connection should be first");
  assert.deepEqual(result[0].allowedConnectionIds, ["conn-1", "conn-2", "conn-3"]);
});

test("fallback connections share the same allowedConnectionIds", () => {
  clearNativeCodexTurnPinsForTests();
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-2"),
    connectionId: "conn-2",
  });

  const pin = getNativeCodexTurnPin(BODY, "test-combo")!;
  const targets = [makeTarget("conn-1"), makeTarget("conn-2"), makeTarget("conn-3")];
  const result = applyNativeCodexTurnPin(targets, pin);

  assert.equal(result[0].connectionId, "conn-2");
  assert.equal(result[1].connectionId, "conn-1");
  assert.equal(result[2].connectionId, "conn-3");
  for (const t of result) {
    assert.deepEqual(t.allowedConnectionIds, ["conn-1", "conn-2", "conn-3"]);
  }
});

test("incompatible targets (different provider/model) are excluded", () => {
  clearNativeCodexTurnPinsForTests();
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-1"),
    connectionId: "conn-1",
  });

  const pin = getNativeCodexTurnPin(BODY, "test-combo")!;
  const targets = [
    makeTarget("conn-1"),
    makeTarget("conn-2"),
    makeTarget("conn-other", "different-model", "other-provider"),
  ];
  const result = applyNativeCodexTurnPin(targets, pin);

  assert.equal(result.length, 2, "incompatible target should be excluded");
  assert.deepEqual(result[0].allowedConnectionIds, ["conn-1", "conn-2"]);
});

test("empty result when no compatible targets exist", () => {
  clearNativeCodexTurnPinsForTests();
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-1"),
    connectionId: "conn-1",
  });

  const pin = getNativeCodexTurnPin(BODY, "test-combo")!;
  const targets = [makeTarget("conn-x", "other-model", "other-provider")];
  const result = applyNativeCodexTurnPin(targets, pin);

  assert.equal(result.length, 0);
});

test("pinNativeCodexTurn allows connectionId change for same provider+model", () => {
  clearNativeCodexTurnPinsForTests();
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-1"),
    connectionId: "conn-1",
  });

  // Should NOT throw when only connectionId changes
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-2"),
    connectionId: "conn-2",
  });

  const pin = getNativeCodexTurnPin(BODY, "test-combo")!;
  assert.equal(pin.connectionId, "conn-2", "pin should update to new connection");
});

test("pinNativeCodexTurn rejects provider/model change", () => {
  clearNativeCodexTurnPinsForTests();
  pinNativeCodexTurn({
    body: BODY,
    comboName: "test-combo",
    target: makeTarget("conn-1"),
    connectionId: "conn-1",
  });

  assert.throws(
    () =>
      pinNativeCodexTurn({
        body: BODY,
        comboName: "test-combo",
        target: makeTarget("conn-1", "different-model", "codex"),
        connectionId: "conn-1",
      }),
    /Native Codex turn target changed/
  );
});
