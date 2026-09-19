"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Card, ModelSelectField, Toggle } from "@/shared/components";
import type { ApiModel } from "@/shared/components/ModelSelectField";
import {
  MODALITY_BRIDGE_DEFAULTS,
  VIDEO_BRIDGE_TIMEOUT_MAX_MS,
  VIDEO_BRIDGE_TIMEOUT_MIN_MS,
  resolveVideoBridgeRuntimeSettings,
  type VideoAnalysisMode,
  type VideoSamplingPolicy,
} from "@/shared/constants/modalityBridgeDefaults";

import ModalityBridgeStatsRow from "./ModalityBridgeStatsRow";

interface VideoState {
  modalityBridgeVideoEnabled: boolean;
  modalityBridgeVideoAnalysisMode: VideoAnalysisMode;
  modalityBridgeVideoModel: string;
  modalityBridgeVideoFrameCount: number;
  modalityBridgeVideoSamplingPolicy: VideoSamplingPolicy;
  modalityBridgeVideoMaxVideos: number;
  modalityBridgeVideoTimeout: number;
}

interface RuntimeStatus {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  reason?: string;
  restricted?: boolean;
}

interface ModalityBridgeVideoTabProps {
  runtimeHostname?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function fromApi(value: unknown): VideoState {
  const runtime = resolveVideoBridgeRuntimeSettings(asRecord(value));
  return {
    modalityBridgeVideoEnabled: runtime.enabled,
    modalityBridgeVideoAnalysisMode: runtime.analysisMode,
    modalityBridgeVideoModel: runtime.model,
    modalityBridgeVideoFrameCount: runtime.frameCount,
    modalityBridgeVideoSamplingPolicy: runtime.samplingPolicy,
    modalityBridgeVideoMaxVideos: runtime.maxVideos,
    modalityBridgeVideoTimeout: runtime.timeoutMs,
  };
}

function parseRuntimeStatus(value: unknown): RuntimeStatus | null {
  const record = asRecord(value);
  if (record.restricted === true) {
    return {
      available: false,
      ffmpegVersion: null,
      ffprobeVersion: null,
      restricted: true,
    };
  }
  if (typeof record.available !== "boolean") return null;
  return {
    available: record.available,
    ffmpegVersion: typeof record.ffmpegVersion === "string" ? record.ffmpegVersion : null,
    ffprobeVersion: typeof record.ffprobeVersion === "string" ? record.ffprobeVersion : null,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

function isLoopbackDashboardHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function clampNumber(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

export default function ModalityBridgeVideoTab({
  runtimeHostname,
}: ModalityBridgeVideoTabProps = {}) {
  const t = useTranslations("settings");
  const tRoot = useTranslations();
  const [settings, setSettings] = useState<VideoState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [errorState, setErrorState] = useState<"load" | "save" | null>(null);
  const persistedSettings = useRef<VideoState | null>(null);
  const isVisionModel = useCallback((model: ApiModel) => model.supportsVision === true, []);

  useEffect(() => {
    let cancelled = false;
    const hostname = runtimeHostname ?? window.location.hostname;
    const runtimeStatusRequest = isLoopbackDashboardHost(hostname)
      ? fetch("/api/modality-bridge/video/runtime")
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      : Promise.resolve({ restricted: true });
    void Promise.all([
      fetch("/api/settings").then((response) => {
        if (!response.ok) throw new Error("settings load failed");
        return response.json();
      }),
      runtimeStatusRequest,
    ])
      .then(([settingsValue, runtimeValue]: [unknown, unknown]) => {
        if (cancelled) return;
        const loadedSettings = fromApi(settingsValue);
        persistedSettings.current = loadedSettings;
        setSettings(loadedSettings);
        setRuntime(parseRuntimeStatus(runtimeValue));
        setErrorState(null);
      })
      .catch(() => {
        if (!cancelled) setErrorState("load");
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeHostname]);

  const update = async (patch: Partial<VideoState>) => {
    setErrorState(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error("settings save failed");
      const saved = persistedSettings.current
        ? { ...persistedSettings.current, ...patch }
        : persistedSettings.current;
      persistedSettings.current = saved;
      setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
    } catch {
      setSettings(persistedSettings.current);
      setErrorState("save");
    }
  };

  if (errorState === "load") {
    return <div role="alert">{tRoot("publicSystem.error.title")}</div>;
  }
  if (!settings) return null;

  const setLocal = (patch: Partial<VideoState>) => {
    setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
  };
  const commitNumber = (
    key:
      | "modalityBridgeVideoFrameCount"
      | "modalityBridgeVideoMaxVideos"
      | "modalityBridgeVideoTimeout",
    raw: string,
    min: number,
    max: number,
    fallback: number
  ) => {
    const value = clampNumber(raw, min, max, fallback);
    setLocal({ [key]: value });
    void update({ [key]: value });
  };

  return (
    <Card
      title={t("modalityBridgeVideoTitle")}
      subtitle={t("modalityBridgeVideoDesc")}
      icon="movie"
    >
      <div className="space-y-4">
        {errorState === "save" ? (
          <div
            role="alert"
            className="rounded-control border border-danger/30 p-3 text-sm text-danger"
          >
            {t("modalityBridgeTestError", { message: tRoot("common.error") })}
          </div>
        ) : null}
        <div
          className={`rounded-control border p-3 text-sm ${
            runtime?.available
              ? "border-success/30 bg-success/5 text-success"
              : "border-warning/30 bg-warning/5 text-text-muted"
          }`}
          aria-live="polite"
        >
          {runtime?.available ? (
            <>
              <strong>{t("modalityBridgeVideoRuntimeReady")}</strong>
              <div className="mt-1 text-xs">
                FFmpeg {runtime.ffmpegVersion} · ffprobe {runtime.ffprobeVersion}
              </div>
            </>
          ) : runtime?.restricted ? (
            <>
              <strong>{t("authz.badge.strict")}</strong>
              <div className="mt-1 text-xs">{tRoot("endpoint.badgeLoopbackTooltip")}</div>
            </>
          ) : (
            <>
              <strong>{t("modalityBridgeVideoRuntimeUnavailable")}</strong>
              <div className="mt-1 text-xs">
                {runtime?.reason || t("modalityBridgeVideoRuntimeInstall")}
              </div>
            </>
          )}
        </div>

        <Toggle
          checked={settings.modalityBridgeVideoEnabled}
          onChange={(checked) => void update({ modalityBridgeVideoEnabled: checked })}
          label={t("modalityBridgeVideoEnabled")}
          description={t("modalityBridgeVideoEnabledDesc")}
        />

        <label className="block text-sm font-medium">
          {t("modalityBridgeMode")}
          <select
            data-testid="modality-bridge-video-analysis-mode"
            aria-describedby="modality-bridge-video-analysis-mode-description"
            value={settings.modalityBridgeVideoAnalysisMode}
            onChange={(event) =>
              void update({
                modalityBridgeVideoAnalysisMode: event.currentTarget.value as VideoAnalysisMode,
              })
            }
            className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="full">{tRoot("health.degradationFull")}</option>
            <option value="focused">{t("modalityBridgeTaskAware")}</option>
          </select>
          <span
            id="modality-bridge-video-analysis-mode-description"
            className="mt-1 block text-xs font-normal text-text-muted"
          >
            {settings.modalityBridgeVideoAnalysisMode === "focused"
              ? t("modalityBridgeTaskAwareDesc")
              : t("modalityBridgeVideoDesc")}
          </span>
        </label>

        <ModelSelectField
          label={t("modalityBridgeVideoModel")}
          value={settings.modalityBridgeVideoModel}
          placeholder={t("modalityBridgeVideoModelInherited")}
          allowEmpty
          modelFilter={isVisionModel}
          onChange={(value) => void update({ modalityBridgeVideoModel: value })}
          className="text-sm"
        />

        <details className="rounded-control border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t("modalityBridgeAdvanced")}
          </summary>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <NumberField
              testId="modality-bridge-video-frame-count"
              label={t("modalityBridgeVideoFrameCount")}
              min={1}
              max={16}
              value={settings.modalityBridgeVideoFrameCount}
              onChange={(value) => setLocal({ modalityBridgeVideoFrameCount: value })}
              onBlur={(raw) =>
                commitNumber(
                  "modalityBridgeVideoFrameCount",
                  raw,
                  1,
                  16,
                  MODALITY_BRIDGE_DEFAULTS.videoFrameCount
                )
              }
            />
            <NumberField
              testId="modality-bridge-video-max-videos"
              label={t("modalityBridgeVideoMaxVideos")}
              min={1}
              max={4}
              value={settings.modalityBridgeVideoMaxVideos}
              onChange={(value) => setLocal({ modalityBridgeVideoMaxVideos: value })}
              onBlur={(raw) =>
                commitNumber(
                  "modalityBridgeVideoMaxVideos",
                  raw,
                  1,
                  4,
                  MODALITY_BRIDGE_DEFAULTS.videoMaxVideos
                )
              }
            />
            <NumberField
              testId="modality-bridge-video-timeout"
              label={t("modalityBridgeTimeoutMs")}
              min={VIDEO_BRIDGE_TIMEOUT_MIN_MS}
              max={VIDEO_BRIDGE_TIMEOUT_MAX_MS}
              value={settings.modalityBridgeVideoTimeout}
              onChange={(value) => setLocal({ modalityBridgeVideoTimeout: value })}
              onBlur={(raw) =>
                commitNumber(
                  "modalityBridgeVideoTimeout",
                  raw,
                  VIDEO_BRIDGE_TIMEOUT_MIN_MS,
                  VIDEO_BRIDGE_TIMEOUT_MAX_MS,
                  MODALITY_BRIDGE_DEFAULTS.videoTimeoutMs
                )
              }
            />
            <label className="block text-sm font-medium">
              {t("modalityBridgeAdvanced")}
              <select
                aria-label={t("modalityBridgeAdvanced")}
                value={settings.modalityBridgeVideoSamplingPolicy}
                onChange={(event) =>
                  void update({
                    modalityBridgeVideoSamplingPolicy: event.currentTarget
                      .value as VideoSamplingPolicy,
                  })
                }
                className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="uniform">uniform</option>
                <option value="scene_aware">scene_aware</option>
                <option value="segment_aware">segment_aware</option>
              </select>
            </label>
          </div>
        </details>

        <ModalityBridgeStatsRow kind="video" />
      </div>
    </Card>
  );
}

interface NumberFieldProps {
  testId: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  onBlur: (raw: string) => void;
}

function NumberField({ testId, label, min, max, value, onChange, onBlur }: NumberFieldProps) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <input
        type="number"
        data-testid={testId}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number.parseInt(event.currentTarget.value, 10) || 0)}
        onBlur={(event) => onBlur(event.currentTarget.value)}
        className="mt-1 w-full rounded-control border border-border bg-surface px-3 py-2 text-sm"
      />
    </label>
  );
}
