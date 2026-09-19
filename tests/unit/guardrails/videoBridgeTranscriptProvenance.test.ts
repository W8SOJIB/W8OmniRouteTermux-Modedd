import assert from "node:assert/strict";
import test from "node:test";

import {
  describeVideoPart,
  normalizeVideoTranscript,
  type VideoCaptionFrame,
} from "../../../src/lib/guardrails/videoBridgeHelpers";

test("accepts only provenance-bearing transcript cues and deduplicates exact repeats", () => {
  const cues = normalizeVideoTranscript(
    {
      cues: [
        { text: "hello", start: 1, end: 3, source: "client", confidence: 0.8 },
        { text: "hello", start: 1, end: 3, source: "client", confidence: 0.8 },
        { text: "world", startSeconds: 3, endSeconds: 5, source: "audio-bridge" },
      ],
    },
    10
  );

  assert.deepEqual(cues, [
    { text: "hello", startSeconds: 1, endSeconds: 3, source: "client", confidence: 0.8 },
    { text: "world", startSeconds: 3, endSeconds: 5, source: "audio-bridge", confidence: 1 },
  ]);
});

test("rejects untrusted sources, malformed cues, and out-of-range timestamps", () => {
  assert.throws(
    () =>
      normalizeVideoTranscript({ cues: [{ text: "x", start: 1, end: 2, source: "unknown" }] }, 10),
    /source/i
  );
  assert.throws(
    () =>
      normalizeVideoTranscript({ cues: [{ text: "x", start: -1, end: 2, source: "client" }] }, 10),
    /timestamp|range/i
  );
  assert.throws(
    () =>
      normalizeVideoTranscript({ cues: [{ text: "x", start: 4, end: 4, source: "embedded" }] }, 10),
    /timestamp|range/i
  );
  assert.throws(
    () =>
      normalizeVideoTranscript(
        { cues: [{ text: "x", start: 9, end: 11, source: "embedded" }] },
        10
      ),
    /timestamp|range/i
  );
});

test("keeps transcript provenance attached to the described video output", async () => {
  const frames: VideoCaptionFrame[] = [
    { dataUri: "data:image/jpeg;base64,AA==", timestampSeconds: 2 },
    { dataUri: "data:image/jpeg;base64,AA==", timestampSeconds: 8 },
  ];
  const described = await describeVideoPart(
    {
      container: "messages",
      messageIndex: 0,
      partIndex: 0,
      ref: "data:video/mp4;base64,AA==",
      shape: "data_uri_string",
      transcript: {
        cues: [{ text: "spoken words", start: 1, end: 3, source: "audio-bridge", confidence: 0.9 }],
      },
    },
    { frameCount: 2, timeoutMs: 1000 },
    async () => "a scene",
    {
      extractFrames: async () => ({ durationSeconds: 10, frames }),
    }
  );

  assert.equal(described.transcriptCues?.length, 1);
  assert.match(described.description, /transcript\[source=audio-bridge;confidence=0\.90/);
  assert.match(described.description, /spoken words/);
});

test("fuses an explicitly supplied audio-bridge track without starting STT", async () => {
  let captionCalls = 0;
  const described = await describeVideoPart(
    {
      container: "messages",
      messageIndex: 0,
      partIndex: 0,
      ref: "data:video/mp4;base64,AA==",
      shape: "data_uri_string",
      audioTranscript: {
        cues: [{ text: "audio cue", start: 1, end: 3, source: "audio-bridge" }],
      },
    },
    { frameCount: 1, timeoutMs: 1000 },
    async () => {
      captionCalls += 1;
      return "visual cue";
    },
    {
      extractFrames: async () => ({
        durationSeconds: 5,
        frames: [{ dataUri: "data:image/jpeg;base64,AA==", timestampSeconds: 2 }],
      }),
    }
  );

  assert.equal(captionCalls, 1);
  assert.equal(described.transcriptCues?.[0]?.source, "audio-bridge");
  assert.match(described.description, /audio cue/);
  assert.deepEqual(described.fusion, {
    audioAvailable: true,
    videoAvailable: true,
    partial: false,
  });
});

test("an invalid audioTranscript degrades to a partial fusion and keeps the visual description", async () => {
  const described = await describeVideoPart(
    {
      container: "messages",
      messageIndex: 0,
      partIndex: 0,
      ref: "data:video/mp4;base64,AA==",
      shape: "data_uri_string",
      audioTranscript: {
        cues: [{ text: "late cue", start: 1, end: 99, source: "audio-bridge" }],
      },
    },
    { frameCount: 1, timeoutMs: 1000 },
    async () => "visual cue",
    {
      extractFrames: async () => ({
        durationSeconds: 5,
        frames: [{ dataUri: "data:image/jpeg;base64,AA==", timestampSeconds: 2 }],
      }),
    }
  );

  assert.match(described.description, /visual cue/);
  assert.equal(described.transcriptCues, undefined, "invalid audio must not add transcript cues");
  assert.deepEqual(described.fusion, {
    audioAvailable: false,
    videoAvailable: true,
    partial: true,
    failures: { audio: "FAILED" },
  });
});
