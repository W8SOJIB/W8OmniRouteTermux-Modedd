import { createHash } from "node:crypto";

import { fetch as undiciFetch } from "undici";

import { getSettings as defaultGetSettings } from "@/lib/db/settings";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import {
  resolveVideoBridgeRuntimeSettings,
  resolveVisionBridgeRuntimeSettings,
  type VideoAnalysisMode,
} from "@/shared/constants/modalityBridgeDefaults";

import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import {
  bridgeCacheKey,
  getSharedBridgeCacheFor,
  type BridgeCacheEntry,
  type BridgeCacheStore,
} from "./modalityBridge/bridgeCache";
import { recordBridgeUse } from "./modalityBridge/bridgeStats";
import {
  composeVideoFramePrompt,
  describeVideoPart as defaultDescribeVideoPart,
  extractVideoFocusHint,
  extractVideoParts,
  loadVideoPartBytes,
  replaceVideoParts,
  resolveVideoDedupCandidateFrameCount,
  VIDEO_BRIDGE_MAX_BYTES,
  VIDEO_DEDUP_MAX_CANDIDATE_FRAMES,
  VIDEO_DEDUP_POLICY_VERSION,
  VIDEO_DEDUP_THRESHOLD,
  type DescribeVideoDependencies,
  type DescribedVideo,
  type VideoFusionTelemetry,
  type VideoPart,
} from "./videoBridgeHelpers";
import {
  getSharedVideoResultCacheFor,
  runVideoDownloadSingleflight,
  runVideoResultSingleflight,
  safeDeleteCacheEntry,
  safeGetCacheEntry,
  safeSetCacheEntry,
  videoBridgeAbortError,
} from "./videoBridgeResultCache";
import {
  callVisionModel as defaultCallVisionModel,
  type VisionModelConfig,
} from "./visionBridgeHelpers";
import { getBestVisionModel } from "./visionBridgeRouter";

type VideoBridgeBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  input?: Array<{ role?: string; content?: unknown }>;
  [key: string]: unknown;
};

export interface VideoAnalysisContext {
  /** Effective prompt behavior after the no-text fallback. */
  analysisMode: VideoAnalysisMode;
  /** Canonical, bounded user text. This remains untrusted context. */
  focusHint?: string;
  /** SHA-256 of the canonical hint; raw task text is never stored in cache metadata. */
  focusHintFingerprint: string | null;
  requestedAnalysisMode: VideoAnalysisMode;
}

function combineModelIdentities(models: ReadonlySet<string>, fallback: string): string {
  if (models.size === 0) return fallback;
  if (models.size === 1) return models.values().next().value ?? fallback;
  return "mixed";
}

function safeTranscriptFingerprint(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "invalid-transcript";
  }
}

function waitForVideoBridgePromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(videoBridgeAbortError());
  return new Promise<T>((resolve, reject) => {
    let completed = false;
    const finish = (callback: () => void): void => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(videoBridgeAbortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

const VIDEO_BRIDGE_RESULT_CACHE_VERSION = "v4";
const VIDEO_BRIDGE_RESULT_CACHE_POLICY = "sampling-then-dedup-v2";
const VIDEO_BRIDGE_RESULT_CACHE_KEY_KIND = "video-result-v4";
const VIDEO_BRIDGE_DOWNLOAD_FLIGHT_VERSION = "v1";

function buildVideoDownloadFlightKey(
  part: VideoPart,
  context: GuardrailContext,
  maxBytes: number,
  timeoutMs: number
): string {
  const rawPrincipalId = context.apiKeyInfo?.id;
  const principalId =
    typeof rawPrincipalId === "string" || typeof rawPrincipalId === "number"
      ? String(rawPrincipalId)
      : "local";
  const canonicalIdentity = JSON.stringify({
    container: part.container,
    endpoint: context.endpoint ?? null,
    maxBytes,
    method: context.method ?? null,
    model: context.model ?? null,
    provider: context.provider ?? null,
    ref: part.ref,
    shape: part.shape,
    sourceFormat: context.sourceFormat ?? null,
    targetFormat: context.targetFormat ?? null,
    timeoutMs,
    version: VIDEO_BRIDGE_DOWNLOAD_FLIGHT_VERSION,
  });
  const requestFingerprint = createHash("sha256").update(canonicalIdentity).digest("hex");
  // The authenticated database id is an ephemeral in-memory scope, not a
  // password or persisted credential. Keep it out of cryptographic hashes so
  // password-hash analysis cannot conflate tenant partitioning with storage.
  return `video-download:${JSON.stringify([principalId, requestFingerprint])}`;
}

interface VideoResultCacheMetadata {
  analysisMode: VideoAnalysisMode;
  cacheVersion: string;
  policyVersion: string;
  extractorVersion: string;
  strategy: string;
  model: string;
  prompt: string;
  frameCount: number;
  maxVideos: number;
  dedupCandidateFrameCount: number;
  dedupPolicyVersion: string;
  dedupThreshold: number;
  durationSeconds: number;
  framesRequested: number;
  framesExtracted: number;
  framesUsed: number;
  dedupDropped?: number;
  focusStartSeconds?: number;
  focusEndSeconds?: number;
  focusHintFingerprint: string | null;
  samplingCandidateCount?: number;
  samplingPolicyEffective?: "uniform" | "scene_aware" | "segment_aware";
  samplingPolicyRequested?: "uniform" | "scene_aware" | "segment_aware";
  transcriptCuesApplied?: number;
  contactSheetUsed?: boolean;
  fusion?: VideoFusionTelemetry;
  cacheBytes: number;
  modelUsed: string;
}

type VideoResultCacheIdentity = Pick<
  VideoResultCacheMetadata,
  | "analysisMode"
  | "cacheVersion"
  | "dedupCandidateFrameCount"
  | "dedupPolicyVersion"
  | "dedupThreshold"
  | "extractorVersion"
  | "frameCount"
  | "focusHintFingerprint"
  | "maxVideos"
  | "model"
  | "policyVersion"
  | "prompt"
  | "strategy"
>;

const VIDEO_RESULT_CACHE_IDENTITY_KEYS: readonly (keyof VideoResultCacheIdentity)[] = [
  "analysisMode",
  "cacheVersion",
  "dedupCandidateFrameCount",
  "dedupPolicyVersion",
  "dedupThreshold",
  "extractorVersion",
  "frameCount",
  "focusHintFingerprint",
  "maxVideos",
  "model",
  "policyVersion",
  "prompt",
  "strategy",
];

function createVideoResultCacheIdentity(
  runtime: ReturnType<typeof resolveVideoBridgeRuntimeSettings>,
  visionRuntime: ReturnType<typeof resolveVisionBridgeRuntimeSettings>,
  model: string,
  analysis: VideoAnalysisContext
): VideoResultCacheIdentity {
  return {
    analysisMode: analysis.analysisMode,
    cacheVersion: VIDEO_BRIDGE_RESULT_CACHE_VERSION,
    dedupCandidateFrameCount: resolveVideoDedupCandidateFrameCount(runtime.frameCount),
    dedupPolicyVersion: VIDEO_DEDUP_POLICY_VERSION,
    dedupThreshold: VIDEO_DEDUP_THRESHOLD,
    extractorVersion: VIDEO_BRIDGE_RESULT_CACHE_VERSION,
    frameCount: runtime.frameCount,
    focusHintFingerprint: analysis.focusHintFingerprint,
    maxVideos: runtime.maxVideos,
    model,
    policyVersion: VIDEO_BRIDGE_RESULT_CACHE_POLICY,
    prompt: visionRuntime.prompt,
    strategy: runtime.samplingPolicy,
  };
}

function buildVideoResultCacheKey(
  contentFingerprint: string,
  identity: VideoResultCacheIdentity,
  part: VideoPart
): string {
  return bridgeCacheKey(contentFingerprint, identity.prompt, identity.model, {
    analysisMode: identity.analysisMode,
    kind: VIDEO_BRIDGE_RESULT_CACHE_KEY_KIND,
    dedupCandidateFrameCount: identity.dedupCandidateFrameCount,
    dedupPolicyVersion: identity.dedupPolicyVersion,
    dedupThreshold: identity.dedupThreshold,
    extractorVersion: identity.extractorVersion,
    policyVersion: identity.policyVersion,
    strategy: identity.strategy,
    frameCount: identity.frameCount,
    maxVideos: identity.maxVideos,
    focusEndSeconds: part.focusWindow?.endSeconds ?? null,
    focusHintFingerprint: identity.focusHintFingerprint,
    focusStartSeconds: part.focusWindow?.startSeconds ?? null,
    transcript: safeTranscriptFingerprint(part.transcript),
    audioTranscript: safeTranscriptFingerprint(part.audioTranscript),
    contactSheet: part.contactSheet ?? false,
    version: identity.cacheVersion,
  });
}

function matchesVideoResultCacheIdentity(
  metadata: VideoResultCacheMetadata,
  identity: VideoResultCacheIdentity
): boolean {
  return VIDEO_RESULT_CACHE_IDENTITY_KEYS.every((key) => metadata[key] === identity[key]);
}

function isFusionTelemetry(value: unknown): value is VideoFusionTelemetry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.audioAvailable !== "boolean" ||
    typeof record.videoAvailable !== "boolean" ||
    typeof record.partial !== "boolean"
  ) {
    return false;
  }
  if (record.failures === undefined) return true;
  if (!record.failures || typeof record.failures !== "object") return false;
  return Object.entries(record.failures as Record<string, unknown>).every(
    ([source, code]) =>
      (source === "audio" || source === "video") &&
      (code === "ABORTED" || code === "FAILED" || code === "INVALID")
  );
}

export interface VideoBridgeDependencies {
  getSettings?: () => Promise<Record<string, unknown>>;
  getCapabilities?: (model: string) => { supportsVideo: boolean | null };
  describePart?: (part: VideoPart, analysis: VideoAnalysisContext) => Promise<DescribedVideo>;
  extractFrames?: DescribeVideoDependencies["extractFrames"];
  fetchRemote?: DescribeVideoDependencies["fetchRemote"];
  resultCache?: BridgeCacheStore;
  selectVisionModel?: (fixedModel?: string) => Promise<string | null>;
  callVisionModel?: (
    imageDataUri: string,
    config: VisionModelConfig,
    apiKey?: string
  ) => Promise<string>;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && Number.isInteger(value);
}

function isVideoResultCacheMetadata(
  value: unknown,
  expectedCacheBytes: number
): value is VideoResultCacheMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    !isFiniteNonNegativeInteger(record.framesRequested) ||
    !isFiniteNonNegativeInteger(record.framesExtracted) ||
    !isFiniteNonNegativeInteger(record.framesUsed) ||
    !isFiniteNonNegativeInteger(record.dedupCandidateFrameCount) ||
    record.dedupCandidateFrameCount < 1 ||
    record.dedupCandidateFrameCount > VIDEO_DEDUP_MAX_CANDIDATE_FRAMES ||
    record.framesExtracted > record.dedupCandidateFrameCount ||
    record.framesUsed > record.framesRequested ||
    record.framesUsed > record.framesExtracted
  ) {
    return false;
  }
  const dedupDropped = record.dedupDropped ?? 0;
  if (
    !isFiniteNonNegativeInteger(dedupDropped) ||
    record.framesUsed + dedupDropped > record.framesExtracted
  ) {
    return false;
  }
  if (
    (record.focusStartSeconds !== undefined &&
      !isFiniteNonNegativeNumber(record.focusStartSeconds)) ||
    (record.focusEndSeconds !== undefined && !isFiniteNonNegativeNumber(record.focusEndSeconds)) ||
    (typeof record.focusStartSeconds === "number" &&
      typeof record.focusEndSeconds === "number" &&
      record.focusStartSeconds > record.focusEndSeconds)
  ) {
    return false;
  }
  return (
    (record.analysisMode === "full" || record.analysisMode === "focused") &&
    ((record.analysisMode === "full" && record.focusHintFingerprint === null) ||
      (record.analysisMode === "focused" &&
        typeof record.focusHintFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(record.focusHintFingerprint))) &&
    typeof record.cacheVersion === "string" &&
    typeof record.dedupPolicyVersion === "string" &&
    typeof record.dedupThreshold === "number" &&
    Number.isFinite(record.dedupThreshold) &&
    record.dedupThreshold >= 0 &&
    record.dedupThreshold <= 1 &&
    typeof record.policyVersion === "string" &&
    typeof record.extractorVersion === "string" &&
    typeof record.strategy === "string" &&
    typeof record.model === "string" &&
    typeof record.prompt === "string" &&
    isFiniteNonNegativeInteger(record.frameCount) &&
    isFiniteNonNegativeInteger(record.maxVideos) &&
    isFiniteNonNegativeNumber(record.durationSeconds) &&
    isFiniteNonNegativeInteger(record.cacheBytes) &&
    record.cacheBytes === expectedCacheBytes &&
    typeof record.modelUsed === "string" &&
    (record.samplingCandidateCount === undefined ||
      isFiniteNonNegativeInteger(record.samplingCandidateCount)) &&
    (record.samplingPolicyEffective === undefined ||
      record.samplingPolicyEffective === "uniform" ||
      record.samplingPolicyEffective === "scene_aware" ||
      record.samplingPolicyEffective === "segment_aware") &&
    (record.samplingPolicyRequested === undefined ||
      record.samplingPolicyRequested === "uniform" ||
      record.samplingPolicyRequested === "scene_aware" ||
      record.samplingPolicyRequested === "segment_aware") &&
    (record.transcriptCuesApplied === undefined ||
      isFiniteNonNegativeInteger(record.transcriptCuesApplied)) &&
    (record.contactSheetUsed === undefined || typeof record.contactSheetUsed === "boolean") &&
    (record.fusion === undefined || isFusionTelemetry(record.fusion))
  );
}

function isVideoResultCacheEntry(
  entry: BridgeCacheEntry
): entry is BridgeCacheEntry & { metadata: VideoResultCacheMetadata; value: string } {
  if (typeof entry.value !== "string") return false;
  return (
    (entry.producerModel === undefined || typeof entry.producerModel === "string") &&
    isVideoResultCacheMetadata(entry.metadata, Buffer.byteLength(entry.value, "utf8"))
  );
}

function resolveVideoAnalysisContext(
  body: VideoBridgeBody,
  requestedAnalysisMode: VideoAnalysisMode
): VideoAnalysisContext {
  const focusHint = requestedAnalysisMode === "focused" ? extractVideoFocusHint(body) : undefined;
  return {
    analysisMode: focusHint ? "focused" : "full",
    ...(focusHint ? { focusHint } : {}),
    focusHintFingerprint: focusHint ? createHash("sha256").update(focusHint).digest("hex") : null,
    requestedAnalysisMode,
  };
}

export class VideoBridgeGuardrail extends BaseGuardrail {
  name = "video-bridge";
  priority = 7;

  private readonly deps: VideoBridgeDependencies;

  constructor(options?: { enabled?: boolean; deps?: VideoBridgeDependencies }) {
    super("video-bridge", { priority: 7, enabled: options?.enabled });
    this.deps = options?.deps ?? {};
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    if (!this.enabled || context.disabledGuardrails?.includes("video-bridge")) {
      return { block: false };
    }

    if (context.signal?.aborted) throw new Error("Video Bridge processing was aborted");

    const body = payload as VideoBridgeBody;
    const model = context.model || body.model;
    if (!model) return { block: false };

    const getSettings = this.deps.getSettings ?? defaultGetSettings;
    let persisted: Record<string, unknown> = {};
    try {
      persisted = await getSettings();
    } catch {
      // Early boot can run before the settings database is ready; defaults are safe.
    }
    const runtime = resolveVideoBridgeRuntimeSettings(persisted);
    if (!runtime.enabled) return { block: false };

    const parts = extractVideoParts(body);
    if (parts.length === 0) return { block: false };

    const capabilities = (this.deps.getCapabilities ?? getResolvedModelCapabilities)(model);
    if (capabilities.supportsVideo === true) return { block: false };

    const analysis = resolveVideoAnalysisContext(body, runtime.analysisMode);
    const visionRuntime = resolveVisionBridgeRuntimeSettings(persisted);
    const configuredModel = runtime.model.trim() || visionRuntime.model.trim();
    const routingPlanModel = configuredModel || "auto";
    const cache = runtime.cacheEnabled
      ? (this.deps.resultCache ?? getSharedVideoResultCacheFor(runtime))
      : null;
    const successfulModels = new Set<string>();
    let selectedModelPromise: Promise<string | null> | null = null;
    const selectVideoModel = (): Promise<string | null> => {
      if (!selectedModelPromise) {
        const select =
          this.deps.selectVisionModel ??
          ((fixedModel?: string) => getBestVisionModel({ fixedModel }));
        selectedModelPromise = select(configuredModel || undefined);
      }
      return selectedModelPromise;
    };
    const startedAt = Date.now();
    const descriptions: Array<string | null> = [];
    let totalFramesRequested = 0;
    let totalFramesExtracted = 0;
    let totalFramesUsed = 0;
    let totalDurationSeconds = 0;
    let totalCacheHits = 0;
    let totalSamplingCandidateCount = 0;
    let totalDedupDropped = 0;
    let focusWindowsApplied = 0;
    let focusHintsApplied = 0;
    let transcriptCuesApplied = 0;
    let contactSheetsUsed = 0;
    let audioFusionRuns = 0;
    let audioFusionPartials = 0;
    const audioFusionFailureCodes = new Set<string>();
    const recordFusionTelemetry = (fusion?: VideoFusionTelemetry): void => {
      if (!fusion) return;
      audioFusionRuns += 1;
      if (fusion.partial) audioFusionPartials += 1;
      for (const [source, code] of Object.entries(fusion.failures ?? {})) {
        audioFusionFailureCodes.add(`${source}:${code}`);
      }
    };
    let samplingPolicyEffective: "uniform" | "scene_aware" | "segment_aware" = "uniform";
    let failures = 0;

    const attemptedParts = parts.slice(0, runtime.maxVideos);
    for (let index = 0; index < attemptedParts.length; index++) {
      if (context.signal?.aborted) throw new Error("Video Bridge processing was aborted");
      const part = attemptedParts[index];
      const attemptStartedAt = Date.now();
      const timeoutController = new AbortController();
      const attemptTimeout = setTimeout(() => timeoutController.abort(), runtime.timeoutMs);
      const attemptSignal = context.signal
        ? AbortSignal.any([context.signal, timeoutController.signal])
        : timeoutController.signal;
      try {
        const selectedModel = await waitForVideoBridgePromise(selectVideoModel(), attemptSignal);
        if (attemptSignal.aborted) throw videoBridgeAbortError();
        const shouldLoadVideoBytes =
          Boolean(selectedModel) &&
          (Boolean(cache) || (part.ref.startsWith("https://") && !this.deps.describePart));
        const videoBytes = shouldLoadVideoBytes
          ? part.ref.startsWith("https://")
            ? await runVideoDownloadSingleflight(
                buildVideoDownloadFlightKey(
                  part,
                  context,
                  VIDEO_BRIDGE_MAX_BYTES,
                  runtime.timeoutMs
                ),
                attemptSignal,
                (downloadSignal) =>
                  loadVideoPartBytes(
                    part,
                    VIDEO_BRIDGE_MAX_BYTES,
                    runtime.timeoutMs,
                    downloadSignal,
                    { fetchRemote: this.deps.fetchRemote }
                  )
              )
            : await loadVideoPartBytes(
                part,
                VIDEO_BRIDGE_MAX_BYTES,
                runtime.timeoutMs,
                attemptSignal,
                { fetchRemote: this.deps.fetchRemote }
              )
          : null;
        const contentFingerprint =
          cache && videoBytes
            ? `sha256:${createHash("sha256").update(videoBytes).digest("hex")}`
            : part.ref;
        const resultCacheIdentity =
          cache && selectedModel
            ? createVideoResultCacheIdentity(runtime, visionRuntime, selectedModel, analysis)
            : null;
        const resultCacheKey = resultCacheIdentity
          ? buildVideoResultCacheKey(contentFingerprint, resultCacheIdentity, part)
          : null;
        const cachedResult = resultCacheKey
          ? safeGetCacheEntry(cache, resultCacheKey, context.log)
          : null;
        if (cachedResult && isVideoResultCacheEntry(cachedResult)) {
          const meta = cachedResult.metadata;
          const matchPolicy =
            resultCacheIdentity && matchesVideoResultCacheIdentity(meta, resultCacheIdentity);
          if (matchPolicy) {
            const elapsed = Date.now() - attemptStartedAt;
            descriptions.push(cachedResult.value);
            totalFramesRequested += meta.framesRequested;
            totalFramesExtracted += meta.framesExtracted;
            totalFramesUsed += meta.framesUsed;
            totalDedupDropped += meta.dedupDropped ?? 0;
            if (
              typeof meta.focusStartSeconds === "number" ||
              typeof meta.focusEndSeconds === "number"
            ) {
              focusWindowsApplied += 1;
            }
            if (analysis.analysisMode === "focused") focusHintsApplied += 1;
            totalDurationSeconds += meta.durationSeconds;
            totalSamplingCandidateCount += meta.samplingCandidateCount ?? 0;
            transcriptCuesApplied += meta.transcriptCuesApplied ?? 0;
            if (meta.contactSheetUsed) contactSheetsUsed += 1;
            recordFusionTelemetry(meta.fusion);
            if (meta.samplingPolicyEffective && meta.samplingPolicyEffective !== "uniform") {
              samplingPolicyEffective = meta.samplingPolicyEffective;
            }
            if (cachedResult.producerModel) {
              successfulModels.add(cachedResult.producerModel);
            }
            if (meta.modelUsed) {
              successfulModels.add(meta.modelUsed);
            }
            recordBridgeUse("video", {
              fusionRun: Boolean(meta.fusion),
              fusionPartial: meta.fusion?.partial ?? false,
              latencyMs: elapsed,
              resultCacheHit: true,
              resultCacheBytes: meta.cacheBytes,
              resultCacheLatencyMs: elapsed,
            });
            continue;
          }
          safeDeleteCacheEntry(cache, resultCacheKey, context.log);
        } else if (cachedResult) {
          safeDeleteCacheEntry(cache, resultCacheKey, context.log);
        }
        const describeAndCache = async (processingSignal: AbortSignal) => {
          const described = this.deps.describePart
            ? await this.deps.describePart(part, analysis)
            : await this.describeWithVisionModel(
                part,
                runtime,
                visionRuntime,
                selectedModel,
                analysis,
                processingSignal,
                videoBytes ?? undefined
              );
          if (processingSignal.aborted) throw videoBridgeAbortError();
          const resultCacheBytes = Buffer.byteLength(described.description, "utf8");
          if (resultCacheKey && resultCacheIdentity) {
            safeSetCacheEntry(
              cache,
              resultCacheKey,
              {
                value: described.description,
                producerModel: described.modelUsed ?? resultCacheIdentity.model,
                metadata: {
                  ...resultCacheIdentity,
                  durationSeconds: described.durationSeconds,
                  framesRequested: described.framesRequested,
                  framesExtracted: described.framesExtracted ?? described.framesUsed,
                  framesUsed: described.framesUsed,
                  dedupDropped: described.dedupDropped ?? 0,
                  focusEndSeconds: described.focusWindow?.endSeconds,
                  focusStartSeconds: described.focusWindow?.startSeconds,
                  cacheBytes: resultCacheBytes,
                  modelUsed: described.modelUsed ?? resultCacheIdentity.model,
                  samplingCandidateCount: described.sampling?.candidateCount ?? 0,
                  samplingPolicyEffective: described.sampling?.policyEffective ?? "uniform",
                  samplingPolicyRequested:
                    described.sampling?.policyRequested ?? runtime.samplingPolicy,
                  transcriptCuesApplied: described.transcriptCues?.length ?? 0,
                  contactSheetUsed: described.contactSheetUsed ?? false,
                  ...(described.fusion ? { fusion: described.fusion } : {}),
                },
              },
              context.log
            );
          }
          return described;
        };
        const resolved =
          resultCacheKey && selectedModel
            ? await runVideoResultSingleflight(resultCacheKey, attemptSignal, describeAndCache)
            : { coalesced: false, value: await describeAndCache(attemptSignal) };
        const described = resolved.value;
        if (described.modelUsed) successfulModels.add(described.modelUsed);
        const videoCacheHits = described.cacheHits ?? 0;
        const processingLatencyMs = Date.now() - attemptStartedAt;
        descriptions.push(described.description);
        totalFramesRequested += described.framesRequested;
        totalFramesExtracted += described.framesExtracted ?? described.framesUsed;
        totalFramesUsed += described.framesUsed;
        totalDedupDropped += described.dedupDropped ?? 0;
        if (described.focusWindow) focusWindowsApplied += 1;
        if (analysis.analysisMode === "focused") focusHintsApplied += 1;
        transcriptCuesApplied += described.transcriptCues?.length ?? 0;
        if (described.contactSheetUsed) contactSheetsUsed += 1;
        recordFusionTelemetry(described.fusion);
        totalDurationSeconds += described.durationSeconds;
        totalSamplingCandidateCount += described.sampling?.candidateCount ?? 0;
        if (
          described.sampling?.policyEffective &&
          described.sampling.policyEffective !== "uniform"
        ) {
          samplingPolicyEffective = described.sampling.policyEffective;
        }
        totalCacheHits += videoCacheHits;
        if (resultCacheKey && selectedModel) {
          recordBridgeUse("video", {
            cacheHits: videoCacheHits,
            fusionRun: Boolean(described.fusion),
            fusionPartial: described.fusion?.partial ?? false,
            latencyMs: processingLatencyMs,
            resultSingleflightCoalesced: resolved.coalesced,
          });
        } else {
          recordBridgeUse("video", {
            cacheHits: videoCacheHits,
            fusionRun: Boolean(described.fusion),
            fusionPartial: described.fusion?.partial ?? false,
            latencyMs: processingLatencyMs,
          });
        }
      } catch (error) {
        if (context.signal?.aborted) throw new Error("Video Bridge processing was aborted");
        failures += 1;
        recordBridgeUse("video", {
          failure: true,
          latencyMs: Date.now() - attemptStartedAt,
        });
        context.log?.warn?.(
          "VIDEO_BRIDGE",
          "Video description failed; applying the capability-safe fallback",
          {
            failureCode:
              error && typeof error === "object" && "code" in error && error.code === "ENOENT"
                ? "RUNTIME_UNAVAILABLE"
                : "DESCRIPTION_FAILED",
            videoIndex: index + 1,
          }
        );
        descriptions.push(
          capabilities.supportsVideo === false
            ? `[Video ${index + 1}]: (unavailable — video could not be described)`
            : null
        );
      } finally {
        clearTimeout(attemptTimeout);
      }
    }

    for (let index = attemptedParts.length; index < parts.length; index++) {
      descriptions.push(
        capabilities.supportsVideo === false
          ? `[Video ${index + 1}]: (not processed because the per-request video limit was reached)`
          : null
      );
    }

    const videosProcessed = attemptedParts.length - failures;
    const videosReplaced = descriptions.filter((description) => description !== null).length;
    if (videosReplaced === 0) return { block: false };

    return {
      block: false,
      modifiedPayload: replaceVideoParts(body, parts, descriptions),
      meta: {
        analysisMode: analysis.analysisMode,
        analysisModeRequested: analysis.requestedAnalysisMode,
        cacheHits: totalCacheHits,
        durationSeconds: totalDurationSeconds,
        failures,
        framesExtracted: totalFramesExtracted,
        framesRequested: totalFramesRequested,
        framesUsed: totalFramesUsed,
        dedupDropped: totalDedupDropped,
        focusWindowsApplied,
        focusHintsApplied,
        transcriptCuesApplied,
        contactSheetsUsed,
        audioFusionRuns,
        audioFusionPartials,
        audioFusionFailureCodes: [...audioFusionFailureCodes].sort(),
        samplingCandidateCount: totalSamplingCandidateCount,
        samplingPolicyEffective,
        samplingPolicyRequested: runtime.samplingPolicy,
        processingTimeMs: Date.now() - startedAt,
        attempts: attemptedParts.length,
        videoModel: combineModelIdentities(successfulModels, routingPlanModel),
        videosProcessed,
        videosReplaced,
      },
    };
  }

  private async describeWithVisionModel(
    part: VideoPart,
    runtime: ReturnType<typeof resolveVideoBridgeRuntimeSettings>,
    visionRuntime: ReturnType<typeof resolveVisionBridgeRuntimeSettings>,
    selectedModel: string | null,
    analysis: VideoAnalysisContext,
    signal?: AbortSignal,
    preloadedBytes?: Uint8Array
  ): Promise<DescribedVideo> {
    if (!selectedModel) {
      throw new Error("No vision-capable provider connected for Video Bridge");
    }
    const cache = runtime.cacheEnabled ? getSharedBridgeCacheFor(runtime) : null;
    const callVisionModel = this.deps.callVisionModel ?? defaultCallVisionModel;
    let cacheHits = 0;
    const successfulModels = new Set<string>();
    const described = await defaultDescribeVideoPart(
      part,
      {
        analysisMode: analysis.analysisMode,
        frameCount: runtime.frameCount,
        samplingPolicy: runtime.samplingPolicy,
        focusWindow: part.focusWindow,
        signal,
        timeoutMs: runtime.timeoutMs,
      },
      async (frameDataUri, timestampSeconds, signal) => {
        const prompt = composeVideoFramePrompt(
          visionRuntime.prompt,
          timestampSeconds,
          analysis.focusHint
        );
        const key = cache
          ? bridgeCacheKey(frameDataUri, `${prompt}@${timestampSeconds.toFixed(3)}`, selectedModel)
          : null;
        const cached = key && cache ? cache.getEntry(key) : undefined;
        if (cached) {
          cacheHits += 1;
          successfulModels.add(cached.producerModel ?? selectedModel);
          return cached.value;
        }
        let producerModel = selectedModel;
        const caption = await callVisionModel(frameDataUri, {
          maxImages: 1,
          model: selectedModel,
          onModelUsed: (model) => {
            producerModel = model;
          },
          prompt,
          routeThroughOmniRoute: true,
          signal,
          timeoutMs: runtime.timeoutMs,
          fetchImpl: undiciFetch as unknown as typeof fetch,
        });
        successfulModels.add(producerModel);
        if (key && cache) cache.setEntry(key, { value: caption, producerModel });
        return caption;
      },
      {
        extractFrames: this.deps.extractFrames,
        fetchRemote: this.deps.fetchRemote,
      },
      preloadedBytes
    );
    return {
      ...described,
      cacheHits,
      modelUsed: combineModelIdentities(successfulModels, selectedModel),
    };
  }
}
